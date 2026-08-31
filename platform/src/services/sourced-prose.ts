/**
 * Sourced prose — grounded synthesis with provenance spans.
 *
 * EXTRACTED from `voice-c-composer.ts` before the iOS surface was stripped
 * (single-graph keep list §2.2 and §3: "extract the span-attribution pattern
 * first"). That module was the only implementation of grounded synthesis with
 * provenance in the repo, and the pattern is the useful half — the Voice-C
 * persona rules (lowercase, forbidden verbs, no system self-reference) were iOS
 * product copy and are NOT carried over.
 *
 * The idea: build prose by CONCATENATING PARTS rather than by generating text and
 * then trying to locate citations in it. Each part optionally names a source; the
 * span is recorded as the part is placed, so it is exact by construction — no
 * substring search, and no ambiguity when the same phrase appears twice. Then a
 * guard refuses to emit multi-sentence prose that carries no attribution at all.
 *
 * That guard is the load-bearing part for the Tier 0 / synthesis work. A
 * synthesiser that returns several sentences and cites nothing is the shape of an
 * ungrounded answer, and this makes it a thrown error rather than a plausible
 * paragraph.
 *
 * Offsets are UTF-16 code units, which is what JavaScript's `String.length`
 * counts natively — so no conversion is needed for any consumer that also counts
 * UTF-16 (browsers, Swift, .NET). A consumer counting Unicode scalar values or
 * bytes (Python, Rust, Go) must convert.
 *
 * Pure: no DB, no LLM, no I/O, no config.
 */

/** A source an emitted phrase is attributable to. `type` is caller-defined
 *  ('fact', 'entity', 'memory', 'causal_edge', …) — this module does not
 *  interpret it. */
export interface ProseSource {
  type: string;
  id: string;
}

/**
 * One unit of composition. `phrase` is emitted verbatim; when `source` is
 * present, a span pointing at exactly that phrase is produced.
 */
export interface ProsePart {
  phrase: string;
  source?: ProseSource;
}

/** Where a sourced phrase landed in the composed text. */
export interface ProseSpan {
  /** UTF-16 code-unit offset of the phrase start. */
  start: number;
  /** UTF-16 code-unit offset one past the phrase end. Always > start. */
  end: number;
  source: ProseSource;
}

export interface SourcedProse {
  text: string;
  spans: ProseSpan[];
}

export interface ComposeOptions {
  /**
   * Refuse to emit multi-sentence text with no spans at all (default true).
   *
   * Set false only for a caller that genuinely wants unattributed prose. The
   * default is the useful one: it turns "several sentences, no citations" into a
   * thrown error instead of an answer that reads as grounded and is not.
   */
  requireAttributionWhenMultiSentence?: boolean;
}

/** More than one sentence? Counts terminators followed by a boundary, so
 *  "3.4%" and "e.g." do not each read as a sentence end. */
function isMultiSentence(text: string): boolean {
  const matches = text.match(/[.!?…](\s|$)/g);
  return matches !== null && matches.length > 1;
}

/**
 * Compose `parts` into one string, recording a span for every part that names a
 * source.
 *
 * Separation: a single space is inserted between parts, except before a part
 * whose phrase opens with punctuation (so ", and" or "." attach cleanly).
 * Empty phrases contribute nothing, and an empty phrase that claims a source is
 * an error — its span would have `start === end`, which is not a location.
 */
export function composeSourcedProse(
  parts: ProsePart[],
  options: ComposeOptions = {},
): SourcedProse {
  const { requireAttributionWhenMultiSentence = true } = options;

  let text = '';
  // Record where each part landed AS IT IS PLACED. This is the whole point:
  // spans are exact by construction, so a phrase repeated later in the text
  // cannot steal an earlier part's span the way an indexOf() search would.
  const placed: Array<{ part: ProsePart; start: number }> = [];

  for (const part of parts) {
    const phrase = part.phrase;
    if (phrase.length === 0) {
      if (part.source) {
        throw new Error(
          'sourced prose: a sourced part has an empty phrase, so its span would have start === end',
        );
      }
      continue;
    }
    const startsWithPunct = /^[.,;:!?…]/.test(phrase);
    if (text.length > 0 && !startsWithPunct) text += ' ';
    placed.push({ part, start: text.length });
    text += phrase;
  }

  const spans: ProseSpan[] = [];
  for (const { part, start } of placed) {
    if (!part.source) continue;
    // 0 <= start < end: start by construction, end because empty phrases were
    // rejected above.
    spans.push({ start, end: start + part.phrase.length, source: part.source });
  }

  if (requireAttributionWhenMultiSentence && spans.length === 0 && isMultiSentence(text)) {
    throw new Error(
      `sourced prose: multi-sentence text with no attribution spans: ${JSON.stringify(text)}`,
    );
  }

  return { text, spans };
}

/**
 * Read back what a span points at. Exists so a caller can ASSERT that a span
 * still resolves to the phrase it claims — cheap, and the only way to catch an
 * offset convention mismatch at the boundary rather than in a consumer.
 */
export function sliceSpan(prose: SourcedProse, span: ProseSpan): string {
  return prose.text.slice(span.start, span.end);
}
