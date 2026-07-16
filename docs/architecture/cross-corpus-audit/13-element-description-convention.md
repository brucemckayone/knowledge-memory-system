# Doc 13 — Element-description authoring convention

**Status:** CONVENTION (bead nmemo-uhp.17). Turns the doc-10/11/12 findings into a
concrete authoring rule + one place in code that rule lives.

Docs 10–12 measured *what* description text lifts cross-corpus recall. This doc says
*how* the ingest path should author it, and records what that lift does and does not
license.

## 1. The finding this encodes

- **Doc 10** (recall-lift gate): embedding an authored description alongside the name
  lifts cross-corpus recall over name-only. Built as the `EMBED_DESCRIPTIONS` lever
  (nmemo-uhp.14).
- **Doc 11** (formula bake-off): the description *content* matters far more than style.
  Dense, keyword-informative text (a fixed MISRA-aligned facet template, or a dense
  concept-keyword list) beats one-line prose by ~+0.35 macro recall@5 on the
  constructed corpus.
- **Doc 12** (hybrid retrieval): the description is the dominant lever; retrieval
  fusion (BM25 + vector, bead nmemo-uhp.18) adds at most ~+0.1 *on top of* good
  descriptions and cannot rescue plain prose (H2 negative, bootstrap CI excludes 0).

So: **descriptions first, retrieval second.** This doc is the "descriptions first" half.

## 2. Why it works — and the honest caveat

The adversary (doc 11/12) showed most of the lift is **lexical**, not semantic: a dense
MISRA-vocabulary description lands near keyword-dense rule text because they share
surface tokens (memory, pointer, cast, ownership, lifetime, narrowing, …). The
embedding's genuine semantic contribution shows on prose, where surface tokens don't
align; on keyword-dense text a plain keyword search would match nearly as well.

That is fine for this use case — getting the standards' own vocabulary onto the code
side of the vector is exactly the goal — but it means:

- The convention's job is **vocabulary coverage**, not eloquence. Author the concepts
  a standard reasons about, in the standard's own words.
- The absolute recall numbers are a **constructed-corpus FLOOR** (opaque dotted-ID
  rule names, n=29 / ~9 guidelines, a checker-decidable slice). The *ranking*
  (faceted ≫ prose) transfers; the magnitudes do not. **No coverage or automation
  claim until a field-prevalence real-code run.**

## 3. The convention

When the ingest path authors a **code element's** description (bead nmemo-uhp.17.3),
produce a dense, faceted string over these dimensions, in this order:

| facet | what to write |
|---|---|
| `operation` | what the element does — the primary operation (**required**) |
| `data/types` | concrete data + types touched (signatures, out-params, containers) |
| `memory/pointers` | raw-pointer / memory behaviour (casts, aliasing, allocation, arithmetic) |
| `ownership/lifetime` | who owns / borrows / moves; non-owning views; dangling risk |
| `side-effects` | writes through out-params, I/O, global / member state |
| `error-handling` | checks, exceptions, `noexcept`, error codes, UB on failure |
| `concepts` | dense keyword list of salient technical concepts (comma-separated) |

Rendered by `composeFacetedDescription` (`platform/src/services/element-description.ts`)
as:

```
operation: …; data/types: …; memory/pointers: …; ownership/lifetime: …;
side-effects: …; error-handling: …; concepts: a, b, c
```

Rules:

1. **Only `operation` is required.** Facets an element doesn't exhibit (a pure getter
   has no memory or error-handling facet) are omitted — an empty label adds noise, not
   keywords. An all-blank facet set renders `''`, which degrades safely to name-only
   embedding (the pre-.14 behaviour), never an error.
2. **Keyword-informative, not prose.** Prefer the standard's nouns (`reinterpret_cast`,
   `pointer aliasing`, `RAII`, `narrowing conversion`, `out-parameter`) over narrative.
3. **NOT one-line prose.** A single sentence of what the function does is the *baseline*
   this convention beats, not the target.

For a **rule element's** description (the target-corpus side), author the expanded
rationale plus the typical code shapes that trigger the rule (the doc-11 `richer`
formula) — same keyword-informative principle, from the guideline's own text.

## 4. Blindness discipline (load-bearing)

The dense facets are the most likely place to smuggle in leakage. To keep a match
honest:

- **Author code descriptions BLIND to the rule set.** The author (the Haiku service,
  bead .17.2) sees only the code + the generic "safety-critical C++" domain — never a
  rule id, never a paraphrase of a specific rule. Extracting "memory / pointer / cast /
  lifetime" concepts *from the code* is fair (standards are about those code concepts);
  naming or paraphrasing a specific rule is not.
- **Author rule descriptions BLIND to the code corpus** — from the guideline text
  alone, so they can't be tuned to the code being matched.
- The acceptance gate (bead .17.4) re-runs the doc-10/11 leakage battery on the
  authored descriptions before any claim: per-item token overlap with the true rule vs
  other rules, and a scan for rule ids / jargon.

## 5. Where it lives

- **`platform/src/services/element-description.ts`** — the facet schema
  (`ElementFacets`), the fixed label order (`FACET_LABELS`), and the pure
  `composeFacetedDescription` renderer. One source of truth; the authoring service and
  ingest path both import it.
- **Authoring** (bead .17.2) — a Haiku call fills the facets from the code, blind to
  rules; `composeFacetedDescription` renders them.
- **Ingest** (bead .17.3) — the rendered description is stored as the entity's
  `description` and embedded via `entityEmbedTextFor` under `EMBED_DESCRIPTIONS` (the
  vector cross-corpus recall reads, audit-pass.ts).
- **Acceptance** (bead .17.4) — a held-out, pre-registered recall-lift proof with a
  blind adversary before any claim.

## 6. What this convention does and does NOT license

- **Licenses:** authoring cross-corpus element descriptions as dense faceted text
  rather than one-line prose, and the claim "faceted descriptions beat plain prose for
  recall on this constructed corpus" (once bead .17.4's held-out gate passes).
- **Does NOT license:** a field-magnitude recall number, that this facet set is
  globally optimal (a few formulas were tested), or any adjudication / precision /
  autonomous-auditor claim. Retrieval fusion (bead .18) is a complement, not a
  substitute, and is gated separately.
