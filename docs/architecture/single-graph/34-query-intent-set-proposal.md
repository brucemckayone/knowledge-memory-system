# 34 — Query-intent set (COMMITTED) + benchmark mapping — Phase 2 of nmemo-asf

**Status: COMMITTED 2026-09-02** (user product-fit check passed). Final set = **I1–I5 as proposed**;
priority = **I3 → I1 → I2 → I4 → I5** (recommended, confirmed). The set remains a **PROXY for real usage,
not validated ground truth** (no real users/queries yet — the proxy caveat below still binds). See
"The human decision (recorded)" at the end for the answer verbatim and the one framing addition it produced
(a composite-reasoning layer that is *agent-composed over the five primitives*, not a sixth substrate).

Per the doc-32 correction: the model proposed this set (from the vision + doc-31 literature + the benchmarks
that already encode intents); the human role was a product-fit sanity check + prioritisation, not authoring.
Committing unlocks Phase 3/4.

## The proposed intents
This is a memory/knowledge-graph system (CLAUDE.md), queried by an agent over MCP. Five intents cover what an
agent asks such a graph, from cheapest/most-central to hardest:

### I1 — Point lookup / "what is X" (local, specific)
- **Example queries:** "what is entity X", "find the fact where X <predicate> ?", "recall what we know about X".
- **Substrate:** dense fusion (name⊕fact) **+ a lexical/BM25 index** for exact terms/identifiers. (doc 31)
- **Benchmark:** BEIR-style IR + our target-finding harness, but on **real queries** (not papers-as-queries).
  nmemo-bki: **LongMemEval / LOCOMO** (recall over memory).
- **Ground truth:** ranked relevance (clean).
- **Current fit:** fusion HAVE (proven, R4); **lexical index MISSING**; real-query eval MISSING.

> **UPDATE (2026-09-17 — doc 46, pending adversary).** The "lexical index MISSING" item is now backed by a
> **measured gain, not just literature**. Adding **BM25 over `facts.source_text`, MAX-aggregated to
> entities**, as a THIRD signal to the R4 fusion clears the house DEMONSTRATED bar on **both** corpus
> pairs: `L3 − FACTNAME` = **+0.0763 (dal)** and **+0.0801 (arxiv)** strict R@10, above 0 on all three
> bootstraps in both, with **all four corpora improving**; total gain over name-only is +0.1186 / +0.1525,
> roughly **double R4's own +0.0724**. Validations: the ARM-NAME regression gate passes exactly, R4
> reproduces its banked +0.0724 on arxiv, and doc 12's tie reproduces on dal. Survives leak-hardening.
> **Mechanism is narrower than the headline:** swapping the lexical component to entity *names* is not
> distinguishable in the three-way (`L3 − L3n` spans 0 both pairs), so the claim is **"add a lexical
> substrate,"** not "fact text specifically" — though in the two-way, fact text wins decisively
> (`L2 − H60` above 0 on all three bootstraps in both pairs). **`L2` = RRF-60(dense-names, BM25-over-fact-
> text) needs NO fact embeddings at all** and still beats R4, so it is cheaper than the current read path.
> Standing caveats: papers-as-queries proxy, strict metric only, deltas-not-levels. Also **retracted
> there**: docs 44/45's "lexical beats dense at fact level" does NOT generalise — `BM25f − FACTMAX` flips
> sign across corpus pairs.

### I2 — Relational / multi-hop ("how are X and Y connected", "A→B→C")
- **Example queries:** "what connects X and Y", "what did X influence that influenced Z".
- **Substrate:** canonicalized traversable graph, typed edges (or PPR). (doc 31)
- **Benchmark:** **2WikiMultiHop / HotpotQA / MuSiQue** (what HippoRAG uses). nmemo-bki: partly **GraphRAG-Bench**.
- **Ground truth:** clean (answer + supporting facts).
- **Current fit:** traversal HAVE (needs corpus scoping + canonicalization); `.6` was negative *on our
  fact-finding task* — this re-tests it in its home regime.

### I3 — Temporal / as-of-state ("what did we know as of D", "what changed")
- **Example queries:** "state of X on date D", "what changed about X between D1 and D2", "latest vs superseded".
- **Substrate:** **bi-temporal facts** (valid-time + transaction-time; supersede not overwrite). (doc 31, Zep)
- **Benchmark:** **CronQA / ChronoQA**; nmemo-bki: **CronQA** ("cleanest direct test of bi-temporal facts"),
  LongMemEval (temporal reasoning).
- **Ground truth:** clean.
- **Current fit:** **HAVE** — Graph S facts are already bi-temporal (`valid_at`/`invalid_at`/`expired_at`),
  and this has **never been evaluated for retrieval**. Cheapest high-information win.

### I4 — Causal / explanatory ("what caused X", "why", "what if")
- **Example queries:** "what caused X", "why did Y happen", "what would changing X affect".
- **Substrate:** Graph C explicit cause→effect edges + mandatory provenance. (doc 31)
- **Benchmark:** **Corr2Cause / CLadder** (nmemo-bki, bead `nmemo-4fd`) — note these test causal *reasoning*,
  the "is Graph C real or theatre" question, more than causal *retrieval*.
- **Ground truth:** clean for the reasoning question.
- **Current fit:** substrate only on **dal-cv (521 edges)** and default; **arxiv has none, qbio 0.7%** (doc
  33). Runs on dal-cv, not arxiv. Edges not corpus-partitioned (a fix). Never evaluated.

> **CORRECTIONS OF RECORD (2026-09-17 — docs 44/45, both adversary-reviewed).**
> 1. **The Corr2Cause / CLadder plan is WITHDRAWN as INVALID.** Both are verified **100% self-contained in
>    the prompt** (CLadder's own text: all causal structures and probabilities are supplied per item, no
>    external retrieval required; Corr2Cause premises are abstract letters — *"Suppose there is a closed
>    system of 3 variables, A, B and C…"*). There is nothing to retrieve, so the graph cannot contribute,
>    and `docs/benchmarks/plan.md:157`'s design (ingest the question's own preamble, then ask the question)
>    is **storing the answer key and reading it back**. Both datasets are additionally *engineered* to be
>    retrieval-proof. Two further defects: variables are literally `A`/`B`/`C` so every item's "A" collides
>    onto one node (CLadder reuses 10 graph structures across hundreds of items with **opposite gold
>    answers**), and the fact-count trigger would fire on nearly every item, spending 1.1k-10k agentic
>    calls building contaminating edges. Corr2Cause's eval split is **1,162 items**, not the "200K+" in
>    `plan.md:151` (that is the *train* split: 205,734/1,076/1,162). See `scratch-asf-i4-benchmarks.md`.
> 2. **Per-corpus figures above are STALE** (see the correction in doc 33 §4): truth is dal-cv 521 ·
>    **dal-nlp 454** · qbio 51 · **arxiv-nlp 17** · arxiv-cv 0 · **default 0**.
> 3. **"Edges not corpus-partitioned" is true of the table but is NOT a read-path blocker** — `traceCauses`
>    scopes via `causal_events.corpus_id`, which is populated on all 17,847 events.
> 4. **"Never evaluated" is now false.** Doc 44 (pass-through) and doc 45 (asymmetric re-rank) both
>    evaluated it; both returned **nulls**. Graph C is well-built provenance infrastructure (1043/1043
>    distinct reasoning strings, 99.83% resolving references, ~100% source_text on cited facts vs 5.20%
>    graph-wide) but **structurally thin as a retrieval substrate**: 86.3% of answerable effects are
>    single-hop, largest connected component 7 nodes, `event_embedding` NULL on all 17,847 and read by
>    nothing, every entry point keyed by id not query, `temporal_span` NULL on all 1043 (so the I4×I3
>    composite has no substrate). **I4-as-retrieval is open and unresolved**; the direction-blindness route
>    is closed (doc 45).
> 5. **There is no valid external oracle** for cross-document causal retrieval — MAVEN-ERE's own
>    Limitations section says the field has none, EventStoryLine's gold is not causality (`PLOT_LINK` is
>    "a loose causal and temporal relation"; explicit causality is set on only 117/5,625 pairs), and the
>    area's critique paper requires benchmarks be *"non-retrievable."*

### I5 — Global / thematic / sensemaking ("main themes", "summarize area Z")
- **Example queries:** "what are the main themes across the corpus", "summarize what we know about Z".
- **Substrate:** Leiden communities **+ LLM community summaries** at each level. (doc 31, GraphRAG global)
- **Benchmark:** **GraphRAG-Bench** (nmemo-bki).
- **Ground truth:** **LLM-judged (no clean oracle)** — the hard one; sequence last.
- **Current fit:** **MISSING** — `community_id` computed but viz-only, no summaries; `.8` deterministic-centroid
  routing was negative (leak). Requires an LLM summarization pass at ingest.

## Benchmark reconciliation with `nmemo-bki`
`nmemo-bki` already scoped: LongMemEval, Corr2Cause+CLadder, LOCOMO, GraphRAG-Bench, CronQA — which cover
**I1 (LongMemEval/LOCOMO), I3 (CronQA/LongMemEval), I4 (Corr2Cause/CLadder), I5 (GraphRAG-Bench)**. The one
gap is **I2 multi-hop's cleanest benchmarks** (2WikiMultiHop/HotpotQA/MuSiQue) — GraphRAG-Bench partly
covers it, but adding a standard multi-hop set is the honest test. **So `nmemo-bki` becomes the Phase-3
harness work for this epic** rather than a separate track; the two unify.

## Recommended priority (for your sanity check)
| # | Intent | Why this rank |
|---|---|---|
| 1 | **I3 Temporal** | substrate already built + never evaluated + clean benchmark + central to a *memory* system = cheapest high-information win |
| 2 | **I1 Local** | the base case; proven fusion, just needs a lexical index + a real-query eval (also fixes the papers-as-queries validity gap) |
| 3 | **I2 Multi-hop** | clean ground-truth benchmark; re-tests `.6` in its home regime; substrate mostly present |
| 4 | **I4 Causal** | substrate only on dal-cv; benchmark tests reasoning-not-retrieval; answers "is Graph C real or theatre" |
| 5 | **I5 Global** | substrate MISSING (build community summaries) + LLM-judged (reintroduces the oracle problem) → last |

## Proxy caveat (load-bearing)
This set and its benchmarks are a **working hypothesis**. Standard benchmarks run on *their* corpora and
validate a mechanism *in general*; confirming transfer to our real use-case still needs a slice of real
queries when they exist. Do not optimise hard against any single benchmark as if it were the real target
(the papers-as-queries lesson). Revisit the set when real usage exists.

## What this unlocks
Committing the set (after the product-fit check) selects which doc-31 rows become real and lets Phase 3
(harness + flat baseline) and Phase 4 (per-intent ingestion experiments) children be created against a clear
target — top of the priority list first.

## The human decision (recorded, 2026-09-02)
Both questions were put to the user; both are now answered.

**Q1 — do the five intents match what the system is FOR?** → **Yes** ("it seems to fit pretty well"). No
intent dropped or merged. One substantive addition surfaced (see below).

**Q2 — is the priority right?** → **Yes, I3 → I1 → I2 → I4 → I5 as recommended.** Temporal+local first.

### The one framing addition — a composite-reasoning layer (agent-composed, NOT a sixth substrate)
The user flagged a real class of query that the five *atomic* intents do not each name on their own: **reasoning
efforts that run over the graph as a combination of I1–I5.** In the user's own examples:
- **Causal trajectory / progression**, not just point causation — "where things are moving", direction of change
  over time (a blend of **I4 causal × I3 temporal**).
- **Meta / "why is it the way it is"** — why a person or thing is as it is; not only *how* two things are
  connected (I2) but *why* they are connected (**I2 × I4**).
- **Causal-chain failure analysis** — "at what point in our chain of causes did things start to go down" (a
  *when-in-the-causal-chain* query, **I4 × I3** over a traversal).
- **Thematic reasoning over time** — "the main themes of cause and progression throughout time" (**I5 × I4 ×
  I3**).

**Disposition:** these are **composite queries handled by the client agent composing the five primitive
retrieval intents** — consistent with the settled design (MCP tools are primitives; routing = client model +
skills; the agent is the client). They are **not** a new atomic intent with its own substrate to build. The
user themselves noted the open question — "I'm not sure how much of that is offloaded to the agent, though.
It'd be hard to test" — so we do **not** commit a buildable I6; instead:
- The five primitives (I1–I5) are what we build substrate + per-intent benchmarks for (Phase 3/4).
- Composition into these reasoning queries is an **agent/orchestration concern**, deferred and explicitly
  **flagged as untested / hard-to-test** until (a) the primitives are individually solid and (b) real
  composite queries exist to evaluate against. When that evaluation becomes possible it is a *composition*
  test (does the agent chain the primitives correctly), not a new-substrate test.

This addition changes neither the atomic set nor the priority; it records *where* reasoning queries live in the
architecture (the composition layer) so Phase 3/4 stay scoped to the primitives.
