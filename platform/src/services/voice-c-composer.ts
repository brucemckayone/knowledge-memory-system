/**
 * Voice-C Composer Service (iOS API v1)
 *
 * DETERMINISTIC Voice-C prose composer that emits { text, annotations } for the
 * iOS client. This satisfies ASK-005 (Voice-C persona) and ASK-009 (UTF-16
 * annotation spans) for v1.
 *
 * There is NO LLM call in v1. We assemble real, Voice-C-valid prose by joining
 * caller-provided "parts" and compute each part's annotation span from the
 * final text. The LLM-persona upgrade (richer, generated prose) is a documented
 * follow-up — this service is the deterministic floor it will later replace.
 *
 * UTF-16 NOTE (load-bearing for the iOS decoder): in Node/TS, String.length and
 * String.prototype.indexOf both count UTF-16 code units natively. So a span
 * computed as { start: text.indexOf(phrase), end: start + phrase.length } IS
 * already expressed in the UTF-16 code units iOS expects. We do NOT call the
 * Python ml-services for offsets — there is nothing to convert.
 *
 * VOICE-C RULES this module is responsible for (enforced by assertVoiceC in dev
 * builds, and by the deterministic phrasing helpers always):
 *   - all lowercase
 *   - no forbidden verbs (delete, save, store, submit, send, sync, upload,
 *     complete, finish, notify, remind, share, retry, suggest, recommend)
 *   - no forbidden modifiers (delightful, powerful, smart, easy, quickly,
 *     seamlessly, instantly, automatically)
 *   - never reference a system self ("i, mnemo", "i noticed")
 *   - encouraging, not guilting
 *
 * MULTI-SENTENCE INVARIANT (load-bearing for the iOS decoder): if the composed
 * text contains MORE THAN ONE SENTENCE, `annotations` MUST be non-empty —
 * iOS VoiceCComposition.fromBackend throws 'multiSentenceWithoutAnnotations'
 * otherwise. composeVoiceC enforces this and throws if a caller hands it
 * multi-sentence prose with no sourced parts. The phrasing helpers below always
 * attach at least one source, so they never trip this.
 */

export type VoiceCSourceType = 'memory' | 'entity' | 'event' | 'fact' | 'pulled_line';

export interface VoiceCSource {
  type: VoiceCSourceType;
  id: string;
}

/**
 * One unit of composition. `phrase` is emitted into the text verbatim; if a
 * `source` is present, an annotation span pointing at that phrase is produced.
 */
export interface VoiceCPart {
  phrase: string;
  source?: VoiceCSource;
}

export interface VoiceCAnnotation {
  /** UTF-16 code-unit offset of the phrase start in `text`. */
  start: number;
  /** UTF-16 code-unit offset one past the phrase end. Always > start. */
  end: number;
  source: { type: string; id: string };
}

export interface VoiceCComposition {
  text: string;
  annotations: VoiceCAnnotation[];
}

// --- Voice-C lint vocab (deterministic, lowercase-matched) -------------------

const FORBIDDEN_VERBS = [
  'delete', 'save', 'store', 'submit', 'send', 'sync', 'upload',
  'complete', 'finish', 'notify', 'remind', 'share', 'retry',
  'suggest', 'recommend',
];

const FORBIDDEN_MODIFIERS = [
  'delightful', 'powerful', 'smart', 'easy', 'quickly',
  'seamlessly', 'instantly', 'automatically',
];

const FORBIDDEN_SELF = [
  'i, mnemo', 'i noticed', "i'm mnemo", 'i am mnemo', 'i, the system',
];

/** Word-boundary match so "submitted" trips on "submit" but "completeness"
 *  also trips on "complete" — we want the conservative net here. */
function containsWord(haystackLower: string, word: string): boolean {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return re.test(haystackLower);
}

/**
 * Throw if `text` violates a Voice-C rule. Used to guard hand-fed prose. The
 * deterministic phrasing helpers below are constructed from vetted fragments,
 * so this is a belt-and-braces check rather than the primary defense.
 */
export function assertVoiceC(text: string): void {
  const lower = text.toLowerCase();
  if (text !== lower) {
    throw new Error(`voice-c violation: text is not all-lowercase: ${JSON.stringify(text)}`);
  }
  for (const v of FORBIDDEN_VERBS) {
    if (containsWord(lower, v)) {
      throw new Error(`voice-c violation: forbidden verb "${v}" in ${JSON.stringify(text)}`);
    }
  }
  for (const m of FORBIDDEN_MODIFIERS) {
    if (containsWord(lower, m)) {
      throw new Error(`voice-c violation: forbidden modifier "${m}" in ${JSON.stringify(text)}`);
    }
  }
  for (const s of FORBIDDEN_SELF) {
    if (lower.includes(s)) {
      throw new Error(`voice-c violation: system-self reference "${s}" in ${JSON.stringify(text)}`);
    }
  }
}

// --- Composition core --------------------------------------------------------

/** True if `text` contains more than one sentence (rough but conservative:
 *  any sentence-final punctuation that is followed by more non-space text). */
function isMultiSentence(text: string): boolean {
  const trimmed = text.trim();
  // Count sentence-final marks that have following content (so a single
  // trailing period does not count as a second sentence).
  const matches = trimmed.match(/[.!?…]+\s+\S/g);
  return matches !== null && matches.length >= 1;
}

/**
 * Join `parts` into one Voice-C text string and compute UTF-16 annotation spans.
 *
 * Joining: phrases are concatenated with single spaces, except a phrase that
 * begins with sentence/clause punctuation (".", ",", ";", ":", "!", "?", "…")
 * is appended with no leading space, so "noticed" + "." reads "noticed.".
 *
 * Spans: for each part with a `source`, start = first index of that phrase in
 * the final text (searching forward from a running cursor so repeated phrases
 * map to distinct, in-order occurrences), end = start + phrase.length. The
 * invariant 0 <= start < end always holds (empty-phrase sourced parts throw).
 *
 * Multi-sentence guard: if the composed text is multi-sentence and no part
 * carried a source, this throws — the iOS decoder would reject it.
 */
export function composeVoiceC(parts: VoiceCPart[]): VoiceCComposition {
  let text = '';
  // Remember, per part, where in `text` its phrase landed so spans are exact
  // even when the same phrase appears twice.
  const placed: Array<{ part: VoiceCPart; start: number }> = [];

  for (const part of parts) {
    const phrase = part.phrase;
    if (phrase.length === 0) {
      // An empty phrase contributes nothing and cannot carry a valid span.
      if (part.source) {
        throw new Error('voice-c composition: a sourced part has an empty phrase (start would equal end)');
      }
      continue;
    }

    const startsWithPunct = /^[.,;:!?…]/.test(phrase);
    let sep = '';
    if (text.length > 0 && !startsWithPunct) {
      sep = ' ';
    }
    text += sep;
    const start = text.length; // UTF-16 code-unit offset
    text += phrase;
    placed.push({ part, start });
  }

  const annotations: VoiceCAnnotation[] = [];
  for (const { part, start } of placed) {
    if (!part.source) continue;
    const end = start + part.phrase.length;
    // Invariant: 0 <= start < end. start >= 0 by construction; end > start
    // because phrase.length > 0 (empty phrases were rejected above).
    annotations.push({
      start,
      end,
      source: { type: part.source.type, id: part.source.id },
    });
  }

  if (annotations.length === 0 && isMultiSentence(text)) {
    throw new Error(
      `voice-c composition: multi-sentence text with no annotations would be rejected by iOS ` +
      `(VoiceCComposition.fromBackend -> 'multiSentenceWithoutAnnotations'): ${JSON.stringify(text)}`,
    );
  }

  return { text, annotations };
}

// --- Phrasing helpers (what the hero / notification handlers call) -----------

/** Lowercase + collapse internal whitespace + trim, so an entity name like
 *  "Project  Atlas" reads cleanly inside Voice-C prose. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Voice-C count phrasing: "1 thread" / "3 threads", "1 entry" / "12 entries"
 *  (no leading article). Handles the consonant+y -> -ies case. */
function pluralize(count: number, singular: string): string {
  if (count === 1) return `${count} ${singular}`;
  const plural = /[^aeiou]y$/.test(singular)
    ? `${singular.slice(0, -1)}ies`
    : `${singular}s`;
  return `${count} ${plural}`;
}

export interface EntitySummaryInput {
  entityId: string;
  /** Display name of the entity (will be lowercased into the prose). */
  name: string;
  /** How many threads / relations touch this entity. */
  threadCount: number;
  /** How many entries / memories mention this entity. */
  entryCount: number;
}

/**
 * Phrase an entity by its thread/entry counts. The entity name itself is the
 * annotated span (source = the entity), so the result is always single-source
 * and never trips the multi-sentence guard.
 *
 *   summarizeEntity({ name: "Atlas", threadCount: 3, entryCount: 12, ... })
 *   -> text: "atlas runs through 3 threads and lives in 12 entries"
 *      annotations: [{ start, end, source: { type: 'entity', id } }]
 *
 * Count edge cases read naturally: 0 threads -> "sits quietly, not yet woven
 * into a thread"; entries always phrased, 1 entry -> "1 entry".
 */
export function summarizeEntity(input: EntitySummaryInput): VoiceCComposition {
  const name = normalize(input.name);
  const threads = Math.max(0, Math.trunc(input.threadCount));
  const entries = Math.max(0, Math.trunc(input.entryCount));

  const parts: VoiceCPart[] = [
    { phrase: name, source: { type: 'entity', id: input.entityId } },
  ];

  if (threads > 0) {
    parts.push({ phrase: `runs through ${pluralize(threads, 'thread')} and lives in ${pluralize(entries, 'entry')}` });
  } else {
    parts.push({ phrase: `lives in ${pluralize(entries, 'entry')}, not yet woven into a thread` });
  }

  const composition = composeVoiceC(parts);
  assertVoiceC(composition.text);
  return composition;
}

export interface ContradictionPhraseInput {
  /** The contradiction row id (annotated as the 'event' source). */
  contradictionId: string;
  /** Source type for the annotated span — defaults to 'event'. */
  sourceType?: VoiceCSourceType;
  /** Short Voice-C fragment naming the first held belief, e.g.
   *  "atlas ships in june". Lowercased; no trailing punctuation. */
  firstClaim: string;
  /** Short Voice-C fragment naming the second, tension-holding belief, e.g.
   *  "atlas ships in september". Lowercased; no trailing punctuation. */
  secondClaim: string;
}

/**
 * Phrase a contradiction as a gentle "two things sit in tension" observation —
 * encouraging, never guilting, never an entity-self. The whole observed clause
 * is annotated to the contradiction's source so the result is single-source and
 * decoder-safe even though it can read as one flowing sentence.
 *
 *   phraseContradiction({ firstClaim: "atlas ships in june",
 *                         secondClaim: "atlas ships in september", ... })
 *   -> "two threads hold a tension here: atlas ships in june, and also
 *       atlas ships in september"
 */
export function phraseContradiction(input: ContradictionPhraseInput): VoiceCComposition {
  const first = normalize(input.firstClaim).replace(/[.!?…]+$/, '');
  const second = normalize(input.secondClaim).replace(/[.!?…]+$/, '');
  const sourceType: VoiceCSourceType = input.sourceType ?? 'event';

  const clause = `two threads hold a tension here: ${first}, and also ${second}`;
  const composition = composeVoiceC([
    { phrase: clause, source: { type: sourceType, id: input.contradictionId } },
  ]);
  assertVoiceC(composition.text);
  return composition;
}

/**
 * Phrase a single pulled line / recollection surfaced back to the user. The
 * line text is annotated to its source so the hero handler can deep-link.
 *
 *   phrasePulledLine({ line: "you wanted to walk more this spring", ... })
 *   -> "this came back to you: you wanted to walk more this spring"
 */
export interface PulledLineInput {
  /** The pulled-line / memory id (annotated). */
  sourceId: string;
  sourceType?: VoiceCSourceType;
  /** The recollected line, already in the user's own words. Lowercased. */
  line: string;
}

export function phrasePulledLine(input: PulledLineInput): VoiceCComposition {
  const line = normalize(input.line);
  const sourceType: VoiceCSourceType = input.sourceType ?? 'pulled_line';

  const composition = composeVoiceC([
    { phrase: 'this came back to you:' },
    { phrase: line, source: { type: sourceType, id: input.sourceId } },
  ]);
  assertVoiceC(composition.text);
  return composition;
}
