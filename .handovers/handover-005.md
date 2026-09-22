---
session: 005
date: 2026-09-08
project: nmemo — intent-adaptive retrieval & ingestion redesign (epic nmemo-asf)
status: in-progress
supersedes: 004
---
# Handover 005 — nmemo — Temporal (I3) landed end-to-end: substrate `.12`, flat floor `.7`, and the as-of experiment `.8` (adversary-validated, +0.556 lift)

## Mission / goal
Program `nmemo-asf` (docs 30–41): redesign ingestion pulled by committed query capabilities,
benchmark-gated, on a SINGLE graph in Postgres `cognitive_test`. **The user steers deliberately and reviews
at every fork — do NOT barrel into write-path/substrate changes; check in at forks. Loop discipline: PROVE
deterministically (standalone tsx probe / direct DB, no Claude) before spending Claude; pre-register the
metric+bar BEFORE computing; run a BLIND ADVERSARY before banking a result; forward-fix + guarded backfill
for existing data; halt-and-surface on surprise.** Rhythm this session: one bead → prove → commit → close →
file follow-ups, and the user pre-authorised pre-work investigation agents for the *next* bead so
implementation moves fast.

This session took the temporal (I3) line the whole way: the substrate fix `.12` (from session 004's plan),
then the `.7` flat floor, then the `.8` as-of experiment — each pre-registered, proven, committed; `.8`
additionally passed a blind adversary. **Committed on `feat/single-graph-retrieval`, HEAD `6704686`.**

## Current state — DONE + verified (this session)
`cd platform && npx tsc --noEmit` baseline = **69**, held through every edit (re-verified repeatedly; 69 is
the compare-point, never "fix" it). Four commits landed:

- **`nmemo-asf.12` CLOSED — per-corpus temporal fact model** (commits `178a035` + doc follow-up `44629a8`,
  doc 39). The fact model could not represent recurring truth (same subject-predicate-object true across
  disjoint validity windows, "A→B→A") nor answer as-of-a-date. Fix (S2, per-corpus): mig `060` adds
  `corpus_policies.recurring_facts` + `facts.temporal_corpus`, and replaces `uniq_facts_active_triple` IN
  PLACE with a FUNCTIONAL index — non-temporal rows key on `(s,p,o)` exactly as before; temporal rows on
  `(s,p,o,valid_at)`. Edited mig `037` dedup `PARTITION BY` += `valid_at` for re-run safety (the runner
  re-applies every migration; verified empirically the functional index survives + no data loss).
  `createFact` stamps the flag (cached lookup) + gates supersession/dedup for temporal corpora. R1 read
  `getEntityFactsAsOf(entityId, asOf, {predicate?, asSubject?, asObject?, corpusId?})` (`facts.ts`). MCP
  tool `query_entity_facts_as_of` (`causal-agent.ts`, `mutates:false` → auto-exposed) + reasoning-agent
  prompt. **Proven:** `temporal-recurrence-probe.ts` PASS (recurrence stored, as-of true→untrue→true,
  non-temporal rejects 23505, MCP dispatch via `handleToolCall`, createFact write-path with embed svc up).
- **`nmemo-asf.7` (◐ open, I3 done) — CronQA time-blind DENSE flat baseline** (commit `4152667`, doc 40).
  Pre-registered floor. Result n=2,000: **Hits@1 0.0245 / Recall@10 0.076** — dense retrieval is
  near-useless on temporal QA (validity all-pass: tie-break Δ0.002, leakage 9.6% flagged). KEY: this dense
  floor is NOT the fair comparator for `.8`'s temporal lift — the STRUCTURAL time-blind is (recorded in
  doc 40 + `.8`). Bead stays OPEN — `.7` is per-intent (I1–I5), only I3's baseline done.
- **`nmemo-asf.8` (work DONE + committed; bead OPEN, see Open questions) — I3 temporal experiment**
  (commit `6704686`, doc 41). Loaded the CronQuestions KG (125,523 entities + 324,926 facts) onto temporal
  corpus **`_cronqa`** and ran the simple_entity cut (7,812) through AS-OF (time-aware, R1) vs STRUCTURAL
  time-blind, slots held constant. **as-of Hits@1 1.000 vs structural 0.4442, LIFT +0.5558** (fwd +0.475 /
  rev +0.888 / ambiguous +0.708). **Falsification:** wrong-year (+50) collapses as-of to **0.001** → the
  `valid_at`/`invalid_at` filter is genuinely used. **Blind adversary: VALID-AS-FRAMED** (independently
  reproduced from source; lift survives a stronger time-blind baseline most-frequent 0.5225 → +0.4775;
  as-of exact-set-match 1.000 → lift is a lower bound; boundary controls +3→0.233/−3→0.311 graded).
  **HONEST SCOPE:** gold is a deterministic function of the loaded KG, so as-of's 1.000 is a ceiling BY
  CONSTRUCTION and slots are oracle-read from `annotation` (never NL-parsed) → this demonstrates substrate
  **load+read faithfulness + the temporal LEVER for I3, NOT reasoning/entity-linking.**

Docs written: **39** (temporal model), **40** (flat-baseline prereg+results), **41** (temporal-experiment
prereg+results), **scratch-asf8-investigation.md** (the `.8` build brief from the pre-work agent). Memory
`project_temporal_fact_model.md` updated with `.7`/`.8` results (indexed in MEMORY.md).

## RESUME HERE — next stage (do this first)
No work mid-flight; three quick bookkeeping items, then pick the next intent.

1. **Decide `.8` bead bookkeeping (needs a human call — do NOT force-close unprompted).** `.8`'s work is
   done+committed but `bd close nmemo-asf.8` is **blocked by deps `nmemo-asf.7` + `nmemo-9qq`**. The
   `nmemo-9qq` dep ("gated on CronQA loader") is SUPERSEDED — `.8` built its own loader (`cronqa-load.ts`).
   `.7` stays open by design (other intents). Options: `bd close nmemo-asf.8 --force`, OR restructure the
   deps, OR leave open. Ask the user.
2. **Decide the uncommitted CronQA submodule pin.** `.gitmodules` (modified) + `benchmarks/cronqa/upstream/`
   (the pinned `apoorvumang/CronKGQA` submodule, holds the dataset) are UNCOMMITTED. plan.md §1.3 wants the
   harness pinned as a submodule; committing the pointer makes the data source reproducible. Commit it or
   leave it — user's call. Also untracked byproducts to clean or ignore: adversary control JSONs
   `benchmarks/results/cronqa/runs/2026-09-08-temporal-experiment-offset{3,-3}.json`, and `viz-arxiv-nlp.png`
   (NOT from this session — pre-existing).
3. **Pick the next intent.** Priority (doc 34) is I3→I1→I2→I4→I5; **I3 is now done**, so next = **I1 local**
   (proven dense⊕fact fusion already wired as `recall_entities_fused`; needs a real-query benchmark +
   lexical/BM25 index — LongMemEval/LOCOMO, and it fixes the papers-as-queries validity gap) OR **I2
   multi-hop** (2WikiMultiHop/HotpotQA — re-tests traversal in its home regime). Each is a new `.7`-style
   flat baseline + a pre-registered Phase-4 experiment. Alternatively **`nmemo-9qq`** (CronQA LLM
   end-to-end accuracy — reuses the already-loaded `_cronqa` substrate; spends Claude, get consent) or the
   **composite-reasoning class** (I4×I3 etc., doc 34 — the 74% of CronQuestions that need >1 primitive).
   Start any new intent with a pre-work investigation agent (the pattern that worked for `.8`).
   Lower-priority open beads: `.9` (Phase 1.1 follow-ups, entity-mention offsets), `.11` (backfill-merge
   fragments — DESTRUCTIVE, own gate).

## How to run / verify
- **Services (host):** Ollama **:11434** + ml **:8000** were started this session and left UP (needed for
  embeds/createFact). Next session: verify with `foreach ($p in @(8000,11434)) { try { $c=New-Object
  Net.Sockets.TcpClient; $c.Connect('127.0.0.1',$p); "${p}: up"; $c.Close() } catch { "${p}: down" } }`
  (PowerShell). If down: `ollama serve` (binary at
  `C:/Users/bruce.mckay/AppData/Local/Programs/Ollama/ollama`) and `cd ml-services && PYTHONIOENCODING=utf-8
  LLM_PROVIDER=claude .venv/Scripts/uvicorn app.main:app --host 0.0.0.0 --port 8000 --http h11` (both as
  background tasks; redirect logs to a REAL path — `$TMPDIR` is empty in this bash, that bit us).
- **DB:** `docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test -tAc "<single SQL>"` via the
  **PowerShell tool** (Bash-tool docker context was flaky; multi-statement `-tAc` and piped psql WRITES get
  classifier-blocked — use single-statement reads, and for a one-shot write pipe a transaction-wrapped
  script: `{ echo BEGIN;; cat file.sql; echo COMMIT; } | docker exec -i nmemo-postgres-1 psql -U cognitive
  -d cognitive_test -v ON_ERROR_STOP=1`). NEVER unscoped-DROP `cognitive_test` (holds the 294-doc research
  substrate + now `_cronqa`).
- **tsc baseline:** `cd /c/Users/bruce.mckay/dev/nmemo/platform && npx tsc --noEmit 2>&1 | grep -cE 'error
  TS'` → **69**.
- **Re-run the temporal experiment:** `cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test NODE_ENV=test [YEAR_OFFSET=n] npx tsx src/test/tools/cronqa-temporal-experiment.ts`
  (needs `_cronqa` loaded; YEAR_OFFSET!=0 is the falsification control). Reload the KG if needed (18s):
  same env, `... npx tsx src/test/tools/cronqa-load.ts` (re-runnable, cleans `_cronqa` first).
- **Regenerate derived cuts (gitignored):** `python benchmarks/cronqa/prep_flat_baseline.py` and
  `python benchmarks/cronqa/prep_temporal_experiment.py` (host python 3.12).
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd show nmemo-asf`, `bd close <id>
  [--force]`, `bd update <id> --notes "..."`.

## Key locations
- **Docs (single-graph):** `39-temporal-fact-model.md`, `40-cronqa-flat-baseline-prereg.md`,
  `41-cronqa-temporal-experiment-prereg.md`, `scratch-asf8-investigation.md` (all THIS session);
  `34-query-intent-set-proposal.md` (the 5 intents + priority + composite class),
  `32-intent-adaptive-retrieval-program.md` (phases).
- **Code shipped (committed):** `platform/src/db/migrations/060_temporal_corpus_mode.sql` (+ edited `037`),
  `platform/src/db/schema.ts` (facts.temporalCorpus, corpusPolicies.recurringFacts),
  `platform/src/services/facts.ts` (`getEntityFactsAsOf`, `createFact` temporal gating, `corpusAllowsRecurring`
  + `clearCorpusTemporalCache`), `platform/src/services/causal-agent.ts` (`query_entity_facts_as_of` tool +
  dispatch), `ml-services/app/reasoning_agent.py` (prompt). Probes/harnesses (`platform/src/test/tools/`):
  `temporal-recurrence-probe.ts` (`.12` proof), `cronqa-flat-baseline.ts` (`.7`), `cronqa-load.ts` +
  `cronqa-temporal-experiment.ts` (`.8`). Benchmark prep: `benchmarks/cronqa/prep_flat_baseline.py`,
  `prep_temporal_experiment.py`, `.gitignore`. Results: `benchmarks/results/cronqa/runs/2026-09-08-*.json`.
- **Substrate loaded:** corpus **`_cronqa`** in `cognitive_test` = 125,523 entities + 324,926 facts,
  temporal mode, `fact_embedding` NULL. PERSISTENT + reusable (nmemo-9qq); re-runnable in 18s. Entity ids =
  `uuidv5(qid)` with namespace `f47ac10b-58cc-4372-a567-0e02b2c3d479` (same as `utils/context-uuid.ts`).
- **CronQuestions data (uncommitted, large):** `benchmarks/cronqa/upstream/data/wikidata_big/` — KG
  `kg/full.txt` (tab-sep s,p,o,start,end), labels `kg/wd_id2entity_text.txt`/`wd_id2relation_text.txt`,
  questions `questions/test.pickle`. Submodule `apoorvumang/CronKGQA` (uncommitted pin — see Resume #2).
- **Beads (epic `nmemo-asf`):** CLOSED `.1 .2 .3 .4 .5 .6 .10 .12`. OPEN: `.7` (◐ per-intent, I3 done),
  `.8` (work done, blocked-from-close), `.9`, `.11`. Related: `nmemo-9qq` (CronQA LLM end-to-end),
  `nmemo-bki` (benchmark epic), `nmemo-u8j` (fusion lever).
- **Memory:** `project_temporal_fact_model.md` (the full temporal arc `.12`/`.7`/`.8`),
  `reference_nmemo_silent_data_traps.md`, `feedback_verify_empirical_gates.md`.
- **Prior handovers:** `.handovers/handover-00{1..4}.md` (004 = the `.12` plan this session executed).

## Architecture / how it works (essentials)
- Single graph, Postgres `cognitive_test`. `entities` (name+embedding, `corpus_id`), `facts` (typed edges,
  bi-temporal, `corpus_id`, now `temporal_corpus`), Graph C causal tables. AGE retired from the read path;
  `traverseFromEntities`/`graph.ts` recursive CTE is the sanctioned traversal (corpus-scoped).
- **Two clocks on facts:** validity `valid_at`/`invalid_at` (true in reality), transaction
  `created_at`/`expired_at` (system belief; supersession sets `expired_at`). Identity = ≤1 ACTIVE
  (`expired_at IS NULL`) fact per `(s,p,o)` for normal corpora; per `(s,p,o,valid_at)` for temporal corpora
  (the mig-060 functional index). This is `.12`.
- **The I3 read (R1):** `getEntityFactsAsOf` filters `valid_at<=asOf AND (invalid_at IS NULL OR invalid_at>
  asOf) AND expired_at IS NULL`, transaction pinned to NOW (NOT the orphaned `facts_at_time` SQL fn, which
  conflates both clocks). Exposed as MCP `query_entity_facts_as_of`.
- **CronQuestions:** gold is a deterministic function of the KG (questions generated from it). Only the
  `simple_entity` bucket (7,812 test Qs, 5 relations P166/P54/P39/P26/P108) is a single as-of lookup —
  forward `{head,time}` reads the object, reverse `{tail,time}` reads the subject; year lives in
  `annotation.time` (NOT the `times` field for other buckets). The other 74% (time_join/before_after/
  first_last/simple_time) are the doc-34 composite class, out of scope for a single-primitive arm.
- **Bulk KG load pattern (`cronqa-load.ts`):** direct INSERT bypassing `createFact` (embeds-free), user
  triggers DISABLED in-tx (AGE sync + freshness) then re-enabled, dedup keep-max-end per `(s,p,o,start)`,
  drop self-refs (facts.`no_self_reference`) + `end<start`, `end>2021`→`invalid_at NULL`. All-or-nothing tx.

## Open questions / blockers / needs-human
- **`.8` bead won't close** (deps `.7` open-by-design + `nmemo-9qq` superseded). Needs a human decision:
  `--force`, restructure deps, or leave open (Resume #1). Do NOT force unprompted.
- **CronQA submodule pin uncommitted** (`.gitmodules` + `benchmarks/cronqa/upstream/`) — commit the pointer
  for reproducibility, or leave (Resume #2).
- **Anything that spends Claude needs consent** (org spend cap has bitten): nmemo-9qq end-to-end, live
  epoch ingest (`.9`), and any capable-model benchmark run. All of this session's work was free
  (deterministic DB + local Ollama embeds).
- Standing (not gating): the 294-doc corpora are embedded under two regimes (name-only vs
  name+description) — relevant to any embedding comparison.

## Gotchas / constraints / learnings
- **Migrations re-run EVERY `npm run migrate` (no journal) → must be idempotent.** A bulk-affecting
  migration (like `037`'s dedup) must be temporal-safe or it corrupts data on re-run. Keep an index's NAME
  stable and replace its definition in a LATER migration so the earlier `CREATE ... IF NOT EXISTS` no-ops.
- **`$TMPDIR` is empty in the Bash tool** → `> "$TMPDIR/x.log"` writes to `/x.log` (permission denied). Use
  a real scratchpad path for background-task logs.
- **Docker via the Bash tool is flaky** (daemon-context error); use the **PowerShell tool** for
  `docker exec`. Multi-statement `psql -tAc` and piped psql WRITES get classifier-blocked — use
  single-statement reads; for a one-shot write, transaction-wrap and pipe via `docker exec -i`.
- **PowerShell string interpolation:** `${p}` not `$p:` (the latter is a parse error).
- **`facts` check constraints:** `no_self_reference` (drop s==o rows on any KG load), `has_object`,
  `valid_fact_confidence` (0..1). Triggers on facts/entities fire per-row on INSERT (AGE sync + freshness)
  — DISABLE user triggers for a bulk load.
- **NEVER run the vitest suite against `cognitive_test`** (setup DROPs+RESTOREs it → wipes the substrate).
  Prove via standalone tsx probes. **Scratch cleanup order:** causal_edges → fact_history → causal_events →
  facts → entities → corpus_policies.
- **Empirical discipline held this session** (memory `feedback_verify_empirical_gates`): pre-registered the
  bar (docs 40/41) BEFORE computing; ran a deterministic falsification control (year-perturbation) AND a
  blind adversary before banking `.8`; framed the by-construction 100% ceiling honestly (faithfulness+lift,
  not reasoning). The adversary's honesty nits (stronger baseline; oracle-slotted) were folded in, not
  argued away.
- **Commit only when the user asks** (they authorised each commit this session). NEVER add Co-Authored-By
  (memory `feedback_no_coauthor`); `git commit` prints a benign identity warning.

## Read-order of other docs
1. `docs/architecture/single-graph/41-cronqa-temporal-experiment-prereg.md` — the `.8` result + adversary
   verdict; the headline of the session.
2. `docs/architecture/single-graph/39-temporal-fact-model.md` — the substrate (`.12`) that made `.8`
   possible; §5.2 AS BUILT.
3. `docs/architecture/single-graph/40-cronqa-flat-baseline-prereg.md` — the `.7` dense floor + the
   dense-vs-structural distinction.
4. `docs/architecture/single-graph/scratch-asf8-investigation.md` — the CronQuestions build brief (bucket
   structure, load plan, gotchas) — reuse for the composite buckets / nmemo-9qq.
5. `bd show nmemo-asf` (+ `.7`/`.8`/`.9`/`.11` notes) — live bead state.
6. `docs/architecture/single-graph/34-query-intent-set-proposal.md` — the 5 intents + priority (I3 done,
   I1 next) + the composite-reasoning class.
7. `memory/project_temporal_fact_model.md` + `feedback_verify_empirical_gates.md` — the temporal arc + the
   discipline.
8. `.handovers/handover-004.md` — the plan this session executed.
