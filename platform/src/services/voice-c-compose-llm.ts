/**
 * Voice-C Compose — LLM seam (ASK-005 + ASK-009).
 *
 * The RICHER compose path on top of the deterministic floor
 * (`./voice-c-composer.ts`, which STAYS as the fallback). Every prose-heavy
 * iOS surface (ask / rise / re-read / walk / bridge) routes its sourced parts
 * through here first; on any failure it falls back to `composeVoiceC`.
 *
 * Division of labour (load-bearing — do not move these responsibilities):
 *
 *   * ml-services `/voice-c-compose` owns the Voice-C PERSONA. It returns
 *     `{ text, phrase_sources }` where `phrase_sources` maps each output
 *     phrase to the source it was lifted from. It does NOT compute offsets.
 *
 *   * THIS module owns the UTF-16 OFFSETS (ASK-009). `locatePhraseSpans`
 *     re-locates each returned phrase inside `text` via a forward-cursor
 *     `indexOf` and emits the spans the iOS decoder expects. In Node/TS,
 *     `String.length` and `String.prototype.indexOf` count UTF-16 code units
 *     natively, so spans computed here ARE already in the UTF-16 space iOS
 *     validates against (`text.utf16.count` in Swift). We do NOT ask Python
 *     for offsets — Python counts code points, which diverge on supplementary-
 *     plane characters (emoji, rare CJK). The TS server is the offset
 *     authority.
 *
 *   * Phrases that cannot be located in `text` are DROPPED with a warning
 *     rather than emitted as out-of-bounds spans (an out-of-bounds span
 *     would throw `invalidSpan` at the iOS decoder — a dropped phrase only
 *     loses its underline).
 *
 * Multi-sentence guard (load-bearing for the iOS decoder): if the composed
 * `text` is multi-sentence AND zero spans were located, this THROWS — the iOS
 * `VoiceCComposition.fromBackend` would throw `multiSentenceWithoutAnnotations`
 * and the caller must fall back (single-sentence, or the deterministic floor).
 */

import { config } from '../config.js';
import {
  type VoiceCComposition,
  type VoiceCPart,
  type VoiceCSource,
  assertVoiceC,
  composeVoiceC,
} from './voice-c-composer.js';

// ---------------------------------------------------------------------------
// Wire types — what ml-services /voice-c-compose speaks
// ---------------------------------------------------------------------------

/** Request shape POSTed to ml-services. */
interface VoiceCComposeWireRequest {
  parts: Array<{ text: string; source: VoiceCSource }>;
  surface: string;
  hard_topics: boolean;
}

/** Response shape returned by ml-services. Carries phrase→source, NOT
 *  pre-computed offsets — this module computes the UTF-16 spans. */
interface VoiceCComposeWireResponse {
  text: string;
  phrase_sources: Array<{ phrase: string; source: VoiceCSource }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the LLM path cannot produce a decoder-safe composition and the
 *  caller should fall back to the deterministic floor. Carries the reason so
 *  the fallback site can log it. */
export class VoiceCLLMComposeError extends Error {
  constructor(
    public readonly reason:
      | 'multi-sentence-no-spans'
      | 'upstream-unreachable'
      | 'upstream-error'
      | 'empty-text',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceCLLMComposeError';
  }
}

// ---------------------------------------------------------------------------
// Input — what callers pass
// ---------------------------------------------------------------------------

/** Input to the LLM compose seam. `parts` mirrors `VoiceCPart` from the
 *  deterministic composer but uses `text` (the raw past material) rather than
 *  a pre-composed `phrase`, since the LLM does the composing. */
export interface ComposeInputPart {
  /** Raw source material in the user's own words (any case — the LLM
   *  lowercases into Voice-C). */
  text: string;
  /** The handle this material came from. Lifted phrases map back to this. */
  source: VoiceCSource;
}

export interface ComposeInput {
  parts: ComposeInputPart[];
  /** iOS surface the prose is destined for (rise/ask/re-read/walk/bridge).
   *  Informational — passed through to the persona prompt. */
  surface?: string;
  /** Collapse to the hard-topics register (≤2 sentences, no questions). */
  hardTopics?: boolean;
}

// ---------------------------------------------------------------------------
// Offset authority — UTF-16 span location (ASK-009)
// ---------------------------------------------------------------------------

export interface LocatedSpan {
  /** UTF-16 code-unit offset of the phrase start in `text`. */
  start: number;
  /** UTF-16 code-unit offset one past the phrase end. */
  end: number;
  source: VoiceCSource;
}

export interface LocateResult {
  /** Spans successfully located in `text`, in document order. */
  spans: LocatedSpan[];
  /** phrase_sources whose phrase could not be found (dropped with a warning
   *  upstream). Returned for observability/tests. */
  dropped: Array<{ phrase: string; source: VoiceCSource }>;
}

/**
 * Re-locate each phrase in `text` via a forward-cursor `indexOf` and emit
 * UTF-16 spans. This is the ASK-009 offset authority.
 *
 * Forward cursor: a phrase that appears more than once maps to distinct,
 * in-order occurrences (the second occurrence is matched at an index after
 * the first), mirroring the deterministic composer's placement loop. A phrase
 * that does not appear verbatim is dropped.
 *
 * UTF-16: `String.prototype.indexOf` and `String.length` are UTF-16 code-unit
 * native in JS/TS, so `start`/`end` here are exactly the offsets the iOS
 * decoder validates (`text.utf16.count`). No conversion needed.
 *
 * Empty phrases are dropped (a span requires `0 <= start < end`, impossible
 * with length 0).
 */
export function locatePhraseSpans(
  text: string,
  phraseSources: Array<{ phrase: string; source: VoiceCSource }>,
): LocateResult {
  const spans: LocatedSpan[] = [];
  const dropped: Array<{ phrase: string; source: VoiceCSource }> = [];
  // Per-source cursor so two phrases from the SAME source, or the same phrase
  // appearing twice, advance past earlier matches. Keyed by phrase so distinct
  // phrases don't interfere; the cursor only advances for repeat occurrences.
  const cursorByPhrase = new Map<string, number>();

  for (const { phrase, source } of phraseSources) {
    if (phrase.length === 0) {
      dropped.push({ phrase, source });
      continue;
    }
    const fromIndex = cursorByPhrase.get(phrase) ?? 0;
    const start = text.indexOf(phrase, fromIndex);
    if (start === -1) {
      dropped.push({ phrase, source });
      continue;
    }
    const end = start + phrase.length; // UTF-16: phrase.length is code units
    // Invariant holds by construction: start >= 0; end > start because
    // phrase.length > 0 (empty phrases dropped above).
    spans.push({ start, end, source });
    cursorByPhrase.set(phrase, end);
  }

  // Document order by start offset, so the iOS underline layer renders them
  // left-to-right regardless of the order the LLM listed them.
  spans.sort((a, b) => a.start - b.start);
  return { spans, dropped };
}

// ---------------------------------------------------------------------------
// Multi-sentence detection (mirrors voice-c-composer.ts isMultiSentence)
// ---------------------------------------------------------------------------

function isMultiSentence(text: string): boolean {
  const trimmed = text.trim();
  const matches = trimmed.match(/[.!?…]+\s+\S/g);
  return matches !== null && matches.length >= 1;
}

// ---------------------------------------------------------------------------
// ml-services fetch (dedicated — the existing ml-client has no generic POST)
// ---------------------------------------------------------------------------

const COMPOSE_TIMEOUT_MS = 120_000;

async function postCompose(
  body: VoiceCComposeWireRequest,
): Promise<VoiceCComposeWireResponse> {
  const url = `${config.ML_SERVICES_URL}/voice-c-compose`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => resp.statusText);
      throw new VoiceCLLMComposeError(
        resp.status >= 500 ? 'upstream-error' : 'upstream-error',
        `ml-services /voice-c-compose returned ${resp.status}: ${detail.slice(0, 300)}`,
      );
    }
    const json = (await resp.json()) as VoiceCComposeWireResponse;
    if (typeof json.text !== 'string' || !Array.isArray(json.phrase_sources)) {
      throw new VoiceCLLMComposeError(
        'upstream-error',
        `ml-services /voice-c-compose returned malformed shape: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    return json;
  } catch (err) {
    if (err instanceof VoiceCLLMComposeError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new VoiceCLLMComposeError(
        'upstream-error',
        `ml-services /voice-c-compose timed out after ${COMPOSE_TIMEOUT_MS}ms`,
      );
    }
    throw new VoiceCLLMComposeError(
      'upstream-unreachable',
      `ml-services /voice-c-compose unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose Voice-C prose with the LLM and emit decoder-safe {text, annotations}.
 *
 * Flow:
 *   1. Build the prompt payload from `input.parts`.
 *   2. POST to ml-services `/voice-c-compose`, get {text, phrase_sources}.
 *   3. Re-locate each phrase in `text` via `locatePhraseSpans` (UTF-16).
 *      Un-locatable phrases are dropped (warn-logged) — never emitted as
 *      out-of-bounds spans.
 *   4. `assertVoiceC(text)` — rejects forbidden vocab / non-lowercase.
 *   5. Multi-sentence guard: if multi-sentence AND zero spans located, THROW
 *      `VoiceCLLMComposeError('multi-sentence-no-spans')` — the iOS decoder
 *      would reject it. Caller falls back.
 *
 * Throws `VoiceCLLMComposeError` for any condition that should trigger the
 * deterministic fallback. Throws the `assertVoiceC` Error directly if the LLM
 * emits forbidden vocab (a quality regression worth surfacing loudly, not
 * silently falling back).
 */
export async function composeVoiceCWithLLM(
  input: ComposeInput,
): Promise<VoiceCComposition> {
  if (input.parts.length === 0) {
    throw new VoiceCLLMComposeError('empty-text', 'composeVoiceCWithLLM: parts is empty');
  }

  const wire: VoiceCComposeWireRequest = {
    parts: input.parts.map((p) => ({ text: p.text, source: p.source })),
    surface: input.surface ?? 'composition',
    hard_topics: input.hardTopics ?? false,
  };

  const { text, phrase_sources } = await postCompose(wire);

  if (text.trim().length === 0) {
    throw new VoiceCLLMComposeError('empty-text', 'ml-services returned empty text');
  }

  // assertVoiceC FIRST — if the LLM drifts off Voice-C (forbidden verb,
  // non-lowercase, system-self reference), that is a quality regression we
  // want to surface loudly. The caller decides whether to fall back, but the
  // error is the assertVoiceC message, not a soft compose failure.
  assertVoiceC(text);

  const { spans, dropped } = locatePhraseSpans(text, phrase_sources);
  if (dropped.length > 0) {
    console.warn(
      `[voice-c-compose-llm] dropped ${dropped.length} un-locatable phrase(s) from ` +
      `surface=${wire.surface}: ${dropped.map((d) => JSON.stringify(d.phrase)).join(', ')}`,
    );
  }

  // Multi-sentence guard — load-bearing for the iOS decoder. A multi-sentence
  // composition with zero annotations throws `multiSentenceWithoutAnnotations`
  // at decode time; we fail here so the caller can fall back to a span-bearing
  // deterministic composition rather than shipping a decode-time blank screen.
  if (spans.length === 0 && isMultiSentence(text)) {
    throw new VoiceCLLMComposeError(
      'multi-sentence-no-spans',
      `LLM produced multi-sentence prose with no locatable spans (would fail iOS ` +
      `decoder multiSentenceWithoutAnnotations): ${JSON.stringify(text)}`,
    );
  }

  const annotations = spans.map((s) => ({
    start: s.start,
    end: s.end,
    source: { type: s.source.type, id: s.source.id },
  }));

  return { text, annotations };
}

// ---------------------------------------------------------------------------
// Fallback helper — the deterministic floor, made convenient for callers
// ---------------------------------------------------------------------------

/**
 * Try the LLM compose; on any failure, fall back to the deterministic
 * `composeVoiceC` over the same parts (each part's `text` becomes a
 * `phrase` with its source). This is the shape every prose-heavy surface
 * should call: rich LLM prose when it works, decoder-safe deterministic
 * prose always.
 *
 * The fallback lowercases + trims each part's text into a Voice-C phrase and
 * hands the lot to `composeVoiceC`, which joins them and attaches a span per
 * sourced part — so the fallback is always multi-sentence-safe.
 */
export async function composeVoiceCWithLLMFallback(
  input: ComposeInput,
): Promise<VoiceCComposition> {
  try {
    return await composeVoiceCWithLLM(input);
  } catch (err) {
    if (err instanceof VoiceCLLMComposeError) {
      console.warn(
        `[voice-c-compose-llm] LLM compose failed (${err.reason}), falling back to ` +
        `deterministic floor: ${err.message}`,
      );
    } else if (err instanceof Error) {
      console.warn(
        `[voice-c-compose-llm] LLM compose rejected by assertVoiceC, falling back: ${err.message}`,
      );
    } else {
      throw err; // unexpected — don't swallow
    }
    const parts: VoiceCPart[] = input.parts.map((p) => ({
      phrase: p.text.toLowerCase().replace(/\s+/g, ' ').trim(),
      source: p.source,
    }));
    // composeVoiceC is the deterministic floor; it throws only on genuinely
    // degenerate input (empty sourced phrase). Let that propagate.
    return composeVoiceC(parts);
  }
}
