---
session: 006
date: 2026-09-08
project: nmemo — intent-adaptive retrieval & ingestion redesign (epic nmemo-asf)
status: in-progress
supersedes: 005
---
# Handover 006 — nmemo — I1 "local" started: fork decided (Path B), prereg frozen (doc 42), full LongMemEval run EMBEDDING IN BACKGROUND

## Mission / goal
Program `nmemo-asf` (docs 30–42): redesign ingestion pulled by committed query capabilities,
benchmark-gated, on a SINGLE graph in Postgres `cognitive_test`. **The user steers deliberately and reviews
at every FORK — do NOT barrel into write-path/substrate changes; check in at forks. Loop discipline: PROVE
deterministically (standalone tsx probe / direct DB, no Claude) before spending Claude; pre-register the
metric+bar BEFORE computing; run a BLIND ADVERSARY before banking a result; forward-fix + guarded backfill
for existing data; halt-and-surface on surprise. A NULL/negative result is a valid banked outcome.**
Priority order of intents (doc 34): I3→I1→I2→I4→I5. **I3 done (session 005). This session started I1.**
Committed on `feat/single-graph-retrieval`.

## Current state — DONE + verified (this session)
`git log --oneline -1` = **`24b5c46`** (submodule pin). `platform` tsc baseline is **69** errors (the
compare-point from session 005; NOT re-run this session — I made no edits to existing platform/src files,
only added two NEW test-tool files which tsx runs without type-checking; verify with the command below if a
tsc gate is needed).

1. **Bookkeeping from handover 005 — BOTH resolved:**
   - **`nmemo-asf.8` CLOSED.** Removed its two blocker edges first (`bd dep remove nmemo-asf.8 nmemo-9qq`
     — superseded, `.8` built its own loader; `bd dep remove nmemo-asf.8 nmemo-asf.7` — the I3 flat-baseline
     portion is satisfied, `.7` stays open for other intents), noted the resolution, then `bd close`. No
     `--force` needed. Verified: `bd show nmemo-asf.8` = CLOSED.
   - **CronQA submodule PINNED + committed** (`24b5c46`). `apoorvumang/CronKGQA` at `41a93de` registered as
     a git submodule (gitlink mode 160000 + `.gitmodules` entry) — only the pointer, NOT the large
     `wikidata_big` KG. Verified: `git ls-files --stage benchmarks/cronqa/upstream` shows `160000 41a93de`.
     (First commit's message was mangled by PowerShell heredoc syntax in the Bash tool — `@'…'@` is literal
     in bash — and amended clean; that is why the SHA is `24b5c46`, not the `c084144` printed mid-session.)

2. **I1 architectural FORK decided by the user = Path B.** The R4 fusion lever (dense-name ⊕ dense-fact)
   is an ENTITY-retrieval mechanism; LongMemEval scores SESSION/turn retrieval over chat. Two ways to
   reconcile (see `scratch-asf-i1-investigation.md` §7/§9): **Path A** (extract entities+facts → fuse →
   map hits to sessions; tests the actual lever, but needs the provenance backbone doc 32 §1.1 —
   `source_memory_id` NULL / `fact_units` empty — AND Haiku chat-extraction = Claude spend) vs **Path B**
   (session-as-document dense retrieval; cheap, Claude-free, ready; does NOT exercise the lever). **User
   chose Path B** (free real-query floor first; decide Path A after).

3. **Bead `nmemo-asf.13` filed** (Phase 4, first I1 experiment) under epic `nmemo-asf`. Labels
   retrieval/single-graph/benchmark. Acceptance = pre-reg names bar BEFORE running / 3 arms scored / H1 with
   bootstrap + per-type / blind adversary before banking / NULL is valid.

4. **Pre-registration FROZEN: `docs/architecture/single-graph/42-longmemeval-i1-local-prereg.md`.** Contains
   TWO transparent PRE-RUN CORRECTIONS (both caught before any number computed — this is legitimate, freezing
   a known-wrong convention is not what pre-reg protects):
   - **Correction #1 — nomic asymmetric prefixes.** nomic-embed-text is asymmetric (`ml-client.ts:55-74`,
     bead nmemo-1cp): stored passages need `search_document: `, queries `search_query: `; a side-test ON THE
     LongMemEval needle set lifted recall@1 **0.38→0.75**. Path B is that task type, so DENSE embeds docs via
     the document prefix and the question via the query prefix (implemented by prefixing the cache KEYS).
   - **Correction #2 — chunking (smoke-surfaced).** The first smoke FAILED: Ollama returns HTTP 500
     `input length exceeds the context length` on long turns (it does NOT silently truncate). Turn lengths
     p50 434 / p90 2526 / **max 41,855** chars. Fix = split the document (turn) side with the platform
     chunker `splitIntoUnits` (`pipeline.ts:268`, char-based sliding window) at **256 chars / 64 overlap**
     — the focused-unit regime nmemo-1cp validated on LongMemEval. (Config default is 128/64 = ~1.01M units
     for this subset; 256/64 = ~363k, the cost/fidelity balance; 128/64 flagged as fidelity-max follow-up.)
     DENSE unit = 256-char chunk, **session score = MAX over chunks**; **BM25 stays whole-turn** (no token
     cap), session = MAX over turns. Embedding runs CONCURRENT (pool) since serial nomic is ~10/s.

5. **Harness + prep written and VALIDATED end-to-end** (deterministic, Claude-free, NO DB writes):
   - `benchmarks/longmemeval/prep_i1_local.py` — derives the frozen I1 cut. Ran: **150 questions**
     (single-session-user 64 / assistant 56 / preference 30; 30 `_abs` abstention excluded), single-needle
     (`answer_session_ids` length = 1 for all 150), 0 unresolved gold sessions. → `i1-local-cut.json`.
   - `platform/src/test/tools/longmemeval-i1-baseline.ts` — the 3-arm harness. Smoke on 3 Qs PASSED:
     chunking works (8017 chunks), concurrency 8 = **~28/s**, invariants pass, all arms + RRF-60 + nDCG +
     by-question bootstrap compute and discriminate (BM25 nDCG 0.877 vs dense 1.0). 3-Q recall trivially 1.0
     (easy, tiny n) — pipeline check only.

## RESUME HERE — next stage (do this first)
**A full I1 run is EMBEDDING IN THE BACKGROUND right now** (started this session). Do this, in order:

1. **Check the run.** Task id **`bha0ypy0i`**, output file
   `C:\Users\bruce.mckay\AppData\Local\Temp\claude\C--Users-bruce-mckay-dev-nmemo\ce0323f0-e0f9-4cd6-a07f-b85734d105a0\tasks\bha0ypy0i.output`.
   It embeds **354,800** new chunks (362,817 total, 8,020 were pre-cached) at concurrency 16, then scores and
   prints the floor + H1 and writes `benchmarks/results/longmemeval/runs/2026-09-08-i1-local.json`. ETA ~2–3.5h
   from ~15:0x local. **If it is still running, do NOT start a second copy.** If it DIED/was interrupted, just
   re-run the exact command in "How to run" — the embed cache (`i1-embed-cache.json`) is content-keyed and
   RESUMABLE (skips already-embedded chunks). **Do NOT edit any `platform/src/**` file while it runs** (a
   tsx/watch reload could kill it — see gotchas).
2. **Read the result** (the console output tail + the result JSON). Primary = session `recall_any@10` per arm
   (DENSE-FLAT / BM25-FLAT / DENSE+BM25); H1 = `DENSE+BM25 − DENSE-FLAT` with by-question bootstrap CI + McNemar
   + per-type direction; also nDCG@10, recall@5, turn-level recall, tie-break sensitivity. **DEMONSTRATED** =
   CI>0 AND all 3 types positive; else **NULL** (a valid banked outcome — the prereg pre-committed to expecting
   a possibly-underpowered small lift at n=150).
3. **RUN THE BLIND ADVERSARY before banking** (frozen discipline, doc 42 §8; memory
   `feedback_verify_empirical_gates`). Independently: (a) re-derive the floor headline from
   `longmemeval_s_cleaned.json` source (do NOT trust the harness's own numbers); (b) re-embed a small sample
   and confirm it matches the cache (cos ~1.0); (c) independently re-check the session-oracle mapping
   (answer_session_ids → gold session index). Prefer a fresh blind subagent given the same source + prereg.
   Fold honesty nits in; do not argue them away.
4. **Bank:** append RESULTS to doc 42 (below its "do not edit above" line), update memory
   `project_retrieval_loop.md` (or a new I1 note) + MEMORY.md, then `bd close nmemo-asf.13` (or leave open with
   notes if a follow-up is owed, e.g. the 128/64 fidelity-max variant or Path A).
5. **Then the fork:** decide Path A (the actual R4 lever test — needs provenance backbone doc 32 §1.1 +
   Haiku extraction, both gated on user consent) vs move to I2 (multi-hop, 2WikiMultiHop/HotpotQA). Ask the user.

## How to run / verify
- **Services (host), all UP this session:** Ollama **:11434**, ml **:8000**, Postgres **:5433**, Qdrant
  **:6335**. Check: PowerShell `foreach ($p in @(8000,11434,5433,6335)) { try { $c=New-Object
  Net.Sockets.TcpClient; $c.Connect('127.0.0.1',$p); "${p}: up"; $c.Close() } catch { "${p}: down" } }`.
  If ml down: `cd ml-services && PYTHONIOENCODING=utf-8 LLM_PROVIDER=claude .venv/Scripts/uvicorn app.main:app
  --host 0.0.0.0 --port 8000 --http h11`. If Ollama down: `ollama serve`
  (`C:/Users/bruce.mckay/AppData/Local/Programs/Ollama/ollama`).
- **The full I1 run (re-run / resume):** from `platform/`:
  `DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test ML_SERVICES_URL=http://localhost:8000
  EMBED_MODEL=nomic-embed-text QDRANT_URL=http://localhost:6335 QDRANT_COLLECTION=cognitive_test NODE_ENV=test
  EMBED_CONCURRENCY=16 npx tsx src/test/tools/longmemeval-i1-baseline.ts`
  (add `LME_LIMIT=<n>` for a smoke on the first n questions). Resumable via the cache; safe to Ctrl-C and re-run.
- **Regenerate the frozen cut** (host python 3.12): `python benchmarks/longmemeval/prep_i1_local.py`.
- **tsc baseline (only if a gate is needed):** `cd /c/Users/bruce.mckay/dev/nmemo/platform && npx tsc --noEmit
  2>&1 | grep -cE 'error TS'` → expect **69** (do not "fix" it; it is the compare-point).
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd show nmemo-asf`, `bd close <id>`,
  `bd dep remove <blocked> <blocker>`, `bd update <id> --notes "..."`.
- **DB reads (rarely needed for Path B):** `docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test
  -tAc "<single SQL>"` via the **PowerShell tool** (Bash-tool docker is flaky).

## Key locations
- **Prereg (FROZEN, source of truth):** `docs/architecture/single-graph/42-longmemeval-i1-local-prereg.md`
  (arms, metric, bar, kill conditions, both pre-run corrections, RESULTS section pending).
- **Build brief:** `docs/architecture/single-graph/scratch-asf-i1-investigation.md` (9 sections + prereg
  skeleton — the Path A/B fork, fusion wiring, BM25-must-be-built, LongMemEval structure).
- **Harness (committed? NO — uncommitted new files):** `platform/src/test/tools/longmemeval-i1-baseline.ts`,
  `benchmarks/longmemeval/prep_i1_local.py`, `benchmarks/longmemeval/.gitignore` (ignores the derived
  cut+cache; prep script is tracked). Reuses `platform/src/test/tools/retrieval-eval/core.ts` (dot,
  normalise, rankByScore, mean, buildBm25, bm25Scores, clusteredBootstrap) + `services/fusion.ts`
  (reciprocalRankFusion, RRF_K_DEFAULT=60) + `services/ml-client.ts` (SEARCH_DOCUMENT_PREFIX/SEARCH_QUERY_PREFIX).
- **Data (gitignored):** source `benchmarks/longmemeval/data/longmemeval_s_cleaned.json` (277 MB, 500 Qs;
  ignored via `benchmarks/.gitignore: longmemeval/data/`). Derived: `benchmarks/longmemeval/i1-local-cut.json`
  (150 Qs), `i1-embed-cache.json` (the big resumable embed cache). Result → `benchmarks/results/longmemeval/runs/`.
- **Running background task:** id **`bha0ypy0i`** (the full I1 run). Session cwd = `C:\Users\bruce.mckay\dev\nmemo`.
- **Beads:** epic `nmemo-asf` — CLOSED `.1 .2 .3 .4 .5 .6 .8 .10 .12`; OPEN `.7` (◐ per-intent), `.9`
  (Phase 1.1 follow-ups), `.11` (backfill-merge, DESTRUCTIVE), **`.13` (I1, THIS session — open, awaiting the
  run result + adversary)**. Related: `nmemo-9qq`, `nmemo-bki`, `nmemo-u8j`.
- **Memory:** `project_retrieval_loop.md` (the fusion lever), `project_temporal_fact_model.md` (I3 arc),
  `reference_nmemo_silent_data_traps.md` (incl. the nomic token cap — which bit us this session),
  `feedback_verify_empirical_gates.md` (the discipline).
- **Prior handovers:** `.handovers/handover-00{1..5}.md` (005 = the I3 session this one follows).

## Architecture / how it works (essentials)
- Single graph, Postgres `cognitive_test`. Path B does NOT touch the DB at all — it is a standalone offline
  tsx harness over the LongMemEval JSON, embedding chat turns via nomic (Ollama), scoring in-memory. So
  `cognitive_test` (294-doc substrate) and `_cronqa` (I3, 125k entities) are UNTOUCHED by construction.
- **I1 "local"** = point lookup / "what is X", single-hop single-location recall (doc 34). The benchmark:
  LongMemEval_S single-session subset (150 Qs), per-question haystack (~47–53 sessions, single needle). Gold
  = the one `answer_session_ids` session (+ `has_answer` turns for the turn-level secondary).
- **Why LongMemEval (the validity win):** every prior single-graph number (R@10 ≈ 0.20–0.23) used
  papers-as-queries where ~80% of targets appear verbatim in the query (doc 27) — largely name-presence
  detection, not retrieval. LongMemEval uses natural questions, real chat history, and an evidence-session
  oracle independent of name-presence. Path B's floor is the honest real-query number.
- **The 3 arms** (query + candidate set identical across arms; session-level comparison): `DENSE-FLAT`
  (nomic, asymmetric prefixes, 256-char chunks, session=MAX over chunks) / `BM25-FLAT` (in-JS BM25 k1=1.2/b=0.75
  over whole turns, session=MAX, retrieved-set: score>0 only) / `DENSE+BM25` (retrieved-set RRF-60 of the two
  session rankings). H1 = does the lexical leg add over dense on real queries (papers-as-queries said TIE).
- **Lexical is in-JS only** here — the shipped read path has NO lexical index. All prior "BM25-names" was an
  offline in-JS computation. Productionizing as Postgres FTS (tsvector+GIN) is a SEPARATE build item, filed
  only if the lever clears.

## Open questions / blockers / needs-human
- **The full run result is not yet in** — read it, adversary it, bank it (RESUME steps 2–4).
- **The Path A vs I2 fork (RESUME step 5)** needs a human decision. Path A additionally needs the provenance
  backbone (doc 32 §1.1 — `source_memory_id` NULL on every fact, `fact_units` empty) built first, plus Haiku
  extraction (Claude spend).
- **Anything that spends Claude needs consent** (org spend cap has bitten): Path A extraction, `nmemo-9qq`
  end-to-end, live epoch ingest (`.9`), any capable-model run. ALL of this session's work was FREE
  (deterministic + local Ollama embeds).
- **Fidelity follow-up (optional):** the prereg uses 256/64 chunks for cost; 128/64 (config default, 0.771
  needle) is the fidelity-max variant — try only if the floor looks suspiciously weak.

## Gotchas / constraints / learnings
- **nomic token cap is a HARD failure, not silent truncation.** ml `/embed` → Ollama returns HTTP 500
  `input length exceeds the context length` on long text. nomic ctx ≈ 2048 tokens. Always chunk long passages
  (256-char units are ~68 tokens, safe). This bit the first smoke (memory `reference_nmemo_silent_data_traps`
  lists the cap; now confirmed it 500s).
- **nomic is ASYMMETRIC** (`ml-client.ts:55-74`): use `search_document: ` for stored passages and
  `search_query: ` for queries on any PASSAGE-retrieval task (memories/chat). Entity-name/fact similarity stays
  RAW (symmetric). Getting this wrong ~halves recall.
- **Embedding throughput ≈ 28/s at concurrency 8** through ml:8000→Ollama; roughly flat (Ollama likely
  parallel-capped). ~363k chunks ≈ 2–3.5h. Cache flushes every 2000 → resumable; re-run to resume.
- **Bash tool ≠ PowerShell for heredocs.** `@'…'@` is a PowerShell here-string; in the Bash tool it is LITERAL
  and mangles a `git commit -m` (stray `@` subject). Use multiple `-m` flags or a real `<<'EOF'` heredoc in bash.
- **Foreground `sleep` is BLOCKED in the Bash tool** ("use Monitor with an until-loop"). Do not chain sleeps;
  run long things with `run_in_background: true` and read the output file, or use Monitor.
- **Do NOT edit `platform/src/**` while a tsx harness runs** — a hot-reload/watch can drop the run (memory
  `reference_tsx_watch_drops_batch`). Edit only benchmark/doc files during a run.
- **Per-benchmark `.gitignore`** convention: `benchmarks/<name>/.gitignore` ignores that benchmark's derived
  cut+caches (see `benchmarks/cronqa/.gitignore`, and the new `benchmarks/longmemeval/.gitignore`). Source data
  is ignored by `benchmarks/.gitignore`.
- **`rawQuery` rewrites snake_case→camelCase silently; `platform/src/index.ts` has NUL bytes (use `grep -a`)**
  (carried from 005; not hit this session but still true).
- **Empirical discipline (held this session):** pre-registered the bar (doc 42) BEFORE computing; corrected two
  embedding-convention errors transparently BEFORE any number (not after seeing results); blind adversary +
  banking still OWED before the result counts. NULL is pre-committed as a valid outcome.
- **Commit only when the user asks.** They authorised the submodule-pin commit this session. NEVER add
  Co-Authored-By (memory `feedback_no_coauthor`).

## Read-order of other docs
1. `docs/architecture/single-graph/42-longmemeval-i1-local-prereg.md` — the frozen contract for the running
   experiment; read the two PRE-RUN CORRECTION blocks in §3.
2. `docs/architecture/single-graph/scratch-asf-i1-investigation.md` — the full build brief + the Path A/B fork.
3. `bd show nmemo-asf` + `bd show nmemo-asf.13` — live bead state.
4. `docs/architecture/single-graph/34-query-intent-set-proposal.md` — the 5 intents + priority (I1 defn §17-23).
5. `memory/feedback_verify_empirical_gates.md` — the pre-register→adversary→bank discipline (load-bearing for
   RESUME step 3).
6. `.handovers/handover-005.md` — the I3 session (substrate `.12`, flat floor `.7`, temporal experiment `.8`).
