# 32 — Intent-adaptive retrieval & ingestion redesign — program plan

**What this is.** The plan that turns docs 30 (architecture map) + 31 (strategy→ingestion matrix) into
executable work: redesign ingestion *to* the query capabilities we commit to, validate each against a
standard benchmark, and expose the validated strategies as an MCP tool surface an external agent drives.
Designed to run **mostly autonomously** under the project's loop discipline (pre-register → measure → blind
adversary → bank), converging on banked findings.

**Relation to existing work.** Successor to `nmemo-u8j` (the single-graph retrieval loop — proved the
two-signal fusion, ruled out rerank/community/traversal *on the fact-finding task*, docs 05–29). Absorbs /
aligns with `nmemo-bki` (the benchmark-baselining epic — LongMemEval, Corr2Cause+CLadder, LOCOMO,
GraphRAG-Bench, CronQA), which turns out to map almost one-to-one onto the query intents below.

## Governing principles (settled in the docs 30–31 discussion)
1. **Query capability pulls ingestion.** We do not tune ingestion in a vacuum; each ingestion change is
   justified by movement on the benchmark for the intent it serves.
2. **Benchmark-gated.** Every intent has an external, ground-truthed benchmark (except global sensemaking —
   LLM-judged, sequenced last). A change that helps one intent must not regress another (regression gate).
3. **Foundations before intents.** The query-agnostic foundations (provenance backbone, corpus scoping,
   dedup, stable ids, wiring the proven fusion) are common to every strategy and come first.
4. **The MCP tool surface is the product; agents are clients.** Each *validated* strategy becomes one MCP
   tool; routing is the consuming model's job (guided by skills), not a built classifier. The internal
   reasoning agent demotes to one optional client.
5. **Provenance is load-bearing** — it unlocks reranking, citations, causal verification, *and correct
   held-out evaluation* (the `.8` leak was a provenance failure). It is the first foundation.
6. **Descriptions live on the summary/keyed path, not the small-k entity vector** (docs 05/31).

## Phases

### Phase 0 — Graph-structure analysis (diagnostic; surface the confusions)
A read-only analysis of the *current* graph's structure and health, per corpus, producing an artifact of
stats + flagged anomalies ("things we're confused about"). Complements doc 30 (code-level) with the
data-level picture. Measure at minimum:
- degree distribution + fact-degree per entity; connectivity / component sizes; community structure
  (modularity — arxiv ≈ 0.91 already, doc 28); duplicate `canonical_name` rate (the tie-break artifact);
- **provenance completeness** — % facts with `source_memory_id` / `fact_sources` / `fact_units` (quantify
  the broken foundation per corpus and per ingest path, serial vs epoch);
- extraction-quality signals — entity-type + predicate distributions, hapax-predicate rate (nmemo-ecn:
  68.7% on new domains), description coverage, orphan/aged-orphan entities;
- Graph C coverage — causal events/edges per corpus, the `causal_edges` no-`corpus_id` gap;
- the known artifacts to confirm/quantify — ~80% name-in-query (doc 27), fragment→entity/edge link absence.
**Output:** a graph-health doc + a flagged-anomalies list feeding Phase 1 priorities. No changes.

### Phase 1 — Query-agnostic foundations (build; no intent decision needed)
1. **Provenance/lineage backbone** (doc 31 §4): `fragment{fragment_id, source_document_id, parent_id,
   char offsets, chunker name+version}` + `entity/edge → proof_fragment_ids[]` → transitive to source; fix
   the NULL `source_memory_id` / empty `fact_units` on the epoch path; per-claim citation capability.
2. **Corpus scoping on the live read path** (nmemo-4h3 / -81k): thread `corpusId` through Qdrant search,
   `findSimilarEntities` (stop pinning to `'default'`), and `traverseFromEntities`.
3. **Dedup / canonicalization hardening** at ingest (the tie-break + multi-hop-join dependency).
4. **Wire the proven fusion in** (doc 30 step 1): corpus-correct `recallEntitiesFused` as an MCP tool.
Each is a build task with a concrete acceptance check; provenance is P0 because it also unblocks honest eval.

### Phase 2 — Query-intent enumeration + benchmark mapping (decide)
Define the intent set — grounded in **real / representative queries**, not invented (the a-priori-taxonomy
trap). Starting candidates + their benchmarks (doc 31):
| Intent | Benchmark | Ground truth |
|---|---|---|
| local / specific | BEIR-style + LongMemEval / LOCOMO | ranked relevance |
| relational / multi-hop | 2WikiMultiHop / HotpotQA / MuSiQue | clean |
| causal | Corr2Cause / CLadder (+ nmemo-4fd) | reasoning, not retrieval — scope carefully |
| temporal / as-of-date | CronQA / ChronoQA | clean |
| global / sensemaking | GraphRAG-Bench | LLM-judged (last) |
**Output:** the committed intent list (which rows of doc 31 become real), reconciled with `nmemo-bki`.

### Phase 3 — Per-intent benchmark harness + flat baseline
For each committed intent: wire its standard benchmark into an eval harness (reuse `retrieval-eval` where it
fits; new harness where the intent needs it), establish the **flat-vector baseline**, confirm a wiring
anchor. This is largely the `nmemo-bki` work; unify the two rather than duplicate.

### Phase 4 — Per-intent ingestion/extraction experiments (benchmark-gated, pre-registered)
Per intent, the ingestion change doc 31 prescribes — measured against that intent's benchmark, under full
discipline (pre-register metric+bar+kill before computing, blind adversary before banking, regression gate
across the other intents' benchmarks, provenance-enabled held-out). Examples:
- multi-hop → denser typed relations / passage nodes / PPR; gate on 2WikiMultiHop.
- temporal → evaluate the *existing* bi-temporal substrate; gate on CronQA (cheap early win — substrate
  already built, never measured).
- global → community precompute + LLM community summaries; gate on GraphRAG-Bench (LLM-judged; last).
- local → add a BM25/lexical index → real hybrid; gate on a real-query slice (not papers-as-queries).
- causal → run the causal pass + corpus-partition edges; gate on Corr2Cause (is Graph C real or theatre).
Children here are created *after* Phase 2 commits the intent set — do not pre-build speculatively.

### Phase 5 — MCP tool re-leveling + skills (expose)
Re-level the MCP tool surface for an external agent (right granularity, self-describing), one tool per
validated strategy; ship skills that teach a client how to drive the graph per intent; demote the internal
reasoning agent to one optional client. Routing = the client model + skills.

## Discipline & autonomy model
Runs under the existing loop protocol (`feedback_verify_empirical_gates`): one pre-registered unit at a time,
committed before computing, blind adversary before any bank, size leaks don't just state them, halt-and-surface
on surprise. Foundations (Phase 0/1) are build+verify tasks; Phases 3/4 are experiments. Provenance (Phase 1.1)
is what makes the held-out evaluation in Phase 4 trustworthy. Each child converges to a banked finding in the
ledger; the epic converges when the committed intents are each validated-or-honestly-negatived and ingestion
is conformed to them.

## Convergence criteria (what "done" looks like)
- Phase 0 artifact banked; foundations (provenance, scoping, dedup, fusion wired) built + verified.
- Each committed intent has: a wired benchmark + flat baseline, ≥1 pre-registered ingestion experiment with a
  banked verdict (positive or honest-negative), and no regression on the other intents.
- The validated strategies exposed as MCP tools with skills; the internal agent optional.

## Beads epic — `nmemo-asf`
Children mirror the phases (`bd show nmemo-asf`, `bd ready`):
- `nmemo-asf.1` — Phase 0: graph-structure analysis (diagnostic).
- `nmemo-asf.2` — Phase 1.1: provenance/lineage backbone (FIRST foundation).
- `nmemo-asf.3` — Phase 1.2: corpus scoping on the live read path.
- `nmemo-asf.4` — Phase 1.3: wire the corpus-correct fusion as an MCP tool.
- `nmemo-asf.5` — Phase 1.4: dedup / canonicalization hardening.
- `nmemo-asf.6` — Phase 2: query-intent enumeration + benchmark mapping (DECISION).
- `nmemo-asf.7` — Phase 3: per-intent benchmark harness + flat baseline (unify with `nmemo-bki`).

**Phase 4** (per-intent ingestion/extraction experiments) and **Phase 5** (MCP re-leveling + skills) children
are created *after* Phase 2 (`.6`) commits the intent set — not pre-built speculatively.
