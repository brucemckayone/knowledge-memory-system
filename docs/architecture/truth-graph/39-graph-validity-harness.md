# 39 — Graph Validity & Quality Harness

**Status:** Design
**Branch:** `feat/parallel-ingestion`
**Date:** 2026-06-02

> Follows [38 — Parallel Ingestion](38-parallel-ingestion.md). Doc 38's harness
> measures **structure and self-agreement** (entity/fact counts, duplicate
> counts, structural-hash + semantic F1 *between runs*). That tells us whether
> two runs agree — not whether either is **correct**. This doc designs the
> missing layer: does the graph faithfully and correctly represent the source,
> and can we **snapshot it, track it across runs, and report on it concretely**.

---

## 1. Why — the validity gap (with evidence)

Self-consistent is not the same as true. Two runs that make the *same* mistake
score high on every doc-38 metric while both being wrong. Inspecting the live
graph (optimistic-reverse arm, 10-chunk corpus) makes this concrete:

- **Supersession is broken — the graph asserts mutually-exclusive facts at
  once.** Elena Vasquez has **five** coexisting active role facts:
  `job_title=junior software engineer`, `job_title=senior engineer`,
  `job_title=engineering lead`, `title=chief technology officer`, `title=cto`
  (plus `role_at`, `works_at`, `cto_at` to the company). Helix is
  `headquartered_in` **both** `boston` **and** `austin`. The graph claims Elena
  is a junior engineer *and* the CTO, and the company is in two cities.
- **Root cause — predicate sprawl defeats supersession.** Exclusive-predicate
  supersession only fires within an *identical* predicate. The agent's
  non-determinism gives one logical attribute many predicates
  (`job_title`/`title`/`role_at`/`cto_at`), so nothing supersedes anything. Even
  the same-predicate `headquartered_in boston|austin` failed to supersede in the
  reverse arm (so `valid_at` wasn't extracted/applied there).
- **Contradictions detected but not reflected.** Ingest logs show 6–15
  contradictions/pass (`opposing_object`, `temporal_impossible`); the final
  contradictions table is empty, yet Boston/Austin (a textbook
  `opposing_object`) sit active.
- **Sentence-as-value facts.** e.g. `helix :: relocated :: "may 2022:
  headquarters moved from boston to austin, texas"` — narrative stuffed into the
  object value instead of `(helix, headquartered_in, austin, valid_at=2022)`.
- **Stale relations.** Elena still `reports_to marcus chen` (she succeeded him;
  he left); Marcus still holds an active `head of engineering` title.

None of doc 38's metrics flagged any of this (`dupEnt=0`, `dupFact=0`, litmus ≈
determinism). The validity layer below is what catches it.

---

## 2. What we measure — validation dimensions

### A. Ground-truth correctness
The corpus is authored, so a small **gold graph** is feasible: the expected
entities, the expected **current** (non-superseded) facts, and which facts
should be **expired**. Against it:
- fact/entity **precision + recall vs gold** (correct, not just self-consistent);
- **current-state correctness** — for each exclusive attribute (a person's
  title, a company's HQ), is there *exactly one* correct active fact? This is
  the metric that scores the 5-titles / 2-HQs failure directly;
- **predicate-sprawl** — count of distinct predicates mapping to one logical
  relation (the supersession-defeating signal).

Keep the *capability* general (correctness-vs-reference works for any corpus);
the authored corpus is just the first gold instance (see "generalize design").

### B. Per-step instrumentation
Capture into a structured record, per arm/run: per-phase timing
(ORIENT/EXTRACT/RELATE/CAUSE/VERIFY — already in `extract()`'s `timing`), tool-call /
retry / 503 counts, merge candidates detected vs merges performed, contradictions
detected-by-type vs resolved vs left-active, facts superseded vs facts that
*should* have superseded, causal edges created.

### C. Graph-integrity invariants (deterministic — no LLM)
Pure DB checks, fast and unambiguous:
- **≤1 active fact per (subject, exclusive-predicate-group)** — catches the
  coexisting-titles / dual-HQ bug. Requires a small predicate→group map.
- **Causal edges** have `reasoning` and `source_references` non-null, and no
  self-loops (`cause_event != effect_event`, and the events' facts differ) — the
  doc-01 causal invariant.
- **No orphan entities** (0 active facts and not a fresh arrival), no dangling
  FKs, **one audit row per mutation** (doc 12), `object_value` is not a sentence
  (length / token heuristic).

### D. Agent review (LLM-as-judge over the actual graph + reports)
Feed a judge the corpus + the extracted graph (facts with `valid_at`/`expired_at`,
causal edges with `reasoning`, contradictions) + the reports, and have it rule on:
faithfulness, current-state correctness, supersession, causal justification,
hallucinations, predicate consistency — emitting a **structured issue list** per
arm. `mlJudge` in `src/test/quality/helpers.ts` is the seed. Pair with (C): the
invariants catch the mechanical errors so the judge can focus on the semantic ones.

### E. Reports review
Pull and assess `extraction_reports`, `reasoning_reports`, `gardening_reports`,
and cross-check the agent's *self-reported* actions against the graph (did a
reconciliation report claim merges that didn't happen? did extraction claim
facts absent from the graph?). The agent's own reports are a second, independent
signal — and often reveal where it *knew* something was wrong.

### F. Longer run + repeats
Full 20 chunks (more supersession chains, more contention, more contradictions)
and several repeats per arm → distributions and variance bands, not single points.

---

## 3. Snapshot, track, report (the durable layer)

Doc 38 throws its graphs away after scoring. To track progress and produce
concrete reports we persist them.

### 3.1 Rich graph export
`exportCanonicalGraph()` (`graph-canonical-query.ts`) deliberately strips
temporal + reasoning fields (active facts only; edges without
`reasoning`/`source_references`). Add a sibling **`exportRichGraph()`** + route
(`GET /api/graph/full`) that returns everything validity needs and nothing the
canonical form needs to omit:
- entities: id, name, type, summary, `merged_from`, created_at;
- facts: + `valid_at`, `expired_at`, `expire_reason`, `source_memory_id`, created_at
  (expired rows included, so supersession is auditable);
- causal events + edges: + `reasoning`, `source_references`, `valid_at`/`expired_at`;
- contradictions (all), `same_as` links, and the reports (B/E above).
Leave `exportCanonicalGraph()` untouched (the diff/litmus path depends on it).

### 3.2 Snapshot store layout
```
benchmark-results/
  gold/<corpus>.gold.json              # the reference graph (dimension A)
  runs/<runId>/
    manifest.json                      # runId, timestamp, gitCommit, corpus,
                                       #   modes, concurrency, platform/model
    <arm>.<order>.canonical.json       # diffable (doc 38)
    <arm>.<order>.rich.json            # full dump (3.1) — agent-review + invariants
    metrics.json                       # exact + semantic + correctness + invariants + per-step
    report.md                          # generated concrete report (3.4)
  history.jsonl                        # one line per run → trend tracking
```
`runId` is a caller-supplied timestamp (the comparison driver stamps it). Rich
JSON is the durable, diffable, agent-reviewable artifact; it does not expire.

### 3.3 Progress tracking
Append one line per run to `history.jsonl` (runId, gitCommit, per-arm:
current-state-correctness, invariant pass-rate, fact P/R vs gold, determinism &
litmus F1, throughput, predicate-sprawl count). A small `trend` view diffs run N
vs N-1 so a fix (e.g. predicate canonicalization) shows up as
current-state-correctness climbing over commits — the whole point of snapshots.

### 3.4 Concrete reports
Generate `report.md` per run from `metrics.json` + the agent review: the
scorecards, the invariant pass/fail list with the offending rows
(e.g. "Elena: 5 active title facts — expected 1"), the agent-review verdict +
top issues, and links to the snapshots. Plus a cross-run trend section. This is
the artifact a human reads.

### 3.5 Full restorable snapshots (optional)
For re-analysis without re-ingesting, reuse the existing
`snapshot:generate`/`snapshot:load` (`scripts/*-snapshot.ts`, doc 28 §3.4 pg_dump
into a guarded `cognitive_snapshot_*` DB). Heavier and not diffable (binary +
timestamps), so it complements — not replaces — the rich JSON.

---

## 4. Grounding / reuse

| Need | Reuse |
|------|-------|
| Diffable graph form | `exportCanonicalGraph` + `graph-canonical.ts` (doc 38) |
| Rich dump | **new** `exportRichGraph` (extends `graph-canonical-query.ts`) |
| F1 / fuzzy matching | `graph-canonical-semantic.ts` (doc 38) + `test/quality/helpers.ts` |
| LLM judge | `mlJudge` (`test/quality/helpers.ts`) → graph-review agent |
| Structural stats | `computeGraphStats` (`graph-stats.ts`) |
| Contradictions | `contradictions.ts` (`getContradictions`/`detectContradictions`) |
| Supersession audit | `getFactHistory`/`getEdgeHistory` (`audit.ts`, doc 12) |
| Full snapshot/restore | `snapshot:generate`/`snapshot:load` (doc 28) |
| Reports | `extraction_reports`, `reasoning_reports`, `gardening_reports` tables |

---

## 5. Build phases (incremental)

1. **Rich export + snapshot store** (3.1, 3.2) — `exportRichGraph` +
   `/api/graph/full`; driver writes manifest + canonical + rich JSON per arm.
   *Immediately makes every run inspectable + re-analyzable.*
2. **Deterministic invariants** (C) — pure checks over the rich JSON; feed
   `metrics.json`. *Catches the supersession/sprawl/self-loop bugs mechanically.*
3. **Gold graph + correctness** (A) — author `gold/<corpus>.gold.json`; score
   current-state correctness + P/R + predicate-sprawl.
4. **Per-step instrumentation** (B) + **report generation** (3.4) + history (3.3).
5. **Agent review** (D) + **reports review** (E).
6. **Longer run + repeats** (F) over the full 20-chunk corpus.

Phases 1–3 are deterministic and cheap; they likely already answer "how bad is
supersession" without any LLM. The agent review (5) adds the qualitative layer.

---

## 6. Open decisions

1. **Ground truth:** gold graph *and* agent-judge (recommended), or one only?
2. **Judge model:** a strong model (Opus/Sonnet) for judging vs GLM/Haiku for the
   pipeline. Haiku-first is a *pipeline* rule; the judge should not be as noisy as
   what it grades. (Recommended: strong judge.)
3. **Supersession/predicate-sprawl:** measure-first (build harness, quantify
   across the longer run) then fix, or fix predicate-canonicalization now?
   (Read of the ask: measure-first.)
4. **Corpus size** for the longer run (full 20, or larger).
5. **Snapshot retention / git:** commit rich JSON + reports as tracked history,
   or keep under an ignored `benchmark-results/`? (Scratch `.venv` is always
   ignored.)

---

## 7. References

- **Docs:** [38 parallel ingestion](38-parallel-ingestion.md) ·
  [05 temporal pipeline](05-temporal-pipeline-redesign.md) (supersession, litmus) ·
  [12 audit trail](12-audit-trail-foundation.md) · [28 snapshot infra](28-*.md) ·
  [01 dual-graph](01-dual-graph-architecture.md) (causal invariants) ·
  [35 reconciliation](35-reconciliation-agent.md) · [36 gardener](36-gardener-agent.md).
- **Code:** `services/graph-canonical-query.ts` (`exportCanonicalGraph`) ·
  `services/graph-canonical.ts` + `graph-canonical-semantic.ts` (doc 38) ·
  `test/quality/helpers.ts` (`mlJudge`, F1, `matchEntities`) ·
  `services/graph-stats.ts` · `services/contradictions.ts` · `services/audit.ts` ·
  `scripts/generate-snapshot.ts` / `load-snapshot.ts` (doc 28).
- **Evidence:** live optimistic-reverse graph, 10-chunk corpus, 2026-06-02
  (Elena 5 active titles; Helix dual HQ; contradictions detected-not-reflected).
