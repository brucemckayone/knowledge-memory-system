# 28 — Remaining-levers feasibility (.7 Graph C, .8 community summaries): no-Claude MEASURE-FIRST

**Purpose:** the epic's three open children (`.7`, `.8`, `.12`) each need a decision that only the user can
make (an irreversible migration, or Claude-heavy runs against a live org spend cap). Before asking for that
decision, this doc records what is knowable WITHOUT Claude and WITHOUT any irreversible action — the
substrate + structure feasibility of `.7` and `.8`, so the go/no-go is informed. No experiment is run here;
this is a scoping/feasibility record, not a pre-registration.

Read-only DB + deterministic graph analysis only (2026-09-02, on `cognitive_test`).

## .7 — Graph C causal-layer retrieval baseline: substrate is on the WRONG corpora + needs a causal oracle

Facts measured:
- **Causal layer exists only on: `default` (7299 events / 296 active edges), `dal-cv` (2565 / 521),
  `dal-nlp` (1028 / 175), `qbio` (6955 / 51).** The R4-confirmed retrieval substrate **`arxiv-nlp` and
  `arxiv-cv` have ZERO causal_events and ZERO causal_edges** — no Graph C at all. (qbio's 51 edges are a
  batch-0 remnant from before the causal pass was disabled for the `.3` ingest.)
- `causal_edges` is **NOT corpus-partitioned** (no `corpus_id` column); scoping requires a join to
  `causal_events` on `cause_event_id`.
- Edges themselves are well-formed: **1043 active, 100% have `reasoning` AND `source_references`.**
- The bead's own caveat holds: the causal pass is delta-scoped + capped at `CAUSAL_PASS_SCOPE_CAP=200` per
  epoch (`nmemo-umf`), so cross-batch causality is structurally invisible — an under-scoped false negative
  risk that must be accounted for or fixed first.

Conclusion: `.7`'s "no-memory-baseline" test (benchmarks `plan.md` §2.2, the Corr2Cause reality-check =
"does the causal layer lift over a no-memory baseline") is **NOT a reuse of the single-graph retrieval-eval
engine** (that engine is entity-target-finding; there is no causal-question oracle). It requires a labelled
causal-reasoning benchmark + a Claude judge — i.e. it belongs to / depends on the **benchmarks epic
(`nmemo-bki`, bead `nmemo-4fd` Corr2Cause baseline)** — and, if run on the in-house graph, the best-populated
substrate is `dal-cv` (521 edges), NOT arxiv. **Blocked for autonomous single-graph work: needs an oracle +
Claude (org spend-cap risk) + the `nmemo-umf` scoping decision.**

## .8 — community summaries: the graph HAS strong community structure (structurally viable)

Louvain communities (networkx, seed 20260831) on the entity-fact graph (nodes = entities, edges = active
facts with distinct subject/object), per corpus:

| corpus | nodes | edges | giant comp | #communities | **modularity** | communities ≥5 (node coverage) | singletons/pairs |
|---|---|---|---|---|---|---|---|
| arxiv-nlp | 1199 | 1423 | 66.7% | 80 | **0.907** | 62 (96%) | 8 |
| arxiv-cv  | 1251 | 1461 | 75.3% | 66 | **0.906** | 51 (97%) | 9 |
| qbio      | 3412 | 3499 | 2.6%  | 396 | 0.994 | 247 (89%) | 83 |

- **arxiv has rich, substantial community structure** — modularity ≈ 0.91 (well above the ~0.3 "meaningful"
  threshold), 50–62 communities of 40–70 entities each covering ~97% of nodes, in a mostly-connected graph
  (giant component 67–75%). So there IS real thematic structure to summarize; `.8` is **structurally
  viable** (the graph is neither one blob nor all singletons).
- **qbio is NOT** a good `.8` substrate: giant component 2.6%, 395 disconnected components — its
  "communities" are largely per-paper (consistent with `.3`'s finding that qbio entities are paper-specific).
  Community summaries need cross-document connectivity, which arxiv has and qbio does not.

Conclusion: the "is there structure to summarize" question is **YES for arxiv**. The remaining blockers for
`.8` are (1) a **global/thematic-query oracle** (does not exist — the retrieval-eval oracle is
target-finding; a GraphRAG-style global-query set with known answers must be built), and (2) the
**summarization step** (Claude — spend-cap risk). Neither is an irreversible action; both need the user's
go-ahead on scope + spend.

## .12 — bge-m3 production swap: unchanged, needs explicit consent
Irreversible migration (pgvector dim 768→1024 + full re-embed of all corpora + HNSW rebuild on the shared
`cognitive_test` DB). `.5`/doc 25 demonstrated the exact-dot benefit; `.12` proves it survives approximate
HNSW at scale. Ollama-only (no Claude). NOT a "test" — requires explicit user consent before running.

## Net
All three remaining items are gated on a user decision that autonomous work cannot substitute for:
- `.12`: consent for an irreversible migration.
- `.7`: an oracle + Claude judge (belongs to the benchmarks epic; substrate is dal/default, not arxiv;
  `nmemo-umf` first).
- `.8`: structurally viable on arxiv (modularity 0.91), but needs a new global-query oracle + Claude
  summarization.
The feasibility above is the maximal no-Claude, no-consent progress; the go/no-go on each is the user's.
Artifacts: `scratchpad/community_analysis.py`, `entity-edges.tsv` (regenerable from `public.facts`).
