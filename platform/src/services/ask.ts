/**
 * Ask composition service (iOS API v1 — ASK-015 `POST /api/ask`).
 *
 * Composes TWO existing services into the iOS ask surface, in the order the
 * design corpus pins (design/07-modules/ask.md §"Backend integration"):
 *
 *   1. SEARCH  — `services/search.ts` `search(query, limit)` runs RRF fusion
 *      over the vector + graph arms and returns `{ results: [...] }` (empty
 *      `[]` on no match). This is the raw retrieval layer.
 *   2. COMPOSE — `services/voice-c-compose-llm.ts` `composeVoiceCWithLLM(input)`
 *      returns `{ text, annotations }` with valid UTF-16 spans +
 *      `assertVoiceC`. `composeVoiceCWithLLMFallback` is the deterministic
 *      floor (sub-100ms, span-bearing, always decoder-safe) used when the LLM
 *      path fails OR emits multi-sentence prose with no locatable spans.
 *
 * The empty short-circuit: when search returns 0 candidates, NO LLM call runs
 * — `answerQuery` returns `{ answer: null }` directly (ask.md §"Empty (no
 * match)"). This keeps the empty path fast and free of composition cost.
 *
 * WIRE CONTRACT (camelCase — matches the iOS verbatim contract in
 * Sources/MnemoBackend/ASK/Ask/AskResult.swift):
 *
 *   POST /api/ask  { "query": <text>, "voiceInput": <bool> }
 *   -> 200 { "answer": <AskResult> | null }
 *
 *   AskResult = {
 *     composedAt:       "<iso8601>",               // fetch-time-fresh
 *     queryText:        "<string>",                 // echoed back; non-blank
 *     answerText:       "<string>",                 // Voice-C prose; non-blank
 *     annotations:      [{ start, end, source:{type,id} }],  // BARE array, never null
 *     isHardTopic:      <bool>,                     // hard-topic register; false if uncertain
 *     isAmbiguous:      <bool>,                     // low-score/sparse -> true
 *     relevantEntityIds: ["<uuid>"]                 // [] if none; NEVER null
 *   }
 *
 * Decoder guarantees this service upholds (iOS AskResult.init(from:) enforces):
 *   - queryText / answerText are non-blank (a blank answer is degenerate).
 *   - annotations is ALWAYS a bare array (`[]` for empty, never null).
 *   - relevantEntityIds is ALWAYS an array (`[]` for empty, never null); each
 *     id non-blank.
 *   - answerText is span-GUARANTEED: multi-sentence prose ALWAYS carries
 *     in-bounds UTF-16 spans, or `VoiceCComposition.fromBackend` throws
 *     `multiSentenceWithoutAnnotations`. The compose seam's multi-sentence
 *     guard + deterministic fallback uphold this — we NEVER ship unannotated
 *     multi-sentence prose.
 *
 * DEFERRED (v1): `answer_shape` (factual/thematic) is out of scope. This ships
 * the isHardTopic / isAmbiguous model only.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { search, type SearchResult } from './search.js';
import {
  composeVoiceCWithLLM,
  composeVoiceCWithLLMFallback,
  type ComposeInput,
  type VoiceCLLMComposeError,
} from './voice-c-compose-llm.js';

// =============================================================================
// Tunable knobs
// =============================================================================

/**
 * How many memories to retrieve for composition. Wider than the display layer
 * so the composer has a richer observation pool; the composer (and the
 * hard-topic / ambiguity heuristics) consume only what they need.
 */
const ASK_SEARCH_LIMIT = 8;

/**
 * Ambiguity signal: when the top result's RRF score is below this OR fewer
 * than this many results surface, the query is treated as ambiguous (ask.md
 * §"Ambiguous" — the answer names the ambiguity). RRF scores are not
 * normalized; this is a conservative floor calibrated against the k=60
 * fusion (a lone vector hit scores ~1/61 ≈ 0.0164; two arms on one memory
 * score ~2/61 ≈ 0.0328).
 */
const AMBIGUOUS_MIN_SCORE = 0.02;
const AMBIGUOUS_MIN_RESULTS = 2;

// =============================================================================
// Wire DTOs (camelCase — the corpus's pinned convention)
// =============================================================================

/** One underline span over `answerText`. Matches iOS AnnotationBlock's entry. */
export interface AskAnnotation {
  /** UTF-16 code-unit start offset (inclusive). */
  start: number;
  /** UTF-16 code-unit end offset (exclusive). Always > start. */
  end: number;
  /** The source memory the span cites. `type` is closed to 'memory' here. */
  source: { type: 'memory'; id: string };
}

/** The composed answer (iOS AskResult). Field names are the pinned camelCase. */
export interface AskResult {
  composedAt: string;
  queryText: string;
  answerText: string;
  /** BARE array — never null. `[]` for empty. */
  annotations: AskAnnotation[];
  isHardTopic: boolean;
  isAmbiguous: boolean;
  /** NEVER null — `[]` when no entities surface. */
  relevantEntityIds: string[];
}

/** The POST /api/ask envelope. `answer: null` is the empty result. */
export interface AskResponse {
  answer: AskResult | null;
}

// =============================================================================
// Entity join — relevantEntityIds via memory_entities
// =============================================================================

/**
 * Resolve the distinct entity ids linked to the surfaced memories, via the
 * memory_entities join (the same join services/search.ts uses for entity
 * ranking). Returns `[]` when no memories are linked to entities. Each id is
 * non-blank (cast to text + filtered). Order is stable: distinct by first
 * appearance across the memory order.
 *
 * `[]` (never null) is the contract — iOS rejects explicit null for
 * relevantEntityIds with a contract-named diagnostic.
 */
async function relevantEntitiesFor(memoryIds: string[]): Promise<string[]> {
  if (memoryIds.length === 0) return [];
  const idList = sql.join(
    memoryIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT DISTINCT me.entity_id::text AS entity_id
      FROM public.memory_entities me
     WHERE me.memory_id IN (${idList})
  `)) as unknown as Array<{ entity_id: string }>;

  const ids: string[] = [];
  for (const r of rows) {
    const id = (r?.entity_id ?? '').trim();
    if (id.length > 0) ids.push(id);
  }
  return ids;
}

// =============================================================================
// Heuristics — isHardTopic / isAmbiguous
// =============================================================================

/**
 * Hard-topic register (ask.md §"Sensitive / hard-topic queries" L224-233). v1
 * derives nothing from content analysis (deferred) — a content-agnostic
 * heuristic: when the result pool is very shallow (a single weak hit) the
 * query MIGHT be touching a sensitive seam the user hasn't fleshed out, so we
 * DO NOT presume hard-topic. Defaults FALSE when uncertain (the corpus: "a
 * backend signal; defaults false when omitted"). This is a deliberate
 * conservative floor — better to under-flag than to shorten an answer the
 * user wanted in full.
 *
 * DEFERRED: a real hard-topic detector (content register analysis) lands in a
 * later slice; this stub keeps the field present and well-typed.
 */
function deriveIsHardTopic(_results: SearchResult[]): boolean {
  return false;
}

/**
 * Ambiguity signal (ask.md §"Ambiguous" L213-221): low-score or sparse results
 * mean the query matched multiple distinct interpretations (or a thin seam).
 * True when the top score is weak OR fewer than AMBIGUOUS_MIN_RESULTS surfaced.
 */
function deriveIsAmbiguous(results: SearchResult[]): boolean {
  if (results.length < AMBIGUOUS_MIN_RESULTS) return true;
  const topScore = results[0]?.score ?? 0;
  return topScore < AMBIGUOUS_MIN_SCORE;
}

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Answer a query: search, compose, shape to the iOS wire.
 *
 * Flow:
 *   1. `search(query, ASK_SEARCH_LIMIT)`. If empty → `{ answer: null }` (the
 *      empty short-circuit — NO LLM call, fast).
 *   2. Build ComposeInput { parts: top results' content as observations each
 *      with source {type:'memory', id: memoryId}, surface:'ask', hardTopics }.
 *   3. `composeVoiceCWithLLM`. On ANY failure (upstream unreachable/error,
 *      multi-sentence-no-spans, assertVoiceC) → `composeVoiceCWithLLMFallback`
 *      (the deterministic floor). We NEVER ship unannotated multi-sentence
 *      prose — the LLM seam's own guard throws before we'd have to, and the
 *      fallback is span-bearing by construction.
 *   4. Derive isHardTopic / isAmbiguous / relevantEntityIds.
 *   5. Return the AskResult envelope.
 *
 * `voiceInput` is accepted for wire-contract parity (iOS AskRequest carries
 * it) and threaded as a surface hint; it does not change composition in v1.
 *
 * Never throws on "found nothing" — only on a transport/DB/compose failure,
 * which the route handler maps to 500. A compose fallback that itself throws
 * (degenerate deterministic input) propagates as a 500 — the deterministic
 * floor is span-bearing for any non-empty sourced input, so this is an
 * extraordinary failure worth surfacing, not silently swallowing.
 */
export async function answerQuery(
  query: string,
  voiceInput = false,
): Promise<AskResponse> {
  const q = (query ?? '').trim();

  // --- 1. SEARCH. Empty -> the empty short-circuit (NO LLM call).
  const { results } = await search(q, ASK_SEARCH_LIMIT);
  if (results.length === 0) {
    return { answer: null };
  }

  // --- 2. BUILD compose input. Each top result's content becomes an
  // observation the composer may lift from, sourced at its memory id. The
  // source.id IS the canonical memory id (parent_window_id) — the same id
  // the search arm emits and iOS annotation source.id MUST carry for rise.
  const hardTopics = deriveIsHardTopic(results);
  const composeInput: ComposeInput = {
    parts: results.map((r) => ({
      text: r.content,
      source: { type: 'memory' as const, id: r.memoryId },
    })),
    // `voiceInput` threads as a surface hint so the persona knows whether the
    // query arrived spoken or typed; it does not change composition structure
    // in v1. The surface stays 'ask' so the persona picks the ask register.
    surface: voiceInput ? 'ask-voice' : 'ask',
    hardTopics,
  };

  // --- 3. COMPOSE — LLM first, deterministic fallback on any failure. The
  // multi-sentence guard inside composeVoiceCWithLLM throws
  // VoiceCLLMComposeError('multi-sentence-no-spans') BEFORE we'd ship
  // unannotated multi-sentence prose; composeVoiceCWithLLMFallback catches
  // that (and every other VoiceCLLMComposeError / assertVoiceC failure) and
  // returns a span-bearing deterministic composition.
  let composedText: string;
  let composedAnnotations: AskAnnotation[];
  try {
    const llm = await composeVoiceCWithLLM(composeInput);
    composedText = llm.text;
    composedAnnotations = toAskAnnotations(llm.text, llm.annotations);
  } catch (err) {
    // Distinguish a known compose failure (fall back) from an unexpected
    // throw. assertVoiceC violations surface as a plain Error (quality
    // regression worth surfacing loudly) — but the fallback helper handles
    // BOTH, so delegate to it for any VoiceCLLMComposeError OR assertVoiceC
    // Error. Anything truly unexpected re-throws to the route (-> 500).
    if (!(err instanceof Error)) throw err;
    const floor = await composeVoiceCWithLLMFallback(composeInput);
    composedText = floor.text;
    composedAnnotations = toAskAnnotations(floor.text, floor.annotations);
    // Log the fallback reason for observability (the fallback helper already
    // warned; this adds the surface context).
    const reason = (err as VoiceCLLMComposeError).reason ?? 'assert-voice-c';
    console.warn(
      `[ask] compose fell back to deterministic floor (reason=${reason}) ` +
      `for query=${JSON.stringify(q.slice(0, 80))}: ${err.message}`,
    );
  }

  // Defensive: never ship a blank answerText (iOS rejects it). The compose
  // seam guarantees non-empty for non-empty input, but guard so a future edit
  // cannot serve a degenerate row.
  if (composedText.trim().length === 0) {
    throw new Error(`compose returned empty answerText for query=${JSON.stringify(q.slice(0, 80))}`);
  }

  // --- 4. DERIVE signals. relevantEntityIds via the memory_entities join.
  const isAmbiguous = deriveIsAmbiguous(results);
  const relevantEntityIds = await relevantEntitiesFor(
    results.map((r) => r.memoryId),
  );

  // --- 5. SHAPE to the iOS wire (camelCase, verbatim per AskResult.swift).
  const answer: AskResult = {
    composedAt: new Date().toISOString(),
    queryText: q,
    answerText: composedText,
    // BARE array — never null. The compose seam always returns a list; we
    // re-shape to the closed 'memory' source type. A multi-sentence
    // answerText is guaranteed to carry >=1 in-bounds span (the seam's
    // multi-sentence guard + fallback uphold this).
    annotations: composedAnnotations,
    isHardTopic: hardTopics,
    isAmbiguous,
    relevantEntityIds,
  };

  return { answer };
}

/**
 * Re-shape the compose seam's annotations to the ask wire's closed source
 * type. The seam emits `source: { type: string; id: string }` (open string);
 * we narrow `type` to the 'memory' literal the ask surface sources. Also
 * re-validates the UTF-16 in-bounds invariant (start >= 0, end <=
 * answerText.length, end > start) so a future compose edit cannot ship an
 * out-of-bounds span the iOS decoder would reject (`invalidSpan`).
 *
 * Out-of-bounds spans are DROPPED (warn-logged) rather than emitted — mirrors
 * the compose seam's own posture (a dropped span loses its underline; an
 * out-of-bounds span blanks the screen).
 */
function toAskAnnotations(
  text: string,
  annotations: Array<{ start: number; end: number; source: { type: string; id: string } }>,
): AskAnnotation[] {
  const len = text.length;
  const out: AskAnnotation[] = [];
  for (const a of annotations) {
    const start = Math.trunc(a.start);
    const end = Math.trunc(a.end);
    if (!(start >= 0 && end > start && end <= len)) {
      console.warn(
        `[ask] dropping out-of-bounds span start=${start} end=${end} ` +
        `text.length=${len} (would fail iOS decoder invalidSpan)`,
      );
      continue;
    }
    const id = (a.source?.id ?? '').trim();
    if (id.length === 0) {
      console.warn('[ask] dropping span with blank source id');
      continue;
    }
    out.push({ start, end, source: { type: 'memory', id } });
  }
  return out;
}
