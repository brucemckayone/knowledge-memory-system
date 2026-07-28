# Doc 34 — Concept-layer construction audit: what is actually in the graph, and what that scopes our negatives down to

**Status:** AUDIT (2026-07-28). Not an experiment — no bar, no claim, no adversary needed. Every number
below is a direct query against the doc-20 graph in `cognitive_test` or a read of shipped code, cited
so each is independently re-checkable.

**Why this exists:** doc-33 passed its bars at the weakest grade and turned up a 4-of-104 pivot ceiling.
Pushed on whether the concept layer is *well constructed*, the answer is no — and one of the deficits
means the entire doc-20 → doc-33 experiment series measured a degenerate case of the architecture
rather than the architecture. That needs recording before any further experiment is designed.

---

## 1. What the concept layer actually is

Queried on the doc-20 graph (29 code + 27 rule elements, 104 concepts, 97 `exhibits` + 51 `addresses`):

| property | value |
|---|---|
| concept nodes | 104 |
| …with a `description` | **0** |
| …with an `embedding` | **0** |
| concepts of degree 1 (touch one element, nothing else) | **83 of 104** |
| max concept degree | 7 |
| `exhibits` edges per code element | 3.34 |
| `addresses` edges per rule | 1.89 |
| live `bridge_edges` relations present anywhere | `exhibits`, `addresses` only |
| **facts in `cj-code` / `cj-rules`** | **0** |
| fact-writing calls in `corpus-ingest.ts` | **0** |

Concepts are bare strings. `findOrCreateConcept` even documents it — *"Created without an embedding —
.22 backfills it"* — and that backfill is not present in this graph. So `resolveConcepts` has nothing
to work with but `pg_trgm` similarity over names.

80% of the concept vocabulary is a dangling leaf: it connects one element to nothing.

## 2. Deficit A — the register mismatch (why only 4 pivots survive)

Splitting the 104 concepts by which side touches them: **55 code-only, 45 rule-only, 4 both.**

The two sides are not using different words for the same mechanism. They are naming **different kinds
of thing**:

- **Code-side** names *what is literally present*: `constexpr-constant`, `floating-point-literal`,
  `header-inclusion`, `eof-loop`, `explicit-type-casting`, `inline-variable`.
- **Rule-side** names *what could go wrong, or what property must hold*: `lossy-conversion`,
  `magic-constant`, `implicit-fallthrough`, `bounds-checking`, `exclusive-ownership`,
  `guaranteed-iteration`.

`floating-point-literal` and `magic-constant` are the same situation named one level apart —
**construct** versus **hazard**. No synonym resolver *should* merge them; they are not synonyms. One is
a thing, the other is a predicate about that thing. A trigram threshold was never going to bridge it,
and neither would a perfect synonym resolver.

This predicts the survivors exactly. The 4 both-sided pivots are `pointer-arithmetic`,
`preprocessor-macro`, `const-reference-parameter`, `const-member-variable` — **every one a case where
the rule text happens to name the construct itself rather than a hazard.** The JOIN fires only when a
rule is written in construct language. That is the whole of the 4-of-104 ceiling doc-33 measured.

## 3. Deficit B — depth is structurally 1, which scopes every prior negative

The intended architecture (user-stated, and consistent with doc 04/19): concepts form a shared
super-graph above mutually-separate corpora; each corpus is an entity+fact graph from ingestion;
a concept attaches to N entities and **traversal continues through entities and facts** to
source-tagged material. Corpora meet only through the super-graph.

The substrate supports all of this. `facts` carries `corpus_id`, `fact_embedding`, subject/object
entity FKs; there is a predicate ontology, `fact_sources`, and AGE traversal. There are 140 facts in
this same database under corpus `default`.

**`corpus-ingest.ts` uses none of it.** It writes bare entities via `upsertCorpusElementEntity` and
never writes a fact. So a concept lands on an entity and traversal **stops dead** — there is nowhere
to go. Depth is not shallow by tuning; it is structurally 1.

**Consequence, and it is the main point of this audit:** doc-20, doc-28, doc-29, doc-30, doc-31,
doc-32 and doc-33 all measured **single-hop shared-label coincidence over a flat set of disconnected
entities**. The arXiv arc (28–32) had no entity graph whatsoever — it was label overlap on abstracts.

So what those runs refuted is: *"do two flat corpora happen to share an identical concept label."*
What they did **not** test is: *"can a concept index into per-corpus entity graphs and walk to relevant
source material."*

**This narrows the scope of the negatives. It supplies no positive evidence for the multi-hop version,
which remains untested rather than vindicated.** Stated explicitly because this is the direction that
flatters the architecture, and this project has a documented pattern of drifting toward the favourable
reading ([[verify-empirical-gates]], 7 launder-catches).

## 4. Correction to a carried assumption (mine)

`project-cross-corpus-linker` memory recorded, verbatim:

> "No fact/edge traversal (the code corpus is flat entities+descriptions; `corpus-ingest.ts` writes NO
> facts). 'Graph-mediated recall via fact traversal' is NOT the architecture — don't re-invent it as a
> strawman."

That took a **build limitation** and recorded it as **design intent**. It is why every subsequent
experiment I proposed was single-hop, and why I reached for concept↔concept edges as the missing
primitive when the actual gap is depth through entities and facts. The memory entry is corrected in the
same session as this doc.

## 5. The two walls already hit, and why depth is the resolution

Both failure modes of a *flat* concept space are now empirically banked:

- **Too sparse** (doc-33): 83 hapax leaves, 4 usable pivots → no reach.
- **Too dense** (doc-32): 33 concepts/doc, and the shared nodes became generic hubs
  (`representation-learning` df=21, `large-language-models` df=45) → reach up marginally, **discrimination
  down** (JOIN AUC 0.579 < sparse 0.596 < bar 0.63).

Flat breadth is a trap in both directions: more labels per element buys hubs, fewer buys leaves. The
escape is not density but **depth** — with a path from a specific construct to a general hazard, the
generality lives in the *edge* rather than in the label, so neither endpoint has to become a hub. Depth
also dissolves §2's register mismatch without merging anything: `floating-point-literal` need not
*equal* `magic-constant` if it can reach it.

**Engineering warning to carry into any depth work:** unbounded traversal from a concept reaches nearly
everything (the god-object / hub-bloat risk doc-08 already flagged, and the mirror of doc-32's hub
failure). **Depth without path scoring or a stopping rule is as useless as breadth without reach.** A
first version needs a notion of path cost or specificity weighting, not merely the ability to walk.

## 6. What to build/test next (not pre-registered here — this doc claims nothing)

1. **Ingest the corpora through the real extraction path** so each corpus is entities *and* facts, not
   a flat entity list. This is the precondition for everything else; without it there is no graph to
   traverse and no further concept experiment is meaningful.
2. **Give concepts content** — descriptions and embeddings (the documented-but-absent `.22` backfill),
   so resolution is not trigram-on-names.
3. **Then** the multi-hop question becomes testable: concept → its entities across corpora → walk facts
   → source-tagged neighbours, with a path-cost rule, measured against doc-20's external clang-tidy
   oracle on the doc-33 sweep metric (coverage + cells, not recall@k).
4. Cheap deterministic pre-check available before any of that: does the both-sides reachable set rise
   above 4 of 104 once a construct→hazard relation exists? If not, the idea dies cheaply.

Anything measured before step 1 re-measures the degenerate case.
