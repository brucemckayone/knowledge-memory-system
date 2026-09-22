---
session: 004
date: 2026-09-07
project: nmemo — intent-adaptive retrieval & ingestion redesign (epic nmemo-asf)
status: in-progress
supersedes: 003
---
# Handover 004 — nmemo — I3 temporal work: found the fact model can't hold recurring truth; designed the fix (doc 39, bead .12), verified every assumption; build not started

## Mission / goal
Program `nmemo-asf` (docs 30–39): redesign ingestion pulled by committed query capabilities,
benchmark-gated, on a SINGLE graph in Postgres `cognitive_test`. **The user steers deliberately and
reviews at every fork — do NOT barrel into production/write-path changes; converge on findings, check in
at forks. Loop discipline: prove DETERMINISTICALLY (standalone tsx probe / direct DB, no Claude) before
spending Claude; forward-fix + separate guarded backfill for anything touching existing data; halt-and-
surface on surprise.** Org Claude spend cap has bitten — keep Claude-heavy work minimal; all this session's
work was free (direct DB reads + a dataset download + docs). This session took `nmemo-asf.7` (Phase-3
temporal benchmark harness), and while grounding it discovered a substrate gap that redirected the work
into designing a temporal-model fix (`nmemo-asf.12`). No code was written — this was a design/planning
session, ending at a clean seam before the (gated) build.

## Current state — DONE + verified (this session)
Branch `feat/single-graph-retrieval`, HEAD **`029f653`** (unchanged — no commits this session). **No
platform code touched** → `cd platform && npx tsc --noEmit` baseline stays **69** (not re-run; holds
because only docs/`benchmarks/`/memory changed). Working tree has uncommitted additions (see Key locations).

What happened, in order:
1. **Picked up `.7` (Phase 3: per-intent benchmark harness + flat baseline).** Claimed it (`bd update
   nmemo-asf.7 --claim` → shows ◐). Grounded it in docs 32/34 + the two eval homes:
   - `benchmarks/` (Python, the `nmemo-bki` workspace) calls Mnemo over **HTTP** (`/ingest`+`/query`),
     Haiku system + Sonnet judge — the Claude-spending end-to-end path. Shared JSON envelope in
     `_common/results.py`; contract in `docs/benchmarks/plan.md`.
   - `platform/src/test/tools/retrieval-eval/` (TS) — the papers-as-queries target-finding harness from
     the retrieval loop. Its metric primitives (`core.ts`: recall@k, cluster bootstrap, RRF, oracles,
     BM25) are dataset-agnostic and reusable; its `data.ts` loader is papers-specific.
   - **Two forks decided by the user:** (i) acquire CronQA now (the committed I3 benchmark; not on disk);
     (ii) put the flat baseline in TS by extending `retrieval-eval`. "Unify with nmemo-bki" = shared
     substrate + dataset cut + JSON envelope, NOT shared code (the flat baseline is deterministic/free; the
     LLM end-to-end number stays in bead `nmemo-9qq`).
2. **Acquired CronQuestions** (deterministic, free). Added submodule `benchmarks/cronqa/upstream` →
   `github.com/apoorvumang/CronKGQA`; `gdown` (installed via `python -m pip install gdown`, v6.1.1)
   fetched `data_v2.zip` (83.5M, no Google-Drive quota wall) and unzipped. Skipped `models.zip` (trained
   checkpoints, irrelevant to retrieval). Data lives at `benchmarks/cronqa/upstream/data/wikidata_big/`.
   Inspected the real schema:
   - KG `kg/full.txt`: **328,635 rows**, tab-separated `subject_qid⇥relation_pid⇥object_qid⇥start_year⇥
     end_year`. Labels: `kg/wd_id2entity_text.txt` (Qid→name), `kg/wd_id2relation_text.txt` (Pid→name).
   - Questions `questions/{train,valid,test}.pickle`: `test.pickle` = 30,000 dicts. Fields: `question`
     (QIDs inline, NOT names), `paraphrases` (names, but encoding-corrupted), `answers` (a SET of QIDs or
     years), `answer_type` (entity 19,524 / time 10,476), `type` bucket (first_last 11,159 / simple_entity
     7,812 / simple_time 5,046 / time_join 3,832 / before_after 2,151), `entities`, `relations`, `times`,
     `template`, `annotation` (head/tail/adj), `uniq_id`.
3. **Discovered + verified the substrate gap** (the pivot). CronQuestions has **284,892 distinct (s,p,o)
   triples but 328,635 rows** — ~43,700 rows (13%) are extra validity windows on **22,343 multi-window
   triples** (same subject-predicate-object true across disjoint year-spans; up to 70 windows). Mnemo's
   fact model can't represent this: `uniq_facts_active_triple` (mig 037) allows **≤1 active fact per
   (s,p,o)** (no `valid_at` in the key), the read path only returns "true now", and no MCP tool can ask an
   as-of-a-date question. **True→untrue→true (a recurring statement) is not faithfully storable OR
   answerable today.** Surfaced this to the user, who steered work onto fixing the temporal model.
4. **Wrote design doc `docs/architecture/single-graph/39-temporal-fact-model.md`** — fully grounded, no
   code. User DECIDED the storage approach: **S2 (per-corpus temporal mode)** over S1 (global index
   change) / R2 (read-only hack). Full plan = **S2 + R1 (as-of-validity read) + an MCP as-of tool**.
5. **Ran the §7 pre-build verifications** (free, deterministic — the user chose to do these before any
   migration). Results recorded in doc 39 §7. Key result: **0 of 18,084 (s,p,o) groups in the whole
   research substrate have >1 distinct `valid_at`** (over ALL rows incl. expired) → extraction never
   produces recurrence, so S2's containment is clean. Consumers of the active-triple assumption enumerated;
   `invalid_at` boundary convention pinned; supersession-under-S2 resolved by gating.
6. **Filed bead `nmemo-asf.12`** (temporal-model substrate; gated). **Saved memory**
   `project_temporal_fact_model.md` + MEMORY.md index line.

## RESUME HERE — next stage (do this first)
The plan is complete and de-risked; the **build of `nmemo-asf.12` has NOT started**. It is GATED
(schema + write-path) — do NOT start without confirming the user still wants to proceed (they were
choosing between building now and this handover; they chose the handover, so re-confirm intent on
resume). When cleared, build increment-by-increment with check-ins, proving deterministically:

1. **Migration (new file, next number after 058 — check `platform/src/db/migrations/`).** Per doc 39 §5.1:
   (a) add `recurring_facts BOOLEAN NOT NULL DEFAULT false` to `public.corpus_policies` (mig 055);
   (b) add a denormalized `temporal_corpus BOOLEAN` column to `public.facts`, stamped at insert from the
   corpus policy; (c) **split** `uniq_facts_active_triple` into two partial indexes — non-temporal
   (`… WHERE expired_at IS NULL AND temporal_corpus = false`, byte-identical to today) + temporal
   (`(subject, predicate, object…, valid_at) WHERE expired_at IS NULL AND temporal_corpus = true`).
   Remember the AGE `search_path` rule: qualify `public.` on all DDL (CLAUDE.md). Do NOT run via the
   migration runner against `cognitive_test` casually; apply carefully.
2. **App change:** `createFact` (`platform/src/services/facts.ts`) — for a temporal corpus, the dedup
   fast path (`findActiveTriple`, :172-236) must key on `valid_at` too (or skip corroboration), and the
   exclusive-group supersession path (:163-168, :315-358) must be gated OFF. Add a `temporal_corpus`
   lookup (from `corpus_policies`) and stamp the fact column on insert.
3. **R1 read:** build a real as-of-validity read — `valid_at <= Yts AND (invalid_at IS NULL OR invalid_at
   > Yts) AND expired_at IS NULL` (transaction pinned to NOW). Note `facts_at_time()`
   (`001_consolidated.sql:300`) is orphaned AND conflates both clocks (returns nothing for a
   today-loaded historical KG) — do not reuse it as-is.
4. **MCP tool:** expose `query_entity_facts_as_of` (entity, `as_of` ISO date, optional predicate),
   `mutates:false` → auto-exposed via the `GRAPH_TOOLS`/`mutates` derivation (the `recall_entities_fused`
   precedent, doc 37). Corpus-scoped via `context.corpusId` (env carrier, doc 36), NOT a tool arg. Add to
   the reasoning-agent prompt (`ml-services/app/reasoning_agent.py`) as the I3 temporal primitive.
5. **Deterministic probe (no Claude), pattern = `platform/src/test/tools/*-probe.ts`:** create a scratch
   corpus flagged temporal, load a small recurring-fact fixture (A→B→A: same s,p,o over 2 disjoint
   windows + a gap), assert (a) both windows persist as live (index allows it), (b) the as-of read returns
   the right window for each year across the true→untrue→true sequence, (c) a NON-temporal scratch corpus
   still collapses recurrence (unchanged). Self-clean (see cleanup order in Gotchas).

Only AFTER `.12` lands is `nmemo-asf.8` (Phase-4 I3 experiment) buildable. Separately, **`nmemo-asf.7`**
(the time-blind flat baseline) is still claimed (◐) but PARKED — it is NOT blocked by the temporal work
(a flat baseline ignores time); it can be resumed independently by building the CronQA loader in
`retrieval-eval` + a flat NAME/FACT/FUSION recall@k over the answer-entity subset. Pre-registered cut is
NOT yet written (owed if `.7` resumes): scope to entity-answer questions, break out by `type` bucket,
metric = any-answer Hits@1 + recall@10, reconstruct clean NL questions from template + labels (the raw
`question` has QIDs; `paraphrases` is encoding-corrupted).

## How to run / verify
- **DB (read/scratch):** `docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test -tAc "<SQL>"`
  (role `cognitive`, NOT postgres; psql not on host PATH; use PowerShell tool for docker, the Bash tool's
  docker context failed this session until Docker Desktop was reopened). NEVER unscoped-delete/DROP
  `cognitive_test` — holds the 294-doc substrate (qbio 3670, arxiv-cv 1282, arxiv-nlp 1230, dal-cv 1262,
  dal-nlp 1133, _concepts 668, default 382, + small cj/cr scratch).
- **tsc baseline:** `cd /c/Users/bruce.mckay/dev/nmemo/platform && npx tsc --noEmit 2>&1 | grep -cE 'error
  TS'` → must be **69** (compare-point, never "fix").
- **Run a probe (deterministic, no Claude), from `platform/`:**
  `DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text npx tsx src/test/tools/<probe>.ts`
- **Inspect CronQuestions:** `python -c "import pickle; d=pickle.load(open('benchmarks/cronqa/upstream/data/wikidata_big/questions/test.pickle','rb')); ..."` (Python 3.12 + uv on host).
- **Infra:** postgres :5433 (`nmemo-postgres-1`) + qdrant :6335 UP (came up when Docker Desktop reopened
  mid-session). **ml :8000 and ollama :11434 were DOWN** at session end (host services; ollama needed for
  any embedding probe — restart `Ollama.exe serve` + `uvicorn` on :8000). Platform HTTP server not
  running (not needed for probes).
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd show nmemo-asf`, `bd show
  nmemo-asf.12`, `bd update <id> --claim`, `bd close <id> --reason "..."`.

## Key locations
- **THIS SESSION's doc:** `docs/architecture/single-graph/39-temporal-fact-model.md` — the temporal-model
  design + decision (S2+R1+MCP) + §7 verification results + §5.1 concrete mechanism. START HERE.
- **CronQuestions data (uncommitted, large — keep OUT of git):** `benchmarks/cronqa/upstream/data/
  wikidata_big/` (`kg/full.txt` 10M, `questions/*.pickle` up to 229M, `data_v2.zip` 83.5M). Submodule
  `benchmarks/cronqa/upstream` added to `.gitmodules` (staged `A?`).
- **TS eval harness to extend for `.7`:** `platform/src/test/tools/retrieval-eval/{core,harness,data,arms,
  vector-store}.ts`.
- **Benchmark contract / Python workspace:** `docs/benchmarks/plan.md` (§2.5 CronQA), `benchmarks/_common/
  {client,judge,results,config}.py`, `benchmarks/longmemeval/` (the module pattern).
- **Code the `.12` build touches (all UNCHANGED this session):** `platform/src/services/facts.ts`
  (createFact dedup :172-236 + supersession :163-168,:315-358; expireFact :615-617; invalidateFact :710;
  searchFactsByVector :966-988), `platform/src/services/graph.ts` (LIVE_FACT :83), `platform/src/services/
  causal-agent.ts` (GRAPH_TOOLS registry; query_entity_facts :98), `platform/src/db/migrations/
  {037_fact_triple_unique,055_corpus_policies,001_consolidated}.sql`, `ml-services/app/reasoning_agent.py`.
- **Consumers of the active-triple assumption (doc 39 §7):** `facts.ts:172-236,304-309`, `pipeline.ts:1166`,
  `entities.ts:792-820` (merge dedup), `promotion-plan.ts:175` (epoch corroboration), `mcp-errors.ts:17`.
- **Beads (epic `nmemo-asf`):** CLOSED `.1 .2 .3 .4 .5 .6 .10`. OPEN: **`.12`** (temporal-model, THIS
  session, gated, ready to build), `.7` (◐ claimed/parked — flat baseline), `.8` (Phase-4 I3, gated on
  `.12`+CronQA), `.9` (Phase-1.1 follow-ups), `.11` (backfill-merge fragments). Related: `nmemo-9qq`
  (CronQA LLM end-to-end baseline, reuses the same loaded substrate), `nmemo-bki` (benchmark epic).
- **Memory:** `project_temporal_fact_model.md` (THIS session), `reference_nmemo_silent_data_traps.md`,
  `project_retrieval_loop.md`, `feedback_verify_empirical_gates.md`.
- **Prior handovers:** `.handovers/handover-00{1,2,3}.md`.

## Architecture / how it works (essentials)
- Single graph in Postgres `cognitive_test`: `entities` (name+desc+embedding 768, `corpus_id`), `facts`
  (typed edges + `fact_embedding` 768, bi-temporal, `corpus_id`), Graph C `causal_events`/`causal_edges`.
  Qdrant = raw source-text vectors. AGE retired from the read path (`graph.ts` = recursive CTE over
  `public.facts`; `traverseFromEntities` is the sanctioned primitive, applies a corpus filter when given
  `corpusId`).
- **Two clocks on facts:** validity (`valid_at`/`invalid_at` — true in reality; `invalidateFact` sets
  invalid_at) + transaction (`created_at`/`expired_at` — system belief; `expireFact`/supersession set
  expired_at=NOW()). Identity = ≤1 ACTIVE (`expired_at IS NULL`) fact per (subject, predicate, object) via
  `uniq_facts_active_triple` (mig 037) — NO valid_at in the key. This is the gap `.12` fixes for temporal
  corpora only.
- **Reads are "true now":** `LIVE_FACT = expired_at IS NULL AND (invalid_at IS NULL OR invalid_at >
  NOW())`. `facts_at_time()` exists (001:300) but is orphaned + conflates both clocks. No MCP as-of read.
- **MCP surface = the product:** read tools with `mutates:false` auto-expose to every actor on both
  transports; `corpusId` reaches read tools via `MNEMO_*` env carrier (doc 36), not a tool arg.
- **Ingest arms:** serial (`extract()` → graph_agent MCP tools) + epoch (`store()`→`propose()`→
  `promote()`). CronQuestions should load by a NEW direct structured write (it's already a KG — no LLM
  extraction), bypassing createFact's dedup/supersession for the temporal corpus.

## Open questions / blockers / needs-human
- **`.12` build is gated (schema + write-path) — needs explicit user go-ahead** before starting. Re-confirm
  on resume (they deferred it to write this handover; intent to build was implied but not the "go now").
- Still-owed at build time (doc 39 §7, mostly design assertions now): confirm `find_superseding_facts`
  untouched for non-temporal (gated OFF for temporal); enforce non-null `valid_at` on load; merge/epoch
  paths need `valid_at`-aware grouping IF a temporal corpus is ever merged/epoch-promoted (latent — the
  direct-write load does neither).
- CronQuestions data files are large + uncommitted — decide gitignore (should not be committed). The
  submodule pointer (`.gitmodules`) is a legitimate repo change.
- Standing substrate inconsistency (not gating): corpora embedded under two regimes (qbio/arxiv name-only,
  dal name+description) — relevant to any embedding comparison + `nmemo-u8j`.

## Gotchas / constraints / learnings
- **"SPO triple" plain-language rule:** the user found jargon confusing — explain fact identity as
  subject→predicate→object, and be precise that the limit is NOT "one fact per entity" (entities have many
  relationships) but "the same exact subject+predicate+object can't be live twice for two time windows."
- **NEVER run the vitest suite against `cognitive_test`** — `src/test/setup.ts`/`global-setup.ts` DROP+
  RESTORE it from a snapshot that predates the research corpora → would WIPE the substrate. Prove via
  standalone tsx probes only.
- **Scratch cleanup order** (FK): `causal_edges` → `fact_history` → `causal_events` → `facts` (CASCADE →
  fact_sources/units) → `entities` → staging. See any `*-probe.ts` `finally`.
- **Docker from the Bash tool failed** this session (`npipe … dockerDesktopLinuxEngine` — daemon not
  reachable) until Docker Desktop was reopened; use the **PowerShell tool** for `docker exec`.
- **PowerShell `$p:` in strings** is a parse error — use `${p}`. Single-quoted psql `-tAc` returning 0 rows
  prints nothing (not an error).
- **`platform/src/index.ts` has NUL bytes** → ripgrep skips it; use `grep -a` or Read.
- **`rawQuery` (`db/raw.ts`) camelCases result keys**; raw `db.execute(sql\`…\`)` returns snake_case.
- **AGE `search_path`:** new migration DDL must qualify `public.`; do not change session search_path
  (CLAUDE.md).
- **Bash cwd persists + drifts** — `cd /c/Users/bruce.mckay/dev/nmemo` for git, `.../platform` for
  tsx/tsc. Commit only when the user asks; NEVER add Co-Authored-By (memory `feedback_no_coauthor`).
- **Empirical discipline (memory `feedback_verify_empirical_gates`):** prove deterministically before
  Claude; a passed check needs a dumb baseline + a leakage control; a "0" that's true by construction
  (e.g. same-(s,p,o) among active rows) is NOT evidence — I caught + flagged one such tautological query
  this session (doc 39 §5.1 caveat).

## Read-order of other docs
1. `docs/architecture/single-graph/39-temporal-fact-model.md` — THIS session's plan + decision + §7
   verification. The whole point.
2. `bd show nmemo-asf.12` (+ `bd show nmemo-asf.7`, `nmemo-9qq`) — live bead acceptance/notes.
3. `docs/architecture/single-graph/34-query-intent-set-proposal.md` — the 5 committed intents (I3 first)
   + the composite-reasoning framing.
4. `docs/architecture/single-graph/32-intent-adaptive-retrieval-program.md` — the phase plan (Phase 3/4).
5. `docs/benchmarks/plan.md` §2.5 — the CronQA benchmark contract (the LLM end-to-end side, `nmemo-9qq`).
6. `memory/project_temporal_fact_model.md` + `feedback_verify_empirical_gates.md` — the finding + the
   discipline.
7. `.handovers/handover-003.md` — the Phase-1 foundations that preceded this (corpus scoping, fusion tool,
   causal backfill, entity identity).
8. CLAUDE.md "CURRENT DIRECTION" — standing project context.
