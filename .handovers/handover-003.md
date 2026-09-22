---
session: 003
date: 2026-09-04
project: nmemo — intent-adaptive retrieval & ingestion redesign (epic nmemo-asf)
status: in-progress
supersedes: 002
---
# Handover 003 — nmemo — Phase-1 foundations landed: corpus-scoped reads, fusion tool wired, causal backfill, entity identity fixed

## Mission / goal
Program `nmemo-asf` (docs 30–38): redesign ingestion pulled by committed query capabilities, benchmark-gated,
on a SINGLE graph in Postgres `cognitive_test`. **The user steers deliberately and reviews at every fork — do
NOT barrel into production/write-path changes; converge on findings, check in at forks, and follow the loop
discipline: prove DETERMINISTICALLY (standalone tsx probe, no Claude) before spending Claude; forward-fix +
separate guarded backfill for anything touching existing data.** The rhythm is one bead per unit: implement →
prove with a probe → commit → close → file follow-ups. Org Claude spend cap has bitten this session — keep
Claude-heavy work minimal; all proofs are local (Ollama :11434 embeddings + direct DB), which is free.

## Current state — DONE + verified (this session)
Branch `feat/single-graph-retrieval`, HEAD **`029f653`**. **No uncommitted code** (clean tree; only untracked
`.handovers/` and the pre-existing `docs/.../prereg-artifacts/*.json` remain). `cd platform && npx tsc
--noEmit` baseline = **69 errors** — held at 69 through EVERY edit this session (re-verified after each). 69 is
the compare-point, never "fix" it.

Four beads landed, each proven by a deterministic tsx probe (no Claude), all self-cleaning on scratch corpora:

- **`nmemo-asf.3` CLOSED — corpus-scoped the live reasoning read path** (commit `842e65b`, doc 36). Scope =
  Postgres reasoning read path only (Qdrant + ~39 analytics services + RLS explicitly OUT). Increment 1
  (from session 002) threads `corpusId` `/api/reason/query` → `invokeReasoningAgent` → `MNEMO_CORPUS_ID` →
  `context.corpusId`. Increment 2: six read tools now scope by `context.corpusId` via an OPTIONAL `corpusId?`
  param (so all other callers stay unscoped, no tsc fan-out): `getEntityFacts`, `findConnectedEntities`/
  `traverseFromEntities`, `findSimilarEntities`, `getEntityCausalHistory`, `traceCauses` (+`projectTrajectory`
  symmetric), `recallViaGraph`→`expandFromAnchors`. **Increment 2b (surprise, user-approved):** the
  fact→causal mirror `createCausalEvent` (`facts.ts`) never stamped `corpus_id` → serial-arm events were
  mis-labelled `'default'`; fixed to require+stamp it at all 3 callers (create/expire/invalidate; expire+
  invalidate now `SELECT corpus_id`). Proof: `corpus-isolation-probe.ts` 20/20 (identical-vector twins +
  cross-corpus poison causal edge).
- **`nmemo-asf.4` CLOSED — wired the proven fusion as MCP tool `recall_entities_fused`** (commit `652ea33`,
  doc 37). `recallEntitiesFused` (RRF-60 of dense-over-names ⊕ dense-over-facts, the ONE confirmed lever,
  `nmemo-u8j.1`) had no live caller. Added a `GRAPH_TOOLS` entry (`mutates:false` → auto-exposed to
  `reasoning_agent` via `LEGACY_SURFACE` and every actor on both transports) + a dispatch case using
  `context.corpusId` (no `corpus_id` tool arg). Also added it to the reasoning-agent prompt
  (`ml-services/app/reasoning_agent.py`) as PHASE-1 step 1, preferred over name-only `search_similar_entities`.
  Proof: `fused-tool-probe.ts` 12/12 through the real `handleToolCall` dispatch with the production env carrier.
- **`nmemo-asf.10` CLOSED — backfilled 7299 mis-stamped `causal_events.corpus_id`** (commit `3805653`, doc 36
  updated). One-shot `platform/src/db/backfills/backfill-causal-event-corpus.sql`: `SET ce.corpus_id =
  f.corpus_id`, in ONE transaction that DISABLE/ENABLEs `trg_corpus_immutable` (mig-052 guard) + the retired
  AGE `trigger_sync_causal_event`. Applied: `UPDATE 7299`; verified 0 mis-stamped remain, distribution fully
  aligned, both triggers re-enabled, immutability guard re-verified. Causal scoping (`.3`) now correct on the
  full 294-doc substrate.
- **`nmemo-asf.5` CLOSED — entity identity = `(name, corpus)`; `entity_type` demoted to a first-seen
  attribute** (commit `029f653`, doc 38). Root cause of fragmentation (measured): type in the dedup key +
  unstable type strings (ChatGPT = 21 rows in arxiv-nlp, one per type; 26-37% of facts touch a fragmented
  node). Edits: `createEntity` keys on `(lower(name), corpus)` — drop type, add corpus (also fixes `nmemo-cki`
  cross-corpus reuse); epoch `promotion.ts` mint-idempotency drops type, keeps `(name, corpus)`, + `ORDER BY
  createdAt,id` for re-run idempotency (planner NOT restructured — its `(type,norm)` clusters converge at
  mint); `pipeline.ts:718` corpus-scopes `detectMergeCandidates`. Proof: `dedup-identity-probe.ts` 8/8 (serial
  via `createEntity`, epoch via hand-staged `promote()`).

Docs written: **36** (corpus-scoped read path), **37** (fused MCP tool), **38** (dedup hardening design +
measurements). Memory `reference_nmemo_silent_data_traps.md` gained items 6 (corrected: the mirror is app
code `createCausalEvent`, not a trigger), 7 (the corpus-stamp bug + backfill gotcha), 8 (the two-regime
embedding finding + entity-identity rule).

## RESUME HERE — next stage (do this first)
No work is mid-flight; pick the next bead. `bd ready` under epic `nmemo-asf` shows the open children. Ordered
recommendation:

1. **`nmemo-asf.7` (P2) — Phase 3: per-intent benchmark harness + flat baseline.** This is the natural next
   foundation: with the read path corpus-correct and the fusion lever wired, build the harness that measures
   the five committed intents (I1 point-lookup, I2 multi-hop, I3 temporal, I4 causal, I5 global; priority
   I3>I1>I2>I4>I5 — doc 34) against a flat baseline. Unify with epic `nmemo-bki` and `nmemo-9qq` (CronQA). This
   is substantial and design-shaped — START WITH A SHORT DESIGN PASS / plan-mode, don't code first. It unblocks
   `.8` (Phase 4 I3 temporal experiment, pre-registered, gated on CronQA).
2. **`nmemo-asf.11` (P2) — backfill-merge existing entity fragments.** Destructive (collapses the on-disk
   fragments `.5` stopped creating: chatgpt 21→1 etc). Needs its OWN gate. CRITICAL: the homonym guard must be
   **fact-neighbourhood** based, NOT embedding — measured this session that same-name rows embed IDENTICALLY on
   qbio/arxiv (name-only embeds). Pre-register the merge rule + measure homonym incidence before the bulk run.
   Uses existing `mergeEntities` (its old blocker `nmemo-9vk` is CLOSED). Mind `uniq_facts_active_triple` on
   fact re-point and the causal-events cleanup order.
3. **`nmemo-asf.9` (P2) — Phase 1.1 follow-ups:** entity-mention offsets on the `link_entity_to_memory` tool
   schema + OPTIONAL full live epoch ingest verification (the latter costs Claude — get explicit consent).

Whatever you pick: claim it (`bd update <id> --claim`), read its acceptance (`bd show <id>`), and if it touches
the write path or existing data, ground it in the code first + present a plan before coding (the user reviews
forks).

## How to run / verify
- **DB (read/scratch):** `docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test -tAc "<SQL>"`
  (role `cognitive`, NOT postgres; psql not on host PATH). NEVER unscoped-delete/DROP `cognitive_test` — it
  holds the 294-doc research substrate (qbio/arxiv-cv/arxiv-nlp/dal-cv/dal-nlp + _concepts + test `default`).
  All probe scratch work uses a `_..._probe*` corpus and self-cleans.
- **tsc baseline:** `cd /c/Users/bruce.mckay/dev/nmemo/platform && npx tsc --noEmit 2>&1 | grep -cE 'error TS'`
  → must be **69**.
- **Run a probe (deterministic, no Claude), from `platform/`:**
  `DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text npx tsx src/test/tools/<probe>.ts`
  (this session: `corpus-isolation-probe.ts`, `fused-tool-probe.ts`, `dedup-identity-probe.ts` — all PASS +
  self-clean). AGE-sync `WARNING: graph "causal_graph" does not exist` lines are harmless noise (AGE retired);
  filter with `grep -vE 'sync_causal_(event|edge)_to_graph failed|severity|code:|message:|where:|file:|line:|routine:|^\{|^\}|hint:'`.
- **Apply a one-shot SQL (NOT via the migration runner):**
  `docker exec -i nmemo-postgres-1 psql -U cognitive -d cognitive_test < platform/src/db/backfills/<file>.sql`
- **Beads:** `C:/Users/bruce.mckay/AppData/Local/Programs/bd/bd.exe` — `bd ready`, `bd show <id>`,
  `bd update <id> --claim`, `bd close <id> --reason "..."`, `bd create "<t>" --parent nmemo-asf -t task -p 2 -d "..."`.
- **Infra (all UP, verified this session):** postgres :5433 (`nmemo-postgres-1`, healthy ~9d), qdrant :6335,
  ml :8000 (provider=claude), ollama :11434 (has `nomic-embed-text` + `bge-m3`). The platform HTTP server was
  NOT running (not needed — probes call code directly).

## Key locations
- **Design/result docs (single-graph):** THIS SESSION — `36-corpus-scoped-read-path.md`,
  `37-fused-recall-mcp-tool.md`, `38-dedup-hardening-design.md`. PRIOR — `35` (provenance backbone), `34`
  (committed intent set I1–I5 + priority + composite-reasoning framing), `33` (Phase-0 graph analysis), `32`
  (program plan), `30` (arch map), `31` (strategy↔ingestion matrix). Ledger `09-experiment-ledger.md` is
  retrieval-experiments only (these builds are not logged there).
- **Code shipped this session (all committed):** `platform/src/services/causal-agent.ts` (read-tool corpus
  scoping + `recall_entities_fused` tool+dispatch), `platform/src/services/causal.ts` (getEntityCausalHistory
  + traceCauses/projectTrajectory corpus scoping), `platform/src/services/facts.ts` (getEntityFacts scoping +
  createCausalEvent corpus-stamp fix), `platform/src/services/graph-fallback.ts` (recallViaGraph/expandFromAnchors
  corpusId), `platform/src/services/entities.ts` (createEntity name-as-identity + corpus), `platform/src/services/promotion.ts`
  (epoch mint drop-type + orderBy), `platform/src/pipeline.ts` (detectMergeCandidates corpus scope),
  `platform/src/index.ts` + `reasoning-agent.ts` (increment-1 corpusId plumbing, from session 002),
  `ml-services/app/reasoning_agent.py` (prompt: recall_entities_fused), `platform/src/db/backfills/backfill-causal-event-corpus.sql`.
- **Probes (committed, `platform/src/test/tools/`), reuse their pattern:** `corpus-isolation-probe.ts`,
  `fused-tool-probe.ts`, `dedup-identity-probe.ts` (this session); `promote-probe.ts` (hand-staged epoch
  `promote()` — the pattern for testing the epoch arm without the LLM proposer); `citation-probe.ts`,
  `prov-probe.ts`, `frag-probe.ts` (session 002).
- **Beads:** epic `nmemo-asf`. CLOSED: `.1 .2 .3 .4 .5 .6 .10`. OPEN: `.7` (Phase-3 harness), `.8` (Phase-4 I3,
  gated on CronQA), `.9` (Phase-1.1 follow-ups), `.11` (backfill-merge fragments). Related: `nmemo-bki`
  (benchmark epic), `nmemo-9qq` (CronQA), `nmemo-cki`/`nmemo-x4s` (addressed forward by `.5`), `nmemo-81k`
  (handleBatch drops corpusId → prod lands in `default`; makes `.3`/`.5` cross-corpus latent-not-active today),
  `nmemo-4h3` (reads unscoped — the broader RLS project), `nmemo-u8j` (fusion/embedding lever epic).
- **Memory (auto):** `reference_nmemo_silent_data_traps.md` (updated), `project_retrieval_loop.md`,
  `feedback_verify_empirical_gates.md`.

## Architecture / how it works (essentials)
- Single graph in Postgres `cognitive_test`: `entities` (name+desc+embedding 768, `corpus_id`), `facts`
  (typed edges + `fact_embedding` 768, bi-temporal, inline `source_text`, `source_memory_id`, `corpus_id`),
  Graph C `causal_events`/`causal_edges`. Qdrant holds raw source-text vectors ('memories'); AGE retired from
  the read path (`services/graph.ts` = recursive CTE over `public.facts`; `traverseFromEntities` is the
  sanctioned primitive and DOES apply a corpus filter when given `corpusId`).
- **Two ingest arms:** serial (`extract()` → graph_agent creates facts/entities via MCP tools) and epoch
  (`store()` all → `propose()` to staging → `promote()` writes canonical). `ingestBatch` defaults to `serial`
  (the "baseline"); the 294-doc research corpora were ingested via `epoch` with explicit `corpusId`. Routes:
  `/ingest/batch/{serial,epoch,optimistic}` (`index.ts` `handleBatch`).
- **Live reasoning read path:** `/api/reason[/query]` → `invokeReasoningAgent` → ml-services spawns Claude Code
  with a per-actor MCP config → graph MCP tools (`_handleToolCallInner` switch in `causal-agent.ts`) → DB. The
  MCP transport calls `handleToolCall` with NO context, so `resolveContext()` reads `MNEMO_*` env vars written
  into the per-actor config by `getMcpConfigPath`/`getMcpEnv`. That env carrier is how `corpusId` reaches the
  read tools. Tool exposure/allow-lists all DERIVE from `GRAPH_TOOLS` filtered by the `mutates` flag — a
  `mutates:false` tool auto-exposes to every actor on both transports (no set edits needed).
- **Entity identity (as of `.5`):** `(lower(name), corpus)` on both arms; `entity_type` is a first-seen
  attribute, not identity. Do NOT re-introduce type into an identity key.
- **Causal mirror:** every new fact is mirrored to `causal_events` by APPLICATION code `createCausalEvent`
  (`facts.ts`, "not via triggers"), now corpus-stamped. A separate retired AGE trigger
  `trigger_sync_causal_event` fires on the table and harmlessly warns.

## Open questions / blockers / needs-human
- No blocker to the next bead. `.7` (Phase-3 harness) is design-shaped — worth a plan/design pass with the
  user before coding.
- `.11` (backfill-merge) and `.9`'s live-epoch-ingest option are destructive / Claude-spending respectively —
  get explicit consent (the user has consistently wanted to approve substrate-touching + Claude-heavy steps).
- Standing substrate inconsistency (not gating): the corpora are embedded under two regimes (qbio/arxiv
  name-only, dal name+description composite) — relevant to any embedding comparison and to `nmemo-u8j`.

## Gotchas / constraints / learnings
- **NEVER run the vitest suite against `cognitive_test`** — `src/test/setup.ts` / `global-setup.ts`
  DROP+RESTORE it from a snapshot that may predate the research corpora → would WIPE the substrate. Prove via
  standalone tsx probes (the pattern used all session). This is also why the epoch arm is proved via
  hand-staged `promote()` (see `promote-probe.ts`), not its vitest suite.
- **Scratch cleanup order** (a fact-delete fails FK otherwise): `causal_edges` (of those events) → `fact_history`
  → `causal_events` → `facts` (CASCADE → fact_sources/units) → `entities` → staging. See any probe's `finally`.
- **`causal_events` has a BEFORE-UPDATE immutability trigger `trg_corpus_immutable`** (mig 052) that rejects
  any `corpus_id` change (ERRCODE check_violation). To backfill it, `ALTER TABLE ... DISABLE TRIGGER` (and the
  AGE `trigger_sync_causal_event` to stay quiet) inside one transaction, then ENABLE — NOT a DROP.
- **`platform/src/index.ts` has NUL bytes** → ripgrep skips it (treats as binary); use `grep -a` or the Read
  tool. Normal-code lines edit fine.
- **`rawQuery` (`db/raw.ts`) camelCases result keys**; raw `db.execute(sql\`…\`)` returns snake_case (that's
  what the probes read via `row.corpus_id`).
- **Bash cwd persists + drifts** across calls — always `cd /c/Users/bruce.mckay/dev/nmemo` for git, and
  `cd .../platform` for tsx/tsc. `git commit` runs with the auto-configured identity (a benign warning prints);
  do NOT add Co-Authored-By (memory `feedback_no_coauthor`).
- **Empirical discipline (memory `feedback_verify_empirical_gates`):** prove deterministically before spending
  Claude; a passed check needs the dumb baseline + a leakage control; forward-fix + separate guarded backfill
  for existing data. The user endorses this rhythm.
- **Commit only when the user asks** — they authorized each commit this session; the "keep moving" green-light
  covered the land-the-bead rhythm (implement→prove→commit→close→file-followups).

## Read-order of other docs
1. `docs/architecture/single-graph/38-dedup-hardening-design.md` — most recent; the dedup findings +
   measurements + the embedding-regime discovery. START HERE for `.11` context.
2. `docs/architecture/single-graph/36-corpus-scoped-read-path.md` + `37-fused-recall-mcp-tool.md` — what `.3`/
   `.4`/`.10` shipped and their limits.
3. `docs/architecture/single-graph/34-query-intent-set-proposal.md` — the five committed intents + priority +
   the composite-reasoning framing (what Phase 3/4, i.e. `.7`/`.8`, build against). START HERE for `.7`.
4. `bd show nmemo-asf` (+ `bd show nmemo-asf.7` / `.11` / `.9`) — the live bead acceptance + notes.
5. `docs/architecture/single-graph/33-graph-structure-analysis.md` — Phase-0 data facts (corpus health, dead
   layers, tie-break caveat).
6. CLAUDE.md "CURRENT DIRECTION" — standing project context (predates nmemo-asf; the program supersedes the
   retrieval-loop framing).
7. `memory/reference_nmemo_silent_data_traps.md` + `memory/feedback_verify_empirical_gates.md` — traps +
   discipline.
```
