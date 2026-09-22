---
session: 007
date: 2026-09-09
project: nmemo — intent-adaptive retrieval & ingestion redesign (epic nmemo-asf)
status: in-progress
supersedes: 006
---
# Handover 007 — nmemo — I1 + I2 both DONE (banked, adversary-passed): dense wins LongMemEval retrieval, cheap levers don't add. Next fork = I4 causal (or step back).

## Mission / goal
Program `nmemo-asf` (docs 30-43): redesign ingestion pulled by committed query capabilities, benchmark-gated,
on a SINGLE graph in Postgres `cognitive_test`. **The user steers deliberately and reviews at every FORK —
do NOT barrel into write-path/substrate changes or the next intent; check in at forks. Loop discipline: PROVE
deterministically (standalone tsx / direct DB, no Claude) before spending Claude; pre-register metric+bar
BEFORE computing; run a BLIND ADVERSARY before banking; NULL/negative is a valid banked outcome; halt-and-
surface on surprise.** Intent priority (doc 34, committed): **I3 → I1 → I2 → I4 → I5**. Branch
`feat/single-graph-retrieval`.

## Current state — DONE + verified (this session, 2026-09-09)
Everything below is committed-to-docs/beads/memory but **NOT git-committed** (the code + docs are uncommitted
on the branch; user commits only on request). All work this session was FREE (deterministic + local Ollama
embeds; the 3 adversaries were Claude subagents = the only model spend, no org LLM-API/benchmark spend).

1. **Bookkeeping (from handover 006): DONE.** `nmemo-asf.8` closed (deps removed). CronQA submodule pinned +
   committed (`24b5c46`, gitlink at `41a93de`). See handover 006.

2. **I1 "local" — DONE, banked, `nmemo-asf.13` CLOSED** (doc 42, `42-longmemeval-i1-local-prereg.md`). Path B
   (session-as-document, Claude-free). On LongMemEval_S single-session subset (150 Qs, single needle):
   **DENSE-FLAT session recall@10 = 1.000 (CEILINGED)**, recall@5 0.947, nDCG 0.914, vs random 0.207 — dense
   near-solves single-session point-lookup. H1 (does BM25 add) = **NULL & uninformative** (recall@10 ceilinged
   → BM25 can only drag; −0.0133). Blind adversary **VALID-AS-FRAMED** (independently reproduced from source:
   no positional/oracle/leakage artifact; dense recovered 5/5 inferential preference cases). Framing: "the
   TASK is easy," lead with headroom metrics (recall@5/nDCG/turn), not "retrieval solved."

3. **I2 "multi-hop" — DONE, banked, `nmemo-asf.14` CLOSED** (doc 43, `43-longmemeval-i2-multihop-prereg.md`).
   Path B. On LongMemEval_S multi-session cut (121 Qs, all ≥2 evidence sessions, mean 2.61); honest metric =
   session **recall_ALL@k** (retrieve EVERY gold). **DENSE-FLAT recall_all@10 = 0.9504 — strong, NOT ceilinged**
   (headroom grows with evidence count: 4-5-stratum 0.864; recall_all@5 0.835). H1 (BM25 fusion) = **−0.0413,
   CI [−0.091,0.008] SPANS 0 — NULL & directionally NEGATIVE, a clean RRF-displacement** (dense holds gold at
   1-8, RRF demotes to 14-19; McNemar 2/7). Blind adversary **VALID-BUT-MISFRAMED**: floor + BM25-negative
   reproduced bit-exact from source, oracle clean — BUT it FORCED a correction: **Path-A traversal is NOT
   motivated** — the 6 dense-misses are 3 near-miss/ranking (one had gold at BM25 rank 2) + 3 aggregation-over-
   buried hops whose bridge is the non-discriminative user-self or the already-failed concept link (docs 28-32);
   BM25 surfaces those buried mentions at ranks 2-13, so "lexical can't close it" is FALSE.

4. **THE META (banked in doc 43 §4 + memory `project-retrieval-loop`):** across I1 + I2 on LongMemEval
   real-query SESSION retrieval (Path B), **dense embedding (nomic asymmetric prefix + 256/64 chunks + MAX-agg)
   IS the retrieval engine; the cheap graph/lexical levers (BM25 fusion, entity-traversal) do NOT add** — same
   conclusion as the concept-layer arc (docs 28-32). The residual frontier is extraction+aggregation (QA-level,
   Claude) or a better embedder (bge-m3, untested on LongMemEval), NOT a retrieval-graph lever. **Path A** (the
   actual R4 entity⊕fact / traversal lever on real queries) remains UNBUILT (needs provenance backbone doc 32
   §1.1 + Haiku extraction) and neither I1 nor I2 motivated building it.

## RESUME HERE — next stage (a FORK; do not barrel — the user picks)
I1+I2 are closed. The next intent by priority is **I4 (causal/explanatory)**, but the I1+I2 meta is an
inflection, so PUT THE FORK TO THE USER before committing. Options (I asked; awaiting the answer):
1. **I4 — causal/explanatory** (doc 34 §I4: "what caused X / why / what if"). Tests **Graph C** (causal_edges
   with mandatory reasoning + source_references) — a substrate that EXISTS but has NEVER been evaluated.
   Benchmarks Corr2Cause / CLadder. **Different regime** from the retrieval trio (not session retrieval). LIKELY
   SPENDS CLAUDE (causal-reasoning/LLM-judged) → needs explicit consent. Start with a read-only pre-work
   investigation agent (the pattern that worked for `.8`/I1/I2 — write a `scratch-asf-i4-investigation.md`).
2. **Give traversal its fair test** on a genuine compositional multi-hop benchmark (2WikiMultiHop / HotpotQA —
   net-new setup) + build Path A (provenance backbone doc 32 §1.1 + Haiku extraction). Heavy; I2 de-motivated it.
3. **Test bge-m3** (the one untested retrieval lever; memory says +0.093 on arxiv) on I1/I2 — but marginal given
   I1 ceiling / I2 0.95; a big re-embed (~3-6h). Probably not worth it.
4. **Step back / synthesize** the I1+I2+I3 meta and reconsider the program direction with the user.
Recommendation: **I4** — priority-next AND a genuine change of regime (Graph C), not more of the same; first
step is the free pre-work investigation, THEN a consent check before any Claude spend.

## How to run / verify
- **Services (host), all UP this session:** Ollama :11434, ml :8000, Postgres :5433, Qdrant :6335. Check:
  PowerShell `foreach ($p in @(8000,11434,5433,6335)) { try { $c=New-Object Net.Sockets.TcpClient;
  $c.Connect('127.0.0.1',$p); "${p}: up"; $c.Close() } catch { "${p}: down" } }`. Restart ml:
  `cd ml-services && PYTHONIOENCODING=utf-8 LLM_PROVIDER=claude .venv/Scripts/uvicorn app.main:app --host
  0.0.0.0 --port 8000 --http h11`; Ollama: `ollama serve`.
- **Re-run I1 / I2 (fast now — embeds all cached):** the shell cwd persists at `platform/`. Env:
  `DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test ML_SERVICES_URL=http://localhost:8000
  EMBED_MODEL=nomic-embed-text QDRANT_URL=http://localhost:6335 QDRANT_COLLECTION=cognitive_test NODE_ENV=test
  NODE_OPTIONS=--max-old-space-size=6144 EMBED_CONCURRENCY=8 npx tsx src/test/tools/longmemeval-i1-baseline.ts`
  (or `...-i2-baseline.ts`). Add `LME_LIMIT=n` for a smoke. Resumable via the shared binary cache.
- **Regenerate cuts (host python 3.12):** `python benchmarks/longmemeval/prep_i1_local.py` /
  `prep_i2_multisession.py`.
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd show nmemo-asf`.
- **tsc baseline = 69** (only if a gate is needed): `cd platform && npx tsc --noEmit 2>&1 | grep -cE 'error TS'`.
  I added 3 NEW test-tool files this session (i1/i2 harnesses) — tsx runs them without type-checking; if tsc is
  gated, check they don't add to 69.

## Key locations
- **Prereg docs (FROZEN, source of truth):** `docs/architecture/single-graph/42-longmemeval-i1-local-prereg.md`
  (I1, with 2 pre-run corrections + RESULTS + adversary), `43-longmemeval-i2-multihop-prereg.md` (I2 + RESULTS +
  adversary). Build briefs: `scratch-asf-i1-investigation.md`, `scratch-asf-i2-investigation.md`. Adversary
  findings: `scratch-asf-i1-adversary.md`, `scratch-asf-i2-adversary.md`.
- **Harnesses (uncommitted, new):** `platform/src/test/tools/longmemeval-i1-baseline.ts`,
  `longmemeval-i2-baseline.ts` (recall_ALL/multi-gold/per-stratum). Preps + `.gitignore`:
  `benchmarks/longmemeval/{prep_i1_local.py, prep_i2_multisession.py, .gitignore}`. Reuse
  `platform/src/test/tools/retrieval-eval/core.ts` + `services/fusion.ts` + `services/ml-client.ts`.
- **Data (gitignored):** source `benchmarks/longmemeval/data/longmemeval_s_cleaned.json` (277MB). Cuts
  `i1-local-cut.json` (150) / `i2-multi-cut.json` (121). **Shared binary embed cache**
  `benchmarks/longmemeval/i1-vecs.bin` (Float32, 768-dim, ~617k vectors, ~1.9GB) + `i1-keys.jsonl` (one
  JSON-escaped key/line, key = prefix+chunk; row i in .bin = line i in .jsonl). Both I1 + I2 harnesses share it.
  Results: `benchmarks/results/longmemeval/runs/2026-09-08-i1-local.json`, `2026-09-09-i2-multihop.json`.
- **Beads (epic `nmemo-asf`, 11/14 done):** CLOSED `.1 .2 .3 .4 .5 .6 .8 .10 .12 .13(I1) .14(I2)`. OPEN: `.7`
  (◐ per-intent harness), `.9` (Phase 1.1 follow-ups), `.11` (backfill-merge, DESTRUCTIVE).
- **Memory:** `project-retrieval-loop` (I1 + I2 + the meta, at the end), `project-temporal-fact-model` (I3),
  `feedback_verify_empirical_gates`, `reference_nmemo_silent_data_traps`.
- **Prior handovers:** `.handovers/handover-00{1..6}.md` (006 = mid-I1-run, now superseded).

## Architecture / how it works (essentials)
- Path B (both I1+I2) = standalone OFFLINE tsx harness over the LongMemEval JSON; embeds chat turns via nomic
  (Ollama), scores in-memory. NO DB writes — `cognitive_test` (294-doc) + `_cronqa` (I3) untouched.
- Retrieval convention (doc 42 §3, frozen): nomic ASYMMETRIC prefixes (`search_document:` turns,
  `search_query:` question; bead nmemo-1cp, validated on LongMemEval 0.38→0.75); DENSE unit = 256-char/64-overlap
  chunk (whole-turn embedding 500s the ~2048-tok ctx); turn score = MAX over chunks; **session score = MAX over
  turns**; BM25 over whole turns; fusion = retrieved-set RRF-60.
- I1 metric = recall_any@k (1 gold). I2 metric = recall_ALL@k (≥2 gold, retrieve all). Bootstrap = by-question
  clustered (`clusteredBootstrap`, 10k, fixed seed). DEMONSTRATED bar = CI>0 + per-stratum/type direction.

## Open questions / blockers / needs-human
- **The next-intent FORK (RESUME) needs the user's pick.** I4 likely spends Claude → explicit consent required.
- **Path A remains unbuilt + now de-motivated** (I2). If ever pursued, do it on a genuine multi-hop benchmark
  (2WikiMultiHop, net-new) and build the provenance backbone (doc 32 §1.1: `source_memory_id` NULL / `fact_units`
  empty) first.
- **Anything that spends Claude needs consent** (org spend cap has bitten): I4 causal, Path A extraction,
  nmemo-9qq, live epoch ingest (`.9`).

## Gotchas / constraints / learnings
- **Embed cache MUST be binary at this scale.** A single `JSON.stringify` of the vector map overflows V8's
  ~512MB max string length at ~32k×768 vectors (`RangeError: Invalid string length`) — this KILLED the first I1
  full run at 24k. The fix (both harnesses) = append-only Float32 `.bin` + `.jsonl` keys, flush only new vectors.
- **nomic token cap is a HARD HTTP 500** (`input length exceeds the context length`), not silent truncation —
  always chunk (256-char units ~68 tok). nomic runs COLD/slow (~11/s) when bge-m3 is the resident Ollama model;
  ~27/s when warm. Full embeds are 2.5-6.4h — background + resumable.
- **JS UTF-16 vs python code-point chunk boundaries differ on emoji turns** (589 chunks in I2) — immaterial to
  the result (adversary confirmed headline unchanged), but the harness (JS) and a python re-derivation won't
  produce identical chunk keys for emoji-containing turns.
- **Bash tool ≠ PowerShell heredocs** (`@'…'@` is literal in bash — it mangled a commit subject; use `-m` twice).
  **Foreground `sleep` is BLOCKED** (use Monitor / run_in_background). **Do NOT edit `platform/src/**` while a
  tsx harness runs** (hot-reload can kill it — memory `tsx-watch-drops-batch`).
- **Empirical discipline held + PAID OFF:** the I2 adversary caught me OVER-CLAIMING the Path-A traversal
  motivation (a launder toward "architecturally interesting") — corrected before banking. Pre-register → blind
  adversary → bank; NULL/negative pre-committed as valid. This is load-bearing (memory
  `feedback_verify_empirical_gates`).
- **Commit only when the user asks.** NEVER add Co-Authored-By.

## Read-order of other docs
1. `docs/architecture/single-graph/43-longmemeval-i2-multihop-prereg.md` (RESULTS + §4 the META + adversary) —
   the headline of this session.
2. `docs/architecture/single-graph/42-longmemeval-i1-local-prereg.md` (I1 RESULTS + adversary).
3. `docs/architecture/single-graph/34-query-intent-set-proposal.md` — the 5 intents (I4/I5 defns) + priority +
   composite-reasoning layer; I4 is next.
4. `memory/project-retrieval-loop.md` (the I1+I2+meta at the end) + `feedback_verify_empirical_gates.md`.
5. `.handovers/handover-006.md` (the I1-run session) and `005` (the I3 session).
