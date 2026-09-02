# 34 — Query-intent set (PROPOSED) + benchmark mapping — Phase 2 of nmemo-asf

**Status: PROPOSAL awaiting a product-fit sanity check.** Per the doc-32 correction: the model proposes this
set (from the vision + doc-31 literature + the benchmarks that already encode intents); it is labelled a
**PROXY for real usage, not validated ground truth** (there are no real users/queries yet, so real-query
grounding is currently impossible — the discipline is to *label* the proxy, not to block on a human authoring
intents). The only human input needed is: **do these intents match what the system is FOR, and is the
priority right?** Answering that "commits" the set and unlocks Phase 3/4.

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

## The one question for the human
1. Do these five intents match what the system is *for* (anything missing, anything that isn't really a goal)?
2. Is the priority right — is a **memory** system's core really temporal+local (my ranking), or is the
   product more about reasoning (causal/multi-hop) or synthesis (global), which would re-order the work?
