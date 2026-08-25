/**
 * Voice-C ASK seam (ASK-005 ask-mode + ASK-009 spans) — MNEMO-96o8.
 *
 * The ask counterpart to `voice-c-compose-llm.ts`. Same division of labour:
 * ml-services `/voice-c-ask` owns the persona and returns phrase→source pairs;
 * THIS module owns UTF-16 offsets (Node counts UTF-16 code units natively,
 * Python counts code points — they diverge on emoji, and iOS validates against
 * `text.utf16.count`).
 *
 * WHY A SEPARATE SEAM rather than a `query` field on the compose seam:
 *
 *   1. The register is different, and the compose persona is load-bearing for
 *      four other surfaces (rise / re-read / walk / bridge). Teaching it to
 *      answer questions would either regress them or grow one prompt with two
 *      modes fighting each other.
 *   2. The VALIDATION is different, and this is the subtler half. The compose
 *      path guards prose the system chose to surface, so `assertVoiceC`'s
 *      all-lowercase + forbidden-vocabulary rules apply to every character.
 *      An ANSWER quotes the asker's own past words back at them — and their
 *      words were never bound by Voice C. Running the compose assertion over
 *      an answer is what kept the ask broken: the shared persona is told
 *      "proper nouns stay cased" while `assertVoiceC` throws on any uppercase
 *      character, so a single name ("Frodo", "M") failed the composition,
 *      fell through to the deterministic floor, and the floor concatenated
 *      eight whole parent-window bodies lowercased and fully underlined. That
 *      wall of quoted fragments IS the "links instead of answers" bug.
 *
 * So `assertAskVoice` below validates the two halves separately: the prose the
 * model WROTE must be lowercase and Voice-C-clean; the phrases it QUOTED are
 * the user's own and are exempt. See its doc comment for the mechanism.
 *
 * There is deliberately NO deterministic prose fallback here. The compose
 * seam's floor exists because a hero/letter surface must render something; an
 * ask has an honest alternative — the quiet result (ask.md §"Empty (no
 * match)"). A composition failure returns `null` and the caller renders "nothing
 * comes back yet", which is true, instead of a wall of raw entries, which is
 * not an answer.
 */

import { config } from '../config.js';
import { locatePhraseSpans } from './voice-c-compose-llm.js';
import type { VoiceCSource } from './voice-c-composer.js';

// ---------------------------------------------------------------------------
// Wire types — what ml-services /voice-c-ask speaks
// ---------------------------------------------------------------------------

interface AskWireRequest {
  query: string;
  parts: Array<{ text: string; date: string; source: VoiceCSource }>;
  turns: Array<{ query: string; answer: string }>;
  hard_topics: boolean;
}

interface AskWireResponse {
  text: string;
  phrase_sources: Array<{ phrase: string; source: VoiceCSource }>;
  answered: boolean;
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/** One retrieved excerpt the answer may draw on. */
export interface AskComposePart {
  /**
   * The UNIT-GRAINED matched excerpt (`SearchResult.excerpt`), not the whole
   * parent window. Whole windows bury the answer in surrounding prose and
   * blow the composer's attention budget across eight entries.
   */
  text: string;
  /** Human date prose the answer can use ("in february", "on the monday"). */
  date: string;
  /** Source handle; a quoted phrase maps back to this for tap-to-rise. */
  source: VoiceCSource;
}

/** One prior exchange in this ask conversation, oldest first. */
export interface AskTurn {
  query: string;
  answer: string;
}

export interface AskComposeInput {
  /** The question, verbatim as the user asked it. */
  query: string;
  parts: AskComposePart[];
  /** Conversation so far; empty for a first turn. */
  turns?: AskTurn[];
  hardTopics?: boolean;
}

export interface AskComposition {
  text: string;
  annotations: Array<{ start: number; end: number; source: VoiceCSource }>;
  /**
   * The model's own verdict on whether the excerpts answered the question.
   * `false` means `text` names an absence honestly rather than answering —
   * the caller decides whether to serve that prose or fall through to the
   * quiet empty state.
   */
  answered: boolean;
}

export class AskLLMError extends Error {
  constructor(
    public readonly reason:
      | 'upstream-unreachable'
      | 'upstream-error'
      | 'empty-text'
      | 'voice-violation',
    message: string,
  ) {
    super(message);
    this.name = 'AskLLMError';
  }
}

// ---------------------------------------------------------------------------
// Voice validation — the ask register
// ---------------------------------------------------------------------------

/** Verbs the SYSTEM never uses (design/01-voice-and-tone.md). A phrase quoted
 *  from the user's own entries is exempt — see `assertAskVoice`. */
const FORBIDDEN_VERBS = [
  'delete', 'save', 'store', 'submit', 'send', 'sync', 'upload',
  'complete', 'finish', 'notify', 'remind', 'share', 'retry',
  'suggest', 'recommend',
];

const FORBIDDEN_MODIFIERS = [
  'delightful', 'powerful', 'smart', 'easy', 'quickly',
  'seamlessly', 'instantly', 'automatically',
];

/** Never an entity (hard rule 2). Checked over the WHOLE text — a quote
 *  cannot license the system naming itself. */
const FORBIDDEN_SELF = [
  'i, mnemo', 'i noticed', "i'm mnemo", 'i am mnemo', 'i, the system', 'mnemo',
];

/** Hedging modals the corpus forbids in composed prose. */
const FORBIDDEN_HEDGES = ['perhaps', 'appears to', 'seems like'];

function containsWord(haystack: string, word: string): boolean {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return re.test(haystack);
}

/**
 * Lowercase the standalone pronoun "I" (and its contractions: "I'm", "I've",
 * "I'd", "I'll").
 *
 * `01-voice-and-tone.md` is unambiguous — *"the pronoun 'i' stays lowercase"* —
 * and this is the one voice rule that is mechanically fixable rather than a
 * judgement call: there is exactly one correct repair, it cannot change what
 * the sentence means, and it is LENGTH-PRESERVING, so citation offsets computed
 * afterwards are unaffected.
 *
 * Normalising beats rejecting here. The model picks up the capital honestly —
 * it is quoting entries the user wrote with a capital "I" — and live, a single
 * letter was discarding an otherwise correct answer and sending the ask quiet
 * (caught 2026-08-25). Losing a whole answer over a typographic slip is a
 * worse outcome for the user than the slip. Every OTHER capital still goes
 * through `assertAskVoice`'s source-material exemption, which needs judgement
 * and therefore gets none of this leniency.
 */
export function lowercasePronounI(text: string): string {
  return text.replace(/\bI\b/g, 'i');
}

/**
 * Mask the located citation spans out of `text`, leaving only the prose the
 * model wrote in its own voice. Replaces each cited range with spaces so
 * offsets (and therefore word boundaries at the seams) are preserved.
 */
function proseOutsideCitations(
  text: string,
  spans: Array<{ start: number; end: number }>,
): string {
  const chars = [...text];
  // `text` is indexed in UTF-16 units by the span contract; operate on the
  // raw string to stay in that space.
  let masked = text;
  for (const s of spans) {
    const start = Math.max(0, Math.min(s.start, masked.length));
    const end = Math.max(start, Math.min(s.end, masked.length));
    masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
  }
  void chars;
  return masked;
}

/**
 * Validate an ask answer, honouring the split between what the model wrote and
 * what it quoted.
 *
 * THE LOWERCASE RULE (`01-voice-and-tone.md` §"Lowercase, always") applies to
 * composed prose, and the corpus itself carves out proper nouns: *"proper nouns
 * that are themselves proper-noun stay cased"*. An answer drawing on entries
 * about a person called M, or a place called Rivendell, must keep those names
 * as the user wrote them — lowercasing someone's name is its own kind of wrong.
 *
 * So a cased token is allowed IF AND ONLY IF that exact token appears, cased
 * the same way, in the source material the answer was composed from. That
 * permits the user's own proper nouns and still rejects what the rule is
 * actually for: sentence-initial capitals, Title Case, and Marketing Caps the
 * model invented.
 *
 * THE VOCABULARY RULES apply only to prose OUTSIDE the citation spans. The
 * forbidden verbs are forbidden to the system; the user is free to have written
 * "i need to finish the studio thing", and quoting them back is not a voice
 * violation. `FORBIDDEN_SELF` is the exception — checked over the whole text,
 * because no quotation licenses the product naming itself as an entity (hard
 * rule 2).
 *
 * Throws `AskLLMError('voice-violation')`. The caller does NOT fall back to
 * stitched raw prose (there is no such path here) — it degrades to the quiet
 * result, so a voice regression surfaces as an honest silence rather than as
 * off-voice copy shipped to the surface.
 */
export function assertAskVoice(
  text: string,
  spans: Array<{ start: number; end: number }>,
  sourceMaterial: string,
): void {
  // --- 1. Never an entity. Whole text, no exemption.
  const lowerAll = text.toLowerCase();
  for (const s of FORBIDDEN_SELF) {
    if (lowerAll.includes(s)) {
      throw new AskLLMError(
        'voice-violation',
        `system-self reference "${s}" in answer: ${JSON.stringify(text)}`,
      );
    }
  }

  // --- 2. Lowercase, with the user's own proper nouns exempt.
  //
  // A token counts as the user's if it appears case-identically in the material
  // the answer was composed from.
  //
  // APOSTROPHES ARE NOT PART OF A TOKEN. A possessive or contraction would
  // otherwise fail a source check its root passes: the user wrote "Maya", the
  // answer says "Maya's question", and `sourceMaterial.includes("Maya's")` is
  // false — so a correct answer got rejected and the ask went quiet. Splitting
  // on the apostrophe checks "Maya" (found) and "s" (uncased, unchecked).
  // Genuinely apostrophised names survive too: "O'Brien" checks "O" and
  // "Brien", both present wherever the name is.
  const casedTokens = text.match(/[\p{L}\p{M}-]*\p{Lu}[\p{L}\p{M}-]*/gu) ?? [];
  for (const token of casedTokens) {
    // The pronoun "i" stays lowercase, always (`01-voice-and-tone.md`
    // §"Lowercase, always"). No source exemption applies: raw entries are full
    // of "I", so a source check alone would license every "I'm" the model
    // writes and quietly gut the rule.
    if (token === 'I') {
      throw new AskLLMError(
        'voice-violation',
        `answer capitalises the pronoun "I": ${JSON.stringify(text)}`,
      );
    }
    if (!sourceMaterial.includes(token)) {
      throw new AskLLMError(
        'voice-violation',
        `answer is not lowercase and "${token}" is not a proper noun from the ` +
        `source material: ${JSON.stringify(text)}`,
      );
    }
  }

  // --- 3. Vocabulary — the model's OWN prose only.
  const own = proseOutsideCitations(text, spans).toLowerCase();
  for (const v of FORBIDDEN_VERBS) {
    if (containsWord(own, v)) {
      throw new AskLLMError(
        'voice-violation',
        `forbidden verb "${v}" in the answer's own prose: ${JSON.stringify(text)}`,
      );
    }
  }
  for (const m of FORBIDDEN_MODIFIERS) {
    if (containsWord(own, m)) {
      throw new AskLLMError(
        'voice-violation',
        `forbidden modifier "${m}" in the answer's own prose: ${JSON.stringify(text)}`,
      );
    }
  }
  for (const h of FORBIDDEN_HEDGES) {
    if (own.includes(h)) {
      throw new AskLLMError(
        'voice-violation',
        `hedging "${h}" in the answer's own prose: ${JSON.stringify(text)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Phrase location — exact, then longest-run recovery
// ---------------------------------------------------------------------------

/** Shortest recovered run worth underlining: fewer words than this is not a
 *  citation, it is a coincidence (an underlined "the trip" teaches nothing). */
const MIN_RECOVERED_WORDS = 4;

/**
 * Locate each cited phrase in the answer, recovering from near-misses.
 *
 * Exact location is tried first (the shared `locatePhraseSpans` authority).
 * When it fails, the usual reason — seen live, 2026-08-25 — is that the model
 * wrote flowing prose but copied its `phrase` out of the SOURCE PASSAGE rather
 * than out of its own sentence: the answer says "dad seemed tired but in good
 * spirits, teasing about the climbing" while the citation reads "dad seemed
 * tired but in good spirits, kept teasing me about my climbing". Nothing
 * matches, every underline is dropped, and the answer arrives with no way back
 * to its sources — which is precisely half of what the ask is for.
 *
 * The prompt now says this outright, but a prompt is not a guarantee. So a
 * failed exact match falls back to the longest contiguous WORD RUN of the
 * phrase that does appear in the answer, at least `MIN_RECOVERED_WORDS` long.
 * That recovers the real overlap ("dad seemed tired but in good spirits") and
 * underlines exactly the words the user can trust, never inventing a span the
 * answer does not contain.
 *
 * Word runs are tried longest-first and anchored on word boundaries in `text`,
 * so a recovered span never starts or ends mid-word.
 */
export function locateAskPhrases(
  text: string,
  phraseSources: Array<{ phrase: string; source: VoiceCSource }>,
): {
  spans: Array<{ start: number; end: number; source: VoiceCSource }>;
  dropped: Array<{ phrase: string; source: VoiceCSource }>;
  recovered: number;
} {
  const exact = locatePhraseSpans(text, phraseSources);
  if (exact.dropped.length === 0) {
    return { spans: exact.spans, dropped: [], recovered: 0 };
  }

  const spans = [...exact.spans];
  const dropped: Array<{ phrase: string; source: VoiceCSource }> = [];
  let recovered = 0;

  for (const miss of exact.dropped) {
    const words = miss.phrase.trim().split(/\s+/).filter((w) => w.length > 0);
    let found: { start: number; end: number } | null = null;
    // Longest run first, sliding left to right, so the recovered span is the
    // most informative overlap rather than the first short one.
    for (let len = words.length; len >= MIN_RECOVERED_WORDS && !found; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const run = words.slice(i, i + len).join(' ');
        const at = indexOfWholeWords(text, run);
        if (at >= 0) {
          found = { start: at, end: at + run.length };
          break;
        }
      }
    }
    if (found) {
      spans.push({ ...found, source: miss.source });
      recovered += 1;
    } else {
      dropped.push(miss);
    }
  }

  spans.sort((a, b) => a.start - b.start);
  return { spans, dropped, recovered };
}

/**
 * `indexOf` that will not match mid-word — so citing "the trip" cannot
 * underline the tail of "stripped". Returns -1 when absent.
 */
function indexOfWholeWords(text: string, run: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf(run, from);
    if (at < 0) return -1;
    const before = at === 0 ? '' : text[at - 1]!;
    const after = at + run.length >= text.length ? '' : text[at + run.length]!;
    const boundary = (c: string) => c === '' || !/[\p{L}\p{N}]/u.test(c);
    if (boundary(before) && boundary(after)) return at;
    from = at + 1;
  }
}

// ---------------------------------------------------------------------------
// Span hygiene
// ---------------------------------------------------------------------------

/**
 * Drop spans that overlap an already-kept span, keeping the earlier (and on a
 * tie, the longer) one.
 *
 * `UnderlinedProse` renders overlapping annotations last-writer-wins on the
 * overlap region, so an overlap is not a crash — but it is an ambiguous tap
 * target: the user presses a phrase and cannot tell which source will rise.
 * The model produces these when it cites a sentence and then a clause inside
 * it. One unambiguous underline per region is the honest affordance.
 */
export function dropOverlappingSpans<T extends { start: number; end: number }>(
  spans: T[],
): { kept: T[]; dropped: T[] } {
  const ordered = [...spans].sort(
    (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start),
  );
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const s of ordered) {
    const clashes = kept.some((k) => s.start < k.end && k.start < s.end);
    if (clashes) dropped.push(s);
    else kept.push(s);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// ml-services fetch
// ---------------------------------------------------------------------------

/**
 * Composition budget, deliberately set BELOW the iOS client's own ask timeout
 * (`AskRequest.timeout`, 150s) so the two do not race.
 *
 * Ordering matters more than the exact number. If the server gives up last, the
 * client times out first and the user gets a transport failure — "the pool is
 * quiet from here" — for an answer that was still being written. If the SERVER
 * gives up first, the client receives a clean `{ answer: null }` and renders the
 * honest quiet result. Same latency, but only one of the two is a true
 * statement, so the server must always be the one to yield.
 *
 * The corpus targets ≤3s (ask.md §"Result is not pregenerated") and reality on
 * this provider is 19s to over 90s — the variance is the Claude CLI, not the
 * prompt. The wait is what the `still settling…` state is for; closing the gap
 * is its own piece of work (tracked on the epic), not something a timeout can
 * fix.
 */
const ASK_TIMEOUT_MS = 120_000;

async function postAsk(body: AskWireRequest): Promise<AskWireResponse> {
  const url = `${config.ML_SERVICES_URL}/voice-c-ask`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => resp.statusText);
      throw new AskLLMError(
        'upstream-error',
        `ml-services /voice-c-ask returned ${resp.status}: ${detail.slice(0, 300)}`,
      );
    }
    const json = (await resp.json()) as AskWireResponse;
    if (typeof json.text !== 'string' || !Array.isArray(json.phrase_sources)) {
      throw new AskLLMError(
        'upstream-error',
        `ml-services /voice-c-ask returned malformed shape: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    return json;
  } catch (err) {
    if (err instanceof AskLLMError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AskLLMError(
        'upstream-unreachable',
        `ml-services /voice-c-ask timed out after ${ASK_TIMEOUT_MS}ms`,
      );
    }
    throw new AskLLMError(
      'upstream-unreachable',
      `ml-services /voice-c-ask unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose an answer to `input.query` from `input.parts`, with UTF-16 citation
 * spans over the returned prose.
 *
 * Flow: POST the question + conversation + excerpts → re-locate each quoted
 * phrase in the answer (`locatePhraseSpans`, the shared offset authority) →
 * drop overlapping spans → validate the ask register → return.
 *
 * Throws `AskLLMError` on any failure. There is no prose fallback by design;
 * the caller degrades to the quiet result.
 */
export async function composeAskWithLLM(
  input: AskComposeInput,
): Promise<AskComposition> {
  const query = input.query.trim();
  if (query.length === 0) {
    throw new AskLLMError('empty-text', 'composeAskWithLLM: query is blank');
  }
  if (input.parts.length === 0) {
    throw new AskLLMError('empty-text', 'composeAskWithLLM: parts is empty');
  }

  const wire: AskWireRequest = {
    query,
    parts: input.parts.map((p) => ({
      text: p.text,
      date: p.date,
      source: p.source,
    })),
    turns: (input.turns ?? []).map((t) => ({ query: t.query, answer: t.answer })),
    hard_topics: input.hardTopics ?? false,
  };

  const raw = await postAsk(wire);
  const { phrase_sources, answered } = raw;
  // Length-preserving pronoun repair BEFORE spans are located, so offsets are
  // computed against the prose that actually ships (see `lowercasePronounI`).
  const text = lowercasePronounI(raw.text);

  if (text.trim().length === 0) {
    throw new AskLLMError('empty-text', 'ml-services /voice-c-ask returned empty text');
  }

  // Offsets first — the voice check needs to know which regions are quotes
  // before it can decide which prose belongs to the model.
  const located = locateAskPhrases(text, phrase_sources);
  if (located.recovered > 0) {
    console.info(
      `[voice-c-ask] recovered ${located.recovered} phrase(s) by longest word run ` +
      `(the citation was copied from the passage, not from the answer)`,
    );
  }
  if (located.dropped.length > 0) {
    console.warn(
      `[voice-c-ask] dropped ${located.dropped.length} un-locatable phrase(s): ` +
      located.dropped.map((d) => JSON.stringify(d.phrase)).join(', '),
    );
  }
  const { kept, dropped: overlapping } = dropOverlappingSpans(located.spans);
  if (overlapping.length > 0) {
    console.warn(
      `[voice-c-ask] dropped ${overlapping.length} overlapping span(s) — ` +
      `an overlapped underline is an ambiguous tap target`,
    );
  }

  // The material the answer was allowed to draw names from, for the
  // proper-noun exemption in the lowercase rule.
  //
  // The CONVERSATION counts, not just this turn's excerpts. A follow-up
  // legitimately reuses a name the user already read in the previous answer:
  // asked "and what did i say i still hadn't answered?", the model correctly
  // said "Maya's question" — a name that came from the turn above, because this
  // turn's excerpts were retrieved for a differently-worded question and did
  // not happen to contain it. Checking only `parts` rejected a correct answer
  // and sent the ask quiet (caught live, 2026-08-25).
  const sourceMaterial = [
    // The question counts too: a name the user typed ("what did i say about
    // Priya?") is theirs to have written, and the answer must be able to say it
    // back.
    query,
    ...input.parts.map((p) => p.text),
    ...(input.turns ?? []).flatMap((t) => [t.query, t.answer]),
  ].join('\n');
  assertAskVoice(text, kept, sourceMaterial);

  return {
    text,
    annotations: kept.map((s) => ({
      start: s.start,
      end: s.end,
      source: { type: s.source.type, id: s.source.id },
    })),
    // Default TRUE only when the field is a real boolean; a malformed upstream
    // that omits it is treated as answered (the prose is still the model's best
    // answer), matching the pydantic default.
    answered: typeof answered === 'boolean' ? answered : true,
  };
}
