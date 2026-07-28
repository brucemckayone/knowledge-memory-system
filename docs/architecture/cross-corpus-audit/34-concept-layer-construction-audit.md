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

---

## 7. Extractor probe (2026-07-28) — the corpus choice, decided by measurement not preference

§6 step 1 says "ingest through the real extraction path." That path is a **prose** entity/
relationship extractor, and nobody had checked what it does with C++ or with normative rule text.
Building the first multi-hop graph on a corpus the extractor cannot read would produce an
uninterpretable result — the exact failure mode this doc exists to prevent. So: an inspection first
(harness `platform/src/test/tools/extractor-probe.ts`, artifacts `sweep-coverage-artifacts/
extractor-probe.json`). No bar, no claim.

| input | entities/doc | facts/doc |
|---|---|---|
| doc-20 C++ code snippets | **0.0** | **0.0** |
| doc-20 rule texts (C++ Core Guidelines) | **0.0** | **0.0** |
| arXiv abstracts (corpus-A) | 6.8 | 3.0 |

**Code and rules yield literally nothing.** The production extractor returns zero entities from a
C++ snippet and zero from a guideline sentence. So doc-20's corpus **cannot** be turned into an
entity+fact graph by this path at all; real code structure needs Phase C (SCIP/tree-sitter,
`nmemo-uhp.13`).

Abstracts work, and the facts are genuinely traversable — e.g. `BLIP-2 --outperforms--> Flamingo80B`,
`BLIP-2 --evaluated_on--> VQAv2`, `Flamingo80B --evaluated_on--> VQAv2`, `LLaVA --fine_tuned_on-->
Science QA`. Note the third: two papers' entities meeting at a shared benchmark node is precisely the
multi-hop path the architecture needs.

**Decision: arXiv abstracts** (`arxiv-nlp` / `arxiv-cv`). Chosen by the probe, against my stated
prior only in the sense that the probe made it non-optional.

**The cost of that choice, stated plainly:** it forfeits the good oracle. doc-20's clang-tidy oracle
is external and concept-independent; the arXiv oracle is co-citation, which doc-30's adversary showed
is ~79% cosine-predictable (AUC 0.79) and therefore only partially independent of embedding. doc-31's
text-dissimilar slice (cos<0.615) remains available as the hard subset. Any multi-hop result must
carry that limitation — it is a weaker oracle than the one we are unable to use.

Two probe caveats: entity **types** are memory-domain (`project`, `other`), carrying no scientific
signal; and the endpoint returns **mentions**, so one abstract yielded `GPT-4` six times — canonical
dedup happens later in promotion.

### 7.1 Pilot through the real path (4 docs)

With corpus-scoped promotion in place (commit `dcfcfb8`), 4 abstracts through
`ingestBatch(mode:'epoch', corpusId:'arxiv-nlp')` produced **12 canonical entities and 57 facts** —
~14 facts/doc, far richer than the probe's raw-endpoint 3.0, because the epoch path runs the unified
graph agent rather than the two bare endpoints. The causal pass also fired, promoting 10 causal edges.

The graph branches: `minigpt-4` degree 20, `gpt-4` 17, `blip-2` 13, and real chains exist
(`llava --trained_on_data_from--> gpt-4 --built_by--> openai`). This is the first time in this
investigation that a corpus in this system has had traversable internal structure.

### 7.2 Setup state (2026-07-28) — built, blocked, and what remains

**Built and committed:**

1. **Corpus-scoped promotion** (`dcfcfb8`) — `applyPromotion` stamps `corpus_id` on minted entities
   and inserted facts, and the entity reuse-by-name lookup is corpus-filtered (it was an unscoped
   cross-corpus fusion path). Threaded `promote({corpusId})` → `loadPromotionInputs` +
   `applyPromotion`, and `ingestBatch({corpusId})` → `runEpochBatch`. Only the `epoch` arm honours it;
   the others throw rather than silently writing to `default`. 3 regression tests; 21/21 + 33/33 green.
2. **Domain-neutral concept extraction** (`c631f82`) — a `side:'entity'` branch (the C/C++ prompts
   return zero concepts on prose), an explicit `relation` (for a symmetric corpus pair the relation
   carries direction, not semantics), and an optional **shared-vocabulary block** — the docs 25-27
   relevance-window conform mechanism, owed since doc-20 §13(d). Additive: omit `vocabulary` and the
   prompt is byte-identical.
3. **Resumable ingest harness** `corpus-graph-ingest.ts`, with a ledger/DB drift guard.

**Doc attribution — solved, design validated (not yet implemented):** the epoch path writes **no**
`memory_entities` and **no** `fact_sources` (both 0 for the ingested corpus) — another gap of the same
class as the 0-facts one, and it breaks the "tagged to source material" leg. But attribution is
recoverable without schema change, because `promote()` does not delete consumed staging:

```
canonical fact --(facts.source_text = staging_proposed_facts.reasoning)--> staged fact
staged fact --(source_id, chunk_index)--> windowPointId() --> Qdrant memory --> content --> paper id
entity --> its facts --> those papers
```

Measured on real data: **587/587 canonical facts matched a staged fact**, only **9 ambiguous** (1.5%,
and those are legitimately multi-paper). `chunk_index` confirmed 10 distinct values = the batch size.
Content matching (rather than trusting my batch ordering) is what makes it robust.

**BLOCKED:** the ingest is incomplete. The graph agent runs Haiku via `claude -p`, and the run hit the
account limit — HTTP 429, `"You've hit your session limit · resets 2:50pm (Europe/London)"`. Not a code
fault. Two process faults of mine, both recorded rather than smoothed over: (a) I piped `tsx` through
`grep`, so `&&` saw **grep's** exit code and corpus B launched after corpus A had already failed;
(b) an earlier killed run had ingested a batch before I deleted its ledger, so ~24 docs may have been
ingested twice. Promotion's corroborate-or-insert makes that mostly idempotent, but I could not cheaply
prove the base was clean at 24/294 docs, so both corpora were **wiped for a clean restart**. The doc-20
substrate (104 concepts / 97 exhibits / 51 addresses) was verified intact afterwards.

**Resume (after the limit resets) — note: no pipe, so failures propagate:**

```
cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
  QDRANT_URL=http://localhost:6335 ML_SERVICES_URL=http://localhost:8000 \
  NODE_ENV=test EMBED_DESCRIPTIONS=true \
  npx tsx src/test/tools/corpus-graph-ingest.ts --corpus=A --batch=10 --concurrency=8
```
then `--corpus=B`. Ledger-resumable; ~1 min/doc observed, so ~5 h for 294 docs.

**Remaining after ingest completes** (steps 3-4 need no LLM; step 2 does):
1. Concept-link every arXiv entity via `extractAndLinkConcepts({side:'entity', relation, vocabulary})`
   — corpus A `exhibits`, corpus B `addresses`, so the shipped `recallConceptCandidates` JOIN works
   unchanged. Maintain concept embeddings so the vocabulary window is nearest-neighbour, and build the
   window **only** from concepts linked to the arXiv corpora (the 104 C++ concepts from doc-20 share
   `_concepts` and would otherwise pollute it).
2. Implement the doc-attribution mapper per the validated chain above.
3. Build the **multi-hop recall primitive** — the thing that does not exist. Proposed shape:
   `source entity --facts*(≤h)--> entity --exhibits--> concept <--addresses-- entity --facts*(≤h)--> target`,
   scored `Σ_c idf(c) · decay^(hops_source + hops_target)`. The decay/IDF **is** the path-cost rule
   §5 warns is mandatory; without it traversal reaches everything.
4. Pre-register the test (metric + bar committed before any number) and score on the co-citation oracle,
   with doc-31's text-dissimilar slice as the hard subset, carrying §7's oracle caveat.

Observations carried forward: (a) `fact_embedding` was NULL until `EMBED_DESCRIPTIONS=true` (doc-10
already justified `on` as the cross-corpus default), so the pilot was discarded and both corpora
re-ingested with it enabled, for consistency; (b) `store()` creates a `User (stream default)` speaker
anchor in corpus `default` — inert here, since mig 052 pins facts to their own corpus, but a fact
attributed to the speaker inside a corpus-scoped epoch would be rejected 23503; the harness fails
loud and does not mark such a batch done; (c) AGE emits a non-fatal `causal_graph does not exist`
warning on this DB — known drift, unrelated.
