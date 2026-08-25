/**
 * Ask composition service (iOS API v1 — ASK-015 `POST /api/ask`).
 *
 * The user asks a question of their own past; this answers it.
 *
 * ## What changed in MNEMO-96o8 (and why)
 *
 * The first cut of this service composed an answer WITHOUT the question. It
 * ran hybrid search, handed the top 8 whole parent-window bodies to the shared
 * Voice-C surfacing persona, and returned whatever prose came back. The
 * persona's job on every other surface is to notice something and offer a
 * question — so with no question in the prompt, the "answer" was a Voice-C
 * summary of the eight memories nearest in vector space, every lifted phrase
 * underlined. It read as a page of links, because that is what it was.
 *
 * Three things now hold:
 *
 *   1. THE QUESTION IS THE SUBJECT. Composition goes through the ask register
 *      (`voice-c-ask-llm.ts` → ml-services `/voice-c-ask`), which receives the
 *      query, the conversation so far, and the retrieved excerpts, and whose
 *      first sentence answers what was asked.
 *
 *   2. EXCERPTS, NOT ENTRIES. Parts carry `SearchResult.excerpt` — the
 *      unit-grained passage that actually matched — plus the date it was
 *      written, so the answer can say "in february" truthfully. Whole windows
 *      buried the answer in surrounding prose.
 *
 *   3. THE POOL IS ALLOWED TO BE QUIET, and it is the COMPOSER that decides
 *      whether the passages answer the question — not a similarity threshold
 *      (the bands overlap on this embedding model; the measurements are at
 *      `ASK_ANSWER_MIN_SCORE`). It either answers, or reports `answered:false`
 *      and names the absence in the user's own voice. Retrieval keeps one cheap
 *      floor for degenerate indexes. Before this, `answer: null` required a
 *      literally empty result set — unreachable on a populated graph — so every
 *      question got a confident answer assembled from whatever was nearest,
 *      however unrelated. And there is no longer a deterministic prose
 *      fallback: a composition failure degrades to the quiet result too. An
 *      honest silence beats a wall of raw entries.
 *
 * Multi-turn: `turns` carries prior (query, answer) exchanges so a follow-up
 * resolves against the thread instead of being read as a fresh question.
 *
 * WIRE CONTRACT (camelCase — matches Sources/MnemoBackend/ASK/Ask/AskResult.swift):
 *
 *   POST /api/ask
 *     { "query": <text>, "voiceInput": <bool>,
 *       "turns": [{ "query": <text>, "answer": <text> }],   // optional
 *       "contextEntityIds": ["<uuid>"] }                     // optional
 *   -> 200 { "answer": <AskResult> | null }
 *
 *   AskResult = {
 *     composedAt:         "<iso8601>",
 *     queryText:          "<string>",                        // non-blank
 *     answerText:         "<string>",                        // non-blank
 *     annotations:        [{ start, end, source:{type,id} }], // BARE array, never null
 *     isHardTopic:        <bool>,
 *     isAmbiguous:        <bool>,
 *     relevantEntityIds:  ["<uuid>"],                         // [] never null
 *     scopedToEntityIds:  ["<uuid>"] | omitted                // honest scope echo
 *   }
 *
 * Decoder guarantees upheld here (iOS AskResult.init(from:) enforces):
 *   - queryText / answerText non-blank.
 *   - annotations ALWAYS a bare array (`[]` for empty, never null).
 *   - relevantEntityIds ALWAYS an array, each id non-blank, never null.
 *   - scopedToEntityIds emitted ONLY when a scope was actually applied — iOS
 *     renders the "within X" echo off its presence, so emitting it
 *     unconditionally would claim a scope the search never used.
 *
 * DEFERRED (v1): `answer_shape` (factual/thematic) stays server-side — the
 * compose prompt matches length to the question, per ask.md §"Two answer
 * shapes" ("not separate code paths").
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { search, type SearchResult } from './search.js';
import {
  composeAskWithLLM,
  AskLLMError,
  type AskComposeInput,
  type AskTurn,
} from './voice-c-ask-llm.js';

// =============================================================================
// Tunable knobs
// =============================================================================

/**
 * How many memories to retrieve. Wider than what reaches the composer: the
 * relevance gate below thins this pool, so retrieval over-fetches to give the
 * gate something to choose from.
 */
const ASK_SEARCH_LIMIT = 8;

/** Over-fetch multiplier when a gathered-context scope will filter the pool. */
const SCOPED_OVERFETCH = 4;

/**
 * How many excerpts reach the composer. The corpus caps explicit citations at
 * ~3 (ask.md §"Source citations": beyond that, sources surface through the
 * constellation's brightening rather than more underlines), and a composer
 * given five passages writes a tighter answer than one given eight.
 */
const ASK_COMPOSE_PARTS = 5;

/**
 * DEGENERATE-RETRIEVAL floor. A sanity check, NOT the relevance gate — and the
 * difference is measured, not assumed.
 *
 * Probing the live graph (2026-08-25, nomic-embed) over this service's own
 * search path:
 *
 *   0.633, 0.586, 0.551, 0.544, 0.583   <- "what have i been saying about dad?"
 *   0.580, 0.532, 0.529, 0.723, 0.584   <- "what did i say about the sabbatical?"
 *   0.553, 0.540, 0.518, 0.500, 0.495   <- "…quantum chromodynamics lattice gauge theory?"
 *   0.540, 0.529, 0.527, 0.523, 0.520   <- "zzzz qqqq xxxx vvvv"
 *
 * Literal gibberish scores 0.52–0.54; a question the graph genuinely answers
 * tops out at 0.63. The bands OVERLAP. No absolute cosine threshold separates
 * "about this" from "about nothing" on this model: set it high enough to reject
 * the gibberish row and it also rejects the relevant results sitting at 0.53.
 *
 * So this floor is deliberately BELOW the observed noise band. It catches only
 * genuinely degenerate retrieval — an empty or broken vector store — and the
 * real answerability judgement belongs to the composer, which sees the question
 * and the passages together and reports `answered: false` when they do not meet
 * (§4 below). Live, that is exactly what happens: the physics question comes
 * back with "nothing here about that at all", naming what IS there.
 *
 * The cost is honest and worth stating: an unanswerable question still spends a
 * composition call, because no cheap pre-filter exists on this embedding model.
 * If that cost ever matters, the discriminating signal in the data above is
 * RELATIVE, not absolute — the gap between the top hit and the pool's median
 * (~0.05 for the real questions, ~0.013 for gibberish) — which would be a
 * margin gate, not a threshold. Deliberately not built on four samples.
 *
 * Note this reads `vectorScore`, NOT `score`. RRF is rank-based: the top hit of
 * a hopeless query scores the same 1/(k+1) as the top hit of a perfect one,
 * which is why the pre-96o8 `AMBIGUOUS_MIN_SCORE = 0.02` heuristic could not
 * distinguish them either.
 */
const ASK_ANSWER_MIN_SCORE = envFloat('ASK_ANSWER_MIN_SCORE', 0.45);

/**
 * SUPPORTING floor for the corroborating excerpts that ride along with the top
 * one. Given the compressed band documented above, this admits essentially
 * everything retrieval returned, so the effective selection is "the top
 * `ASK_COMPOSE_PARTS` by similarity" — say so plainly rather than imply a
 * discrimination that is not happening. It earns its keep against a
 * graph-arm-only hit (`vectorScore === 0`), which it does exclude: an
 * entity-expansion neighbour whose text never matched the question is exactly
 * the "non-relevant post" this epic removes from the answer.
 */
const ASK_SUPPORT_MIN_SCORE = envFloat('ASK_SUPPORT_MIN_SCORE', 0.35);

/**
 * Ambiguity: several excerpts clear the answerable gate with near-equal
 * scores, i.e. the question matched multiple distinct things about equally
 * well (ask.md §"Ambiguous" — the answer names them rather than picking one).
 */
const AMBIGUOUS_MIN_CANDIDATES = 3;
const AMBIGUOUS_MAX_SPREAD = 0.06;

function envFloat(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

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
  /** Present ONLY when a gathered-context scope was actually applied. */
  scopedToEntityIds?: string[];
}

/** The POST /api/ask envelope. `answer: null` is the quiet / empty result. */
export interface AskResponse {
  answer: AskResult | null;
}

/** Options the route threads through: the conversation and the gathered scope. */
export interface AskOptions {
  /** Prior (query, answer) exchanges, oldest first. */
  turns?: AskTurn[];
  /** Entities the user gathered as context (iOS `contextEntityIds`). */
  contextEntityIds?: string[];
}

// =============================================================================
// Entity join — relevantEntityIds via memory_entities
// =============================================================================

/**
 * Resolve the distinct entity ids linked to the surfaced memories, via the
 * memory_entities join. Returns `[]` when none are linked. Each id is
 * non-blank. `[]` (never null) is the contract — iOS rejects explicit null for
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

/**
 * The memory ids linked to any of `entityIds` — the gathered-context scope
 * (MNEMO-6i04.12 / MNEMO-kew8; bridge.md L109 "it becomes part of the context
 * that scopes what you ask").
 *
 * Scoping is applied as a POST-FILTER over retrieval rather than as a
 * pre-filter inside the vector search: the ranking still comes from semantic
 * similarity to the question, and the scope only decides which of those
 * results the user allowed us to answer from. A pre-filter would return the
 * gathered entities' memories ranked by relevance to nothing in particular.
 */
async function memoryIdsForEntities(entityIds: string[]): Promise<Set<string>> {
  if (entityIds.length === 0) return new Set();
  const idList = sql.join(
    entityIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT DISTINCT me.memory_id::text AS memory_id
      FROM public.memory_entities me
     WHERE me.entity_id IN (${idList})
  `)) as unknown as Array<{ memory_id: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    const id = (r?.memory_id ?? '').trim();
    if (id.length > 0) out.add(id);
  }
  return out;
}

// =============================================================================
// Date prose
// =============================================================================

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
];

/**
 * Lowercase, unabbreviated date prose the composer can drop straight into an
 * answer — "monday the 5th of february" (`01-voice-and-tone.md`: dates
 * lowercase, never abbreviated; the corpus's own ask example reads "monday the
 * 5th"). The year is appended only when it is not the current one, so recent
 * entries read naturally and older ones stay unambiguous.
 *
 * Returns '' for an unparseable timestamp — the composer then simply writes an
 * answer without a date rather than one with a wrong date.
 */
export function dateProse(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const day = d.getUTCDate();
  const suffix =
    day % 10 === 1 && day !== 11 ? 'st'
    : day % 10 === 2 && day !== 12 ? 'nd'
    : day % 10 === 3 && day !== 13 ? 'rd'
    : 'th';
  const base = `${WEEKDAYS[d.getUTCDay()]} the ${day}${suffix} of ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? base
    : `${base}, ${d.getUTCFullYear()}`;
}

// =============================================================================
// Signals
// =============================================================================

/**
 * Hard-topic register (ask.md §"Sensitive / hard-topic queries"). Still a
 * conservative stub: content-register detection is its own piece of work, and
 * defaulting FALSE means an answer the user wanted in full is never silently
 * shortened. Kept as a function (not inlined `false`) so the detector has one
 * obvious home.
 */
function deriveIsHardTopic(_results: SearchResult[]): boolean {
  return false;
}

/**
 * Ambiguity: several excerpts clear the answerable gate with scores clustered
 * tightly enough that no single one is "the" match (ask.md §"Ambiguous").
 *
 * Replaces the pre-96o8 RRF-floor heuristic, which flagged ambiguous whenever
 * the top result came from a single arm — i.e. almost always — because it
 * compared a rank-derived constant against a threshold no rank could exceed.
 */
function deriveIsAmbiguous(strong: SearchResult[]): boolean {
  if (strong.length < AMBIGUOUS_MIN_CANDIDATES) return false;
  const top = strong[0]?.vectorScore ?? 0;
  const nth = strong[AMBIGUOUS_MIN_CANDIDATES - 1]?.vectorScore ?? 0;
  return top - nth <= AMBIGUOUS_MAX_SPREAD;
}

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Answer a query: search, gate, compose, shape to the iOS wire.
 *
 * Returns `{ answer: null }` — the quiet result — when the query is blank, when
 * retrieval finds nothing, when retrieval is degenerate, when a gathered scope
 * excludes everything relevant, or when composition fails. Every one of those is
 * "the pool has nothing to say to that", which is a true thing to render.
 *
 * Note what is NOT in that list: passages that came back but do not answer the
 * question. That case composes, and the composer's own honest-absence prose is
 * served (see step 4) — naming what IS there beats the canned empty copy.
 *
 * Throws only on a transport / DB failure, which the route maps to 500.
 */
export async function answerQuery(
  query: string,
  voiceInput = false,
  options: AskOptions = {},
): Promise<AskResponse> {
  const q = (query ?? '').trim();
  if (q.length === 0) return { answer: null };

  const contextEntityIds = (options.contextEntityIds ?? [])
    .map((id) => (id ?? '').trim())
    .filter((id) => id.length > 0);
  const scoped = contextEntityIds.length > 0;

  // --- 1. SEARCH. Over-fetch when a scope will thin the pool.
  const limit = scoped ? ASK_SEARCH_LIMIT * SCOPED_OVERFETCH : ASK_SEARCH_LIMIT;
  const { results } = await search(q, limit);
  if (results.length === 0) {
    // Logged, not silent: this was the ONE quiet path with no trace, and it
    // cost real diagnosis time — a quiet answer on screen with nothing in the
    // log is indistinguishable from a bug. Every early return here now says
    // which gate it was.
    console.info(
      `[ask] retrieval returned nothing for query=${JSON.stringify(q.slice(0, 80))} — quiet result`,
    );
    return { answer: null };
  }

  // --- 2. SCOPE. A gathered context is a promise about what we answer from;
  // if nothing relevant lives inside it, the honest answer is the quiet one,
  // NOT a whole-pool answer the user did not ask for.
  let pool = results;
  if (scoped) {
    const allowed = await memoryIdsForEntities(contextEntityIds);
    pool = results.filter((r) => allowed.has(r.memoryId));
    if (pool.length === 0) {
      console.warn(
        `[ask] gathered scope (${contextEntityIds.length} entities) excluded every ` +
        `result for query=${JSON.stringify(q.slice(0, 80))} — serving the quiet result`,
      );
      return { answer: null };
    }
  }

  // --- 3. RANK + FLOOR. Rank by real similarity rather than RRF, so the
  // composer reads the passages most about the question first. The floor here
  // is a degenerate-retrieval check only; answerability is the composer's call
  // (see ASK_ANSWER_MIN_SCORE for the measurements behind that split).
  const byRelevance = [...pool].sort((a, b) => b.vectorScore - a.vectorScore);
  const top = byRelevance[0]?.vectorScore ?? 0;
  if (top < ASK_ANSWER_MIN_SCORE) {
    console.info(
      `[ask] retrieval is degenerate (top=${top.toFixed(3)} < ` +
      `${ASK_ANSWER_MIN_SCORE}) for query=${JSON.stringify(q.slice(0, 80))} — quiet result`,
    );
    return { answer: null };
  }
  const strong = byRelevance
    .filter((r) => r.vectorScore >= ASK_SUPPORT_MIN_SCORE)
    .slice(0, ASK_COMPOSE_PARTS);

  // --- 4. COMPOSE. The question, the conversation, and the excerpts.
  const hardTopics = deriveIsHardTopic(strong);
  const composeInput: AskComposeInput = {
    query: q,
    parts: strong.map((r) => ({
      // The unit-grained matched passage, not the whole entry.
      text: r.excerpt,
      date: dateProse(r.createdAt),
      // source.id IS the canonical memory id (parent_window_id) — the id iOS
      // annotation source.id must carry for tap-to-rise to resolve.
      source: { type: 'memory' as const, id: r.memoryId },
    })),
    turns: options.turns ?? [],
    hardTopics,
  };

  let composedText: string;
  let composedAnnotations: AskAnnotation[];
  let answered: boolean;
  try {
    const composition = await composeAskWithLLM(composeInput);
    composedText = composition.text;
    composedAnnotations = toAskAnnotations(composition.text, composition.annotations);
    answered = composition.answered;
  } catch (err) {
    // No prose fallback by design (see the module doc). A stitched-together
    // floor is what made the ask read as a page of links; the quiet result is
    // both truthful and recoverable — the user rephrases and asks again.
    const reason = err instanceof AskLLMError ? err.reason : 'unexpected';
    console.warn(
      `[ask] composition failed (reason=${reason}) for ` +
      `query=${JSON.stringify(q.slice(0, 80))} — serving the quiet result: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return { answer: null };
  }

  if (composedText.trim().length === 0) {
    console.warn(`[ask] blank answerText for query=${JSON.stringify(q.slice(0, 80))} — quiet result`);
    return { answer: null };
  }

  // `answered: false` is NOT the empty state. The passages cleared the gate,
  // so there IS material — the composer has just told us it does not answer
  // the question, and said so in prose ("there's almost nothing here about the
  // move — i mentioned it twice and never tied it to anything"). That named
  // absence is more use to the user than the canned empty copy, and the corpus
  // asks for exactly it (ask.md §"Query that the user is hoping the substrate
  // hasn't surfaced"). Log it so the retrieval/answer gap stays visible.
  if (!answered) {
    console.info(
      `[ask] composer reports the passages do not answer ` +
      `query=${JSON.stringify(q.slice(0, 80))} — serving its honest-absence prose`,
    );
  }

  // --- 5. DERIVE. Entities come from the excerpts that actually informed the
  // answer, not from everything retrieval touched — the constellation
  // brightens what the answer drew on (ask.md §"Source citations").
  const relevantEntityIds = await relevantEntitiesFor(strong.map((r) => r.memoryId));

  const answer: AskResult = {
    composedAt: new Date().toISOString(),
    queryText: q,
    answerText: composedText,
    annotations: composedAnnotations,
    isHardTopic: hardTopics,
    isAmbiguous: deriveIsAmbiguous(strong),
    relevantEntityIds,
    // The HONEST echo: emitted only when a scope was actually applied to the
    // search. iOS renders its "within X" line off presence + non-emptiness, so
    // an unconditional echo would claim a scope we never used.
    ...(scoped ? { scopedToEntityIds: contextEntityIds } : {}),
  };

  void voiceInput; // wire-contract parity; composition is identical either way.
  return { answer };
}

/**
 * Re-shape the compose seam's annotations to the ask wire's closed source type
 * and re-validate the UTF-16 in-bounds invariant, so a future edit cannot ship
 * a span the iOS decoder would reject (`invalidSpan`).
 *
 * Out-of-bounds spans are DROPPED (warn-logged): a dropped span loses its
 * underline, an out-of-bounds one loses the screen.
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
