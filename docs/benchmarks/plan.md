# Mnemo Benchmark Plan

**Status:** Contract. Internal baselining, not a release artefact.
**Date:** 2026-05-27
**Companion to:** [`landscape.md`](./landscape.md) — survey + recommendation. This doc is the *how*.

## Scope

Five benchmarks, in execution order: **LongMemEval → Corr2Cause + CLadder → LOCOMO → GraphRAG-Bench → CronQA**. Source of truth for *why* these five: `landscape.md` §"Recommendation".

The point of this work is to know where Mnemo sits right now, on benchmarks that other systems also publish on, so we can improve and watch the number move. No public comparison, no launch, no vendor head-to-head. The cross-vendor methodology rules in `landscape.md` that protect against cherry-picking are partially relaxed; the rules that keep our *own* runs comparable to each other are kept strict.

---

## 1. Cross-cutting decisions

### 1.1 Model stack

| Role | Model | Rationale |
|---|---|---|
| System under test (Mnemo's extraction + causal agent) | Haiku (current default in `ml-services/app/core/llm.py`) | Matches shipped pipeline. Per `feedback_haiku_first` — we don't lean on stronger models as a crutch. |
| LLM-as-judge for scoring | Sonnet | Capable enough that judge variance does not swamp the signal we're measuring; Haiku-as-judge introduces too much borderline-call noise. Cheaper than Opus. |
| Comparator backbones (GPT-4o, GPT-4o-mini, others) | Not used | We are not running cross-vendor comparators. Vendor numbers in `landscape.md` are reference context only. |

If we later want to publish externally, a second pass on GPT-4o-mini becomes an explicit follow-on (see §6).

### 1.2 Repo layout

A new Python workspace at the repo root, peer to `platform/` and `ml-services/`. Calls Mnemo via its HTTP API — the same surface a real user hits.

```
/benchmarks/
├── pyproject.toml                       # uv workspace; deps pinned
├── _common/                             # shared across benchmarks
│   ├── client.py                        # Mnemo HTTP client (ingest, query)
│   ├── judge.py                         # Sonnet LLM-as-judge
│   ├── results.py                       # JSON envelope writer + dashboard regen
│   └── config.py                        # cut names, dataset paths, model ids
├── longmemeval/
│   ├── upstream/                        # git submodule → xiaowu0162/LongMemEval
│   ├── run.py                           # produces one JSON result per invocation
│   ├── score.py                         # per-category scoring
│   └── config.yaml                      # pre-registered cut + model ids
├── corr2cause/                          # + cladder/, locomo/, graphrag/, cronqa/
└── results/
    └── {benchmark}/runs/{date}-{sha7}.json   # machine-readable, one per run

/docs/benchmarks/
├── landscape.md                         # the survey (already written)
├── plan.md                              # this doc
└── results/
    ├── README.md                        # cross-benchmark dashboard (latest run per benchmark)
    └── {benchmark}.md                   # per-benchmark trend table + hand-written commentary
```

Two locations for results, each with one job: `/benchmarks/results/` is what the harness writes (machine-readable JSON, one per run). `/docs/benchmarks/results/` is what humans read (markdown trend tables + commentary on what changed). A small generator script in `_common/results.py` re-renders the markdown from the JSON on demand.

### 1.3 Upstream harness pinning

Each per-benchmark subdir contains an `upstream/` git submodule pinned to a specific commit of the canonical harness (e.g. `xiaowu0162/LongMemEval`, `snap-research/locomo`, `GraphRAG-Bench/GraphRAG-Benchmark`). `git submodule status` then satisfies the "publish the eval harness commit" hygiene rule for free. Submodules over pip pins because the latter can be silently re-tagged upstream.

### 1.4 Results JSON envelope (shared schema)

Every run writes exactly one JSON file. The envelope is the same across all five benchmarks; only `scores` differs.

```json
{
  "benchmark": "longmemeval",
  "cut": "LongMemEval_S",
  "mnemo_git_sha": "3241f94",
  "harness_commit": "abc1234",
  "config_path": "benchmarks/longmemeval/config.yaml",
  "model_under_test": "claude-haiku-4-5-20251001",
  "judge_model": "claude-sonnet-4-6",
  "timestamp": "2026-05-28T14:32:11Z",
  "dataset_size": 500,
  "scores": { ... benchmark-specific ... },
  "token_usage": {
    "graph_agent": {
      "claude-haiku-4-5": { "input": 0, "output": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, "calls": 0, "tool_calls": 0 }
    }
  },
  "estimated_cost_usd": 0.0,
  "pricing_version": "",
  "notes": "Baseline. First run on Graph S after nmemo-2yv close-out."
}
```

The three token-usage fields (`token_usage`, `estimated_cost_usd`, `pricing_version`)
were added by the token-usage & cost-tracking epic (nmemo-6do, B9). All are
default-valued, so older run JSONs (written before the epic) still deserialize.
`token_usage` is the in-memory `TokenAccumulator` rollup —
`{operation: {resolved_model: {input, output, cache_read, cache_write_5m, cache_write_1h, calls, tool_calls}}}` —
and is the source of truth for benchmark-run usage (llm_usage.trace_id is
platform-internal only, design §4.5 option b). `estimated_cost_usd` is computed
downstream from the recorded token buckets via `config.ts` PRICING (the single
source of truth — no pricing logic in the Python harness); it stays 0.0 unless a
reporting step fills it.

`notes` is the field where we record *what we expect this run to show* — e.g. "expecting -5% vs run N because we disabled the cross-cluster bridging fallback". That field is what turns a number into a story.

### 1.5 Methodology hygiene (the rules we adopt)

From `landscape.md` §"A note on methodology hygiene":

| Rule | Status | How it's enforced |
|---|---|---|
| 1. Publish harness commit + config | **Adopted** | Submodules + checked-in `config.yaml` per benchmark; both fields in the JSON envelope. |
| 2. Report two backbones for cherry-pick resistance | **Dropped** | Not in internal-baselining scope. Single Haiku backbone. |
| 3. Name the metric variant | **Adopted** | Each per-benchmark spec below names the cut + metric explicitly. |
| 4. Run baselines on the same harness | **Dropped** | No cross-vendor comparators. |
| 5. Pre-register the cuts | **Adopted** | Each per-benchmark spec below locks the cut before the first run. |

### 1.6 Cadence + dashboard

Manual cadence to start. Each benchmark has a single `run.py` invocation that produces one JSON. After each run, `_common/results.py` regenerates `/docs/benchmarks/results/{benchmark}.md` and the cross-benchmark `/docs/benchmarks/results/README.md` dashboard. A cron schedule for continuous baselining is a follow-on (§6).

The cross-benchmark dashboard is a single table — one row per benchmark, columns for latest score, prior score, delta, run date, and Mnemo commit. That's the page we look at first when we want to know where we are.

---

## 2. Per-benchmark specs

Each spec is contract-level: enough for an engineer to start the work and for the user to sign off the scope. Step-by-step implementation lives in beads.

### 2.1 LongMemEval — Graph S core, first build

- **Upstream:** [`github.com/xiaowu0162/LongMemEval`](https://github.com/xiaowu0162/LongMemEval). Submodule at `benchmarks/longmemeval/upstream/`.
- **Dataset:** 500 hand-curated questions over multi-session chat histories, from HuggingFace.
- **Pre-registered cut:** **LongMemEval_S** (the harder variant). Per landscape doc note: "vendors quote whichever flatters them — pick the harder track and be explicit."
- **Metric:** LLM-as-judge accuracy (Sonnet as judge), broken out by the five LongMemEval categories — information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention. Plus an overall accuracy.
- **What it tests in Mnemo terms:** Multi-session entity dedup, bi-temporal fact updates, abstention. Exercises Graph S along its core competency axis.
- **Ingest path:** Each LongMemEval "session" is replayed turn-by-turn through `POST /ingest` on the Mnemo platform (HTTP). Each question is then asked via the read API (`POST /query`). Per-question score = judge call.
- **Acceptance for first baseline run:**
  1. End-to-end run completes on the full 500-question LongMemEval_S cut without manual intervention.
  2. JSON result written with all six scores (five categories + overall) and the envelope fields populated.
  3. `docs/benchmarks/results/longmemeval.md` regenerated from the JSON; trend table has one row.
  4. Sanity check: abstention category > 0% (a fully-broken Mnemo would abstain 0% or 100%, both pathological).
- **Estimated model cost per run:** Ingest is order ~10–50 Haiku calls per session × ~500 sessions ≈ low thousands of Haiku calls. Judge is 500 Sonnet calls. Rough order: $5–15 per full run.
- **Estimated eng cost (first pass):** 1–2 weeks. Includes building `_common/client.py` and `_common/judge.py`, which the other four benchmarks reuse.

### 2.2 Corr2Cause + CLadder — Graph C reality-check

Two benchmarks bundled because they share a harness shape (single-turn structured causal QA, no ingest pipeline involved in the same way as chat) and run in well under a week combined. Treated as one work-unit in sequencing but produce two separate JSON results.

- **Upstreams:**
  - Corr2Cause: [`arXiv 2306.05836`](https://arxiv.org/abs/2306.05836). Dataset on HF.
  - CLadder: [Semantic Scholar entry](https://www.semanticscholar.org/paper/CLadder%3A-A-Benchmark-to-Assess-Causal-Reasoning-of-Jin-Chen/f30b720e34d405f200270a6ef2d09e98585fb4d1). Synthetic, scriptable.
  - Both as submodules under `benchmarks/corr2cause/upstream/` and `benchmarks/cladder/upstream/`.
- **Pre-registered cuts:**
  - Corr2Cause: full eval set (200K+ examples). If runtime is prohibitive on the first pass, stratified sample of 5,000 — the spec lists the random seed so the sample is reproducible.
  - CLadder: all three rungs of Pearl's ladder (association, intervention, counterfactual). No subsampling.
- **Metrics:**
  - Corr2Cause: F1 (the standard).
  - CLadder: accuracy per rung + overall.
- **What it tests in Mnemo terms:** Whether Graph C's LLM-asserted causal edges (with `reasoning` and `source_references`) move the needle over pure-LLM baselines. **This is the load-bearing question for the causal layer** — landscape doc §"Causal reasoning" puts it bluntly: if we can't lift over the brutal LLM-baseline floor (GPT-4 @ 29 F1 on Corr2Cause), Graph C is performance theatre.
- **Ingest path:** Each Corr2Cause/CLadder item is a single QA pair with no prior conversation. The "ingest" step is more accurately "ingest the question's preamble (the correlation statement or the causal scenario) and then ask the question". For Mnemo this means: a one-shot ingest call followed by a query.
- **Acceptance for first baseline runs:**
  1. Both Corr2Cause and CLadder run end-to-end and write JSON.
  2. Each JSON's `notes` field records whether Graph C was engaged for any items (counting how often the causal agent triggered — landscape doc §1.4 of `04-sparse-branch-design.md` lists the conditional triggers).
  3. **Honest reporting required:** if Mnemo's F1 on Corr2Cause is at or below pure-Haiku-with-no-memory, that goes in the notes verbatim. We do not file this away.
  4. A second variant run with Graph C *disabled* (causal agent skipped) is produced in the same session, so the lift attributable to Graph C is visible side-by-side.
- **Estimated model cost per run:** Corr2Cause is the larger of the two — at 5K sample, ~5K Haiku calls + ~5K Sonnet judge calls (the judge is mostly trivial here because answers are structured Y/N or multiple-choice). Order: $5–10 per run.
- **Estimated eng cost:** 1 week for both. Most of the harness is shared between them.

### 2.3 LOCOMO — long-term conversational memory

- **Upstream:** [`github.com/snap-research/locomo`](https://github.com/snap-research/locomo). Submodule at `benchmarks/locomo/upstream/`.
- **Dataset:** Synthetic multi-session dialogues, up to 32 sessions, ~600 turns each, ~16K tokens, multi-month timelines.
- **Pre-registered cut:** Full QA track. **Metric variant explicit: J-score**, the one Zep/Mem0 fought over, with F1 reported as a secondary so we have an internal cross-check. Landscape doc §1.4 names this dispute explicitly.
- **What it tests in Mnemo terms:** Multi-month conversation memory. The dataset's causal+temporal event seeding lines up with Graph C; bi-temporal facts should help "what did the user know in week 3 vs week 12" style questions.
- **Ingest path:** Same shape as LongMemEval (`/ingest` per session turn, `/query` per question). The chat-ingest infrastructure built for LongMemEval is reused directly — ~80% reuse is the working assumption.
- **Acceptance for first baseline run:**
  1. End-to-end run on the full LOCOMO QA track.
  2. JSON result with J-score (primary) and F1 (secondary), broken out by category if the upstream supports it.
  3. Trend markdown regenerated.
- **Estimated model cost per run:** Heavier than LongMemEval because sessions are longer. Order: $10–30 per full run.
- **Estimated eng cost:** 2 weeks. Mostly LOCOMO-specific glue; the chat ingest and judge come free from LongMemEval.

### 2.4 GraphRAG-Bench — graph-RAG over documents

- **Upstream:** [`github.com/GraphRAG-Bench/GraphRAG-Benchmark`](https://github.com/GraphRAG-Bench/GraphRAG-Benchmark). Dataset on HuggingFace. Submodule at `benchmarks/graphrag/upstream/`.
- **Dataset:** Domain-specific document corpora + reasoning QA, with consistent token/latency accounting across systems.
- **Pre-registered cut:** Default `easy` + `hard` splits, both reported. We do not subsample.
- **Metric:** Whatever the harness emits as its canonical scores (accuracy, F1, token efficiency). Captured verbatim in the JSON.
- **What it tests in Mnemo terms:** Whether Mnemo holds up against Microsoft GraphRAG, LightRAG, HippoRAG, and HippoRAG2 inside a shared harness. **GraphRAG-Bench's value is precisely that it brings the comparators with it** — we do not have to wire any of them ourselves. That said, we are not running those comparators for *competitive* claims; we are running them to know where Mnemo sits inside this category.
- **Ingest path:** Documents (not chat) → `/ingest`. Different from LongMemEval/LOCOMO. Reuses `_common/client.py` but the per-document framing is new.
- **Acceptance for first baseline run:**
  1. End-to-end run on `easy` + `hard` splits.
  2. JSON result with Mnemo's scores + the bundled comparators' scores (since the harness produces them in one shot).
  3. Trend markdown shows Mnemo's column alongside the comparators'; commentary explicitly names this as a snapshot, not a competitive claim.
- **Estimated model cost per run:** Depends on corpus size. Order: $10–30, plus whatever the bundled comparators cost (most use embedding-only retrieval, so cheap).
- **Estimated eng cost:** 1–2 weeks. New ingest path is the main work.

### 2.5 CronQA — bi-temporal facts under direct test

- **Upstream:** CronQuestions, Saxena et al., ACL 2021 + extensions. [`aclanthology.org/2021.acl-long.520`](https://aclanthology.org/2021.acl-long.520/). Submodule at `benchmarks/cronqa/upstream/`.
- **Dataset:** Temporal KGQA — largest in the category, 340× prior. Lookups → multi-hop temporal reasoning.
- **Pre-registered cut:** Full eval set. Both the simple-lookup and multi-hop subsets reported separately.
- **Metric:** Accuracy + Hits@1, the standard for the dataset.
- **What it tests in Mnemo terms:** "Right answer changes over time" — exactly what bi-temporal facts (valid-time + transaction-time) encode. Most directly aligned of the five with Mnemo's data model.
- **Ingest path:** KG triples with temporal annotations → `/ingest`. New ingest path, no reuse from chat-ingest or document-ingest. Some glue work to map the dataset's temporal annotations onto Mnemo's valid-time fields.
- **Acceptance for first baseline run:**
  1. End-to-end run on the full eval set.
  2. JSON result with accuracy + Hits@1 for simple lookup and multi-hop subsets.
  3. Trend markdown regenerated.
  4. **Sanity check unique to CronQA:** at least one question per multi-hop bucket is manually inspected to confirm the temporal join landed correctly. Bi-temporal correctness is silent when wrong; a passing accuracy number with wrong joins is a possibility worth catching.
- **Estimated model cost per run:** Lighter than the chat benchmarks. Order: $5–10.
- **Estimated eng cost:** 1 week.

---

## 3. Acceptance criteria — overall

The plan is "done" (in the sense that the cycle of baselining is live) when:

1. All five per-benchmark `run.py` invocations complete end-to-end without manual intervention.
2. All five have a baseline JSON checked in under `/benchmarks/results/{benchmark}/runs/`.
3. `/docs/benchmarks/results/README.md` shows the latest score for each.
4. Each per-benchmark `.md` has at least the baseline row in its trend table.
5. The Graph C reality-check from §2.2 has produced a clear yes/no answer to "does the causal layer lift over no-memory baseline" — recorded in the LOCOMO and Corr2Cause notes.

This is **5–8 weeks of work in serial execution**, with the chat-ingest infrastructure (built once for LongMemEval) carrying most of the way through LOCOMO.

---

## 4. Sequencing rationale

In execution order:

1. **LongMemEval** — most signal about Mnemo's current state, builds the chat-ingest + judge harness everything else reuses.
2. **Corr2Cause + CLadder** — cheap, doesn't depend on chat ingest, answers the Graph-C-is-real-or-theatre question *before* we sink 2 weeks into LOCOMO's causal-edge story.
3. **LOCOMO** — leverages LongMemEval infra (~80% reuse), closes the long-term-memory axis.
4. **GraphRAG-Bench** — new ingest path (documents) but brings its own comparator zoo.
5. **CronQA** — cleanest direct test of bi-temporal facts, lowest infra reuse.

Serial assumption: one engineer / agent driving. If we want to parallelise — e.g. Corr2Cause + CLadder running while LOCOMO infra is being wired — the only cross-cutting risk is `_common/judge.py` evolving under both at once. Manage that with a lock-the-judge-API checkpoint after LongMemEval lands.

---

## 5. What's intentionally NOT in this plan

- **Cross-vendor comparator reruns** (running Zep, Mem0, HippoRAG2 ourselves on our harness). Out of internal-baselining scope. Gated behind any decision to publish externally.
- **BEAM** (1M / 10M tokens). Single-vendor benchmark. Wait for independent reproducibility before committing engineering time.
- **WDC Products / DMR / MTEB / BEIR**. Either deprioritised in `landscape.md` or context-only.
- **Letta Leaderboard**. Emerging, not standardised.
- **Test of Time, TempReason, TimeBench**. Already covered conceptually by CronQA for temporal; ablations possible later if a specific subset becomes interesting.
- **HotpotQA, ComplexWebQuestions**. Saturated or legacy.

---

## 6. Open follow-ons

These become beads after the first full baseline cycle completes — not before.

- **Cron / continuous baselining.** Once `run.py` is stable per benchmark, wire each to the existing `schedule` skill so a weekly cron emits a new JSON and dashboard regenerates. No code changes — just a schedule entry.
- **Regression CI gate.** A simple "fail the PR if {benchmark} score drops by > X% vs the prior committed baseline." Cheap to add once the JSON schema is stable.
- **Cross-vendor comparator pass.** If we ever go from "internal baselining" to "external publication", re-run Zep / Mem0 / HippoRAG2 on our harness with identical backbones. Big work envelope; scope it then, not now.
- **GPT-4o-mini "publication backbone" pass.** Same gating as above.
- **BEAM** if independent reproducibility lands.
- **Letta Leaderboard** if it stabilises and gains cross-vendor numbers.

---

## 7. Beads scaffolding (the next deliverable after this doc)

This doc is the contract. The beads epic + per-benchmark child issues are the work tracker. Proposed shape, to be filed once this doc is signed off:

- **Epic:** "Benchmark baselining cycle — LongMemEval, Corr2Cause+CLadder, LOCOMO, GraphRAG-Bench, CronQA"
- **Child issues, in dependency order:**
  1. Set up `/benchmarks/` workspace + `_common/` (client, judge, results writer, dashboard generator) — blocks all per-benchmark issues.
  2. LongMemEval baseline (depends on 1)
  3. Corr2Cause baseline (depends on 1)
  4. CLadder baseline (depends on 1)
  5. LOCOMO baseline (depends on 2)
  6. GraphRAG-Bench baseline (depends on 1)
  7. CronQA baseline (depends on 1)

Each child's acceptance criteria pull directly from the relevant per-benchmark §2 spec.
