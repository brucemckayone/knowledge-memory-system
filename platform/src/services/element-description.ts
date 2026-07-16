/**
 * Element-description authoring convention — the code side (bead nmemo-uhp.17.1,
 * doc 13). This module is the SINGLE PLACE the convention lives, so the ingest
 * path (bead .17.3) and the Haiku authoring service (bead .17.2) can never drift
 * on how a cross-corpus code element's description is shaped.
 *
 * WHY this exists: doc 12 (nmemo-uhp.16) found the DOMINANT lever on cross-corpus
 * recall is the element DESCRIPTION content, not the retrieval algorithm — moving
 * from one-line prose to dense, keyword-informative "faceted" text is worth
 * ~+0.35 macro recall@5 on the constructed corpus, and retrieval fusion (bead .18)
 * cannot rescue plain prose. The adversary (doc 11/12) sharpened WHY: most of that
 * lift is LEXICAL — a dense MISRA-vocabulary description lands near keyword-dense
 * rule text by shared surface tokens. So the convention's job is to get the
 * standards' own vocabulary (memory, pointer, cast, ownership, lifetime, narrowing,
 * …) onto the code side of the vector, blind to any specific rule.
 *
 * The composition here is PURE (no DB, no ML, no config) and deterministic, so it
 * is trivially unit-testable and reproducible: given the same facets it always
 * emits the same string. The intelligence — reading the code and filling the
 * facets — is the authoring layer's job (bead .17.2); this file only renders.
 *
 * Byte-shape is pinned to the doc-11/12 bake-off `facets` formula that was actually
 * measured (recall-gate-artifacts/gate_code_formulas.json): labels in a fixed order
 * joined by "; ", with an optional trailing `concepts:` keyword list. Keeping the
 * shape identical means the convention's output stays on validated ground rather
 * than being a new, unmeasured formula.
 */

/**
 * The MISRA-aligned facet set for a code element. These are the dimensions a
 * safety-critical C/C++ coding standard cares about — authored BLIND to the rule
 * set (the author sees only the code + the generic "safety-critical C++" domain,
 * never a rule id or paraphrase; see doc 13 §blindness). Only `operation` is
 * required — it is the one facet every element has ("what does this do"); the rest
 * are included when the element actually exhibits them (a pure getter has no memory
 * or error-handling facet, and emitting an empty label would only add noise, not
 * keywords).
 */
export interface ElementFacets {
  /** Primary operation — what the element does. The one always-present facet. */
  operation: string;
  /** Concrete data + types touched (e.g. `std::from_chars_result`, `uint16_t`, out-params). */
  dataTypes?: string;
  /** Memory & raw-pointer behaviour (casts, aliasing, allocation, pointer arithmetic). */
  memoryPointers?: string;
  /** Ownership & lifetime (who owns/borrows/moves, non-owning views, dangling risk). */
  ownershipLifetime?: string;
  /** Observable side effects (writes through out-params, I/O, global/member state). */
  sideEffects?: string;
  /** Error handling (checks, exceptions, `noexcept`, error codes, UB on failure). */
  errorHandling?: string;
  /**
   * Salient technical concepts — a dense keyword list (e.g. `reinterpret_cast`,
   * `pointer aliasing`, `RAII`, `narrowing`). NEVER rule ids or names. This is the
   * `concepts` formula from the bake-off, folded in as the keyword-surface tail.
   */
  concepts?: string[];
}

/**
 * The canonical facet render order + labels, pinned to the measured bake-off shape
 * (gate_code_formulas.json). Exported so the doc-13 convention, the authoring
 * prompt (bead .17.2), and tests all reference ONE source of truth for the labels.
 */
export const FACET_LABELS: ReadonlyArray<readonly [keyof ElementFacets, string]> = [
  ['operation', 'operation'],
  ['dataTypes', 'data/types'],
  ['memoryPointers', 'memory/pointers'],
  ['ownershipLifetime', 'ownership/lifetime'],
  ['sideEffects', 'side-effects'],
  ['errorHandling', 'error-handling'],
] as const;

/**
 * The target-corpus (rule) side of the convention. A rule element's description is
 * the doc-11 `richer` formula: expanded rationale plus the typical code shapes that
 * trigger the rule, authored BLIND to the code corpus (from the guideline text
 * alone). Shape mirrors the measured `richer` blob — prose sentences, with an
 * optional keyword tail.
 */
export interface RuleDescriptionParts {
  /** Why the rule exists — what it forbids or requires (expanded rationale). **required** */
  rationale: string;
  /** The typical code shapes that trigger/relate to the rule (prose, e.g. "Watch for …"). */
  watchFor?: string;
  /** Salient concepts — a dense keyword list (no other rule ids). */
  concepts?: string[];
}

/**
 * Render {@link RuleDescriptionParts} to the canonical rule description string:
 * `<rationale> <watchFor> concepts: a, b, c`. PURE + deterministic. Sentences are
 * space-joined (they already carry terminal punctuation); the concepts tail is
 * appended labelled. Returns `''` when nothing carries content (safe name-only
 * degrade, same contract as {@link composeFacetedDescription}).
 */
export function composeRuleDescription(parts: RuleDescriptionParts): string {
  const segments: string[] = [];
  const rationale = parts.rationale?.trim();
  if (rationale) segments.push(rationale);
  const watchFor = parts.watchFor?.trim();
  if (watchFor) segments.push(watchFor);
  const concepts = dedupePreserveOrder(
    (parts.concepts ?? []).map((c) => c.trim()).filter((c) => c.length > 0),
  );
  if (concepts.length > 0) segments.push(`concepts: ${concepts.join(', ')}`);
  return segments.join(' ');
}

/**
 * Detect references to a coding standard, rule id, or guideline in authored text —
 * the blindness guard (doc 13 §4). A code-side description must be authored BLIND to
 * the rule set; if the model leaked a specific rule id or standard name, a match here
 * is circular. This is a VISIBILITY tool, not a scrubber: it never mutates the text
 * (silently stripping leakage would only hide it from the acceptance gate). Callers
 * log/surface the hits; the acceptance gate (bead .17.4) asserts the list is empty.
 *
 * PURE. Returns the distinct matched substrings (case-preserving), empty when clean.
 * Catches: standard names (MISRA, CERT, AUTOSAR, JSF, C++ Core Guidelines); "rule N"
 * / "guideline N"; and dotted rule ids — CppCoreGuidelines style (`F.16`, `ES.20`,
 * `C.48`) and MISRA numeric (`21.18`, `5-1-1`).
 */
export function detectRuleReferences(text: string): string[] {
  if (!text) return [];
  const patterns: RegExp[] = [
    /\bMISRA\b/gi,
    /\bCERT\b/gi,
    /\bAUTOSAR\b/gi,
    /\bJSF\b/gi,
    /\bC\+\+\s*Core\s*Guidelines?\b/gi,
    /\bCppCoreGuidelines?\b/gi,
    /\b(?:rule|guideline)s?\s+[A-Za-z]?\.?\d[\w.\-]*/gi,
    /\b[A-Z]{1,3}\.\d+(?:\.\d+)*\b/g, // F.16, ES.20, C.48
    /\b\d+(?:[.\-]\d+)+\b/g, // 21.18, 5-1-1
  ];
  const hits = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) hits.add(m[0]);
  }
  return [...hits];
}

/** Case-insensitive de-dup that preserves first-seen order (keeps the keyword tail clean). */
function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Render {@link ElementFacets} to the canonical dense description string.
 *
 *   `operation: …; data/types: …; memory/pointers: …; ownership/lifetime: …;
 *    side-effects: …; error-handling: …; concepts: a, b, c`
 *
 * PURE + deterministic. Blank/absent facets are skipped (label included only when
 * its value is non-empty). `concepts` is trimmed, blank-filtered, and de-duped, then
 * appended as a comma list. Returns `''` when no facet carries content — a caller
 * that stores that as an entity description degrades safely to name-only embedding
 * (entityEmbedTextFor falls back to the name on a blank description), i.e. the
 * pre-.14 behaviour, never an error.
 */
export function composeFacetedDescription(facets: ElementFacets): string {
  const parts: string[] = [];
  for (const [key, label] of FACET_LABELS) {
    const value = facets[key];
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) parts.push(`${label}: ${text}`);
  }
  const concepts = dedupePreserveOrder(
    (facets.concepts ?? []).map((c) => c.trim()).filter((c) => c.length > 0),
  );
  if (concepts.length > 0) parts.push(`concepts: ${concepts.join(', ')}`);
  return parts.join('; ');
}
