# Merge-prep reference: `feat/cognitive-platform-v1`

Reference for an upcoming **hard merge** between this branch and `feat/parallel-ingestion`
(the epoch-v2 propose/promote workstream). Both branches diverged from the same base and
**both heavily edited the same extraction-agent path**, so the merge will conflict in the
core files. This doc records *what we changed, why, and what must not be lost*.

## Topology

- **Our branch:** `feat/cognitive-platform-v1` (HEAD `b64a476`) — 25 commits since base.
- **Incoming:** `feat/parallel-ingestion` (HEAD `fd448f4`) — 50+ commits since base (epoch-v2
  `nmemo-vpz.*` E1-E8 propose/promote, a parallel benchmark/compare harness, undici/timeout
  fixes `nmemo-1tc`, transient graph-agent retry, glm-5-turbo arms). NOTE: this doc was first
  written at HEAD `45b5b66`; the epoch-v2 epic is now FULLY IMPLEMENTED in code — E5 (`17bc3ec`),
  both halves of E6 (`c6e916d`, `648f209`) plus its live-causal-verify finalizer (`e416a4e`), and
  E7 band-aid retirement (`fd448f4`) have all landed. Assume the ENTIRE epoch-v2 model exists at
  merge time — nothing is in flight.
- **Merge base:** `c5100092` ("chore(beads): sync issue tracker state").
- **Files touched by BOTH sides (conflict hotspots):**
  `ml-services/app/graph_agent.py`, `platform/src/index.ts`, `platform/src/pipeline.ts`,
  `platform/src/services/causal-agent.ts`, `platform/src/db/schema.ts`,
  `platform/package.json`, `platform/pnpm-lock.yaml`.

The two branches are not in conflict over *goals* — ours hardens single-pass extraction +
retrieval; theirs restructures extraction into a propose/promote epoch model. The danger is
that a careless merge silently drops one side's behaviour on the shared files.

---

## Incoming branch: epoch-v2 propose/promote (the target model)

Source: `docs/architecture/truth-graph/41-epoch-v2-design.md` (git-tracked on `feat/parallel-ingestion`,
not yet on our branch — view with `git show feat/parallel-ingestion:docs/architecture/truth-graph/41-epoch-v2-design.md`;
it lands additively, no conflict) + epic `nmemo-vpz`.
**Status: FULLY BUILT in code at branch HEAD `fd448f4`.** E1-E6 and E8 are closed; E6 is complete
including its live-Haiku causal verification (`verify-causal-live.ts`, `e416a4e`, verified PASS on
Haiku). E7 (retire band-aids, `fd448f4`) has LANDED in code — per `bd show nmemo-vpz` the epic is 7/8
closed (87%), with only the E7 bead itself still `in_progress` pending its `bd close` (its code is
already on the branch). The merge target is stable and fully realized; treat the entire epoch-v2 model
as present at merge time — nothing is still incoming.

**Core thesis: "agents propose, reconciliation disposes."** Parallel extraction agents stop being
authoritative writers. They write candidate entities/facts into per-epoch **staging** tables in
clean isolation; a single deterministic **promotion** step resolves identity, orders by
`valid_at ‖ chunk_index`, enforces exclusive-group supersession, and writes canonical in ONE
transaction, escalating only genuine ambiguity to an LLM arbiter. Correctness concentrates in one
deterministic, replayable place instead of emerging from racing writers + a one-shot cleanup.

**Why (evidence, 2026-06-09 benchmark):** supersession failed structurally 5/6 runs; the optimistic
arm produced three "Elena" entities; forward-vs-reverse litmus fact-F1 was 0.18-0.38 (order leaks
into truth); causal edges dangled on pre-reconciliation ids.

**Five-phase pipeline (replaces single-epoch `runEpochBatch`):**
1. **STORE** — chunk + embeddings -> Qdrant (as today).
2. **PROPOSE** — parallel isolated extraction agents, workflow `ORIENT -> EXTRACT -> RELATE -> VERIFY`
   (**CAUSE removed**). Read the stable entity registry + own chunk + prior report + "chunk N of M";
   **anchor known entities, propose unknowns**; write proposals to staging only.
3. **PROMOTE** — deterministic pure fn `promote(priorCanonical, staged) -> newCanonical`: entity
   dedup-once (full visibility kills the 3-Elena split), ref-rewrite handles->canonical ids,
   group-aware supersession in `valid_at‖chunkIndex` order, triple dedup, cleanup, one-tx write +
   audit, escalate ambiguous identity/conflict to the arbiter.
4. **CAUSAL** — separate post-promotion pass over the *settled* graph; conditional + delta-scoped;
   the one agent that reads live canonical; proposes edges on stable promoted event ids.
5. **GARDEN** — background structural pass (as today).

**Tool-surface inversion (§8a) — the part that collides most with our actor work:** most write
tools (`create_fact`, `resolve_entity`, `execute_merge`, `expire_fact`, `create_same_as_link`,
`resolve_contradiction`) **leave the agent surface and become promotion/disposal CODE**. Agents get
`propose_*` tools (`propose_entity`, `propose_fact`, `propose_causal_edge`) plus `resolve_anchor`,
gated by per-actor allow-lists. End-state actors: proposer = `resolve_anchor` + `propose_*`;
arbiter (recast `reconciliation_agent`) = scoped reads + `propose_identity_verdict` +
`propose_conflict_resolution`; causal = scoped reads + `propose_causal_edge`. (The design said
"gardener unchanged," but E5 actually stripped `execute_merge`/`create_same_as_link` from the gardener
too — removing its long-range dedup *execution* path; a follow-up bead was filed. Don't rely on
gardener dedup post-merge without checking it.)

**Landed since this doc was first written (assume these EXIST at merge time):**
- **E5** (`nmemo-vpz.5`, CLOSED — `17bc3ec`) — arbiter recast: `reconciliation_agent` recast to the
  verdict-only `ARBITER_SURFACE` (scoped reads minus `get_reconciliation_context` + `propose_identity_verdict`
  + `propose_conflict_resolution`); verdicts recorded in `arbiter_verdicts` (mig `043`) for replay
  determinism; `execute_merge`/`create_same_as_link`/`resolve_contradiction` retired from **every** agent
  allow-list. SIDE EFFECT: stripping merge/link from the **gardener** removed its long-range dedup
  *execution* path (follow-up bead filed) — re-check before relying on gardener dedup post-merge.
- **E6** (`nmemo-vpz.6`, CLOSED — code in `c6e916d` + `648f209`, live verify in `e416a4e`) — CAUSE split
  into the Phase-4 causal pass: promotion mints causal events deterministically into the existing
  `causal_events` table (`causal.mintCausalEvent`); `propose_causal_edge` stages to `staging_causal_edges`
  (mig `044`, + `causal_edges.stale_citation`/`stale_citation_reason`); `causal-promotion(-plan).ts`
  disposes; `causal-pass(-trigger).ts` + `pipeline.ts` wire it in after `promote()`; new `causal_agent`
  actor + `invokeCausalAgent` + the `ml-services` `/causal-agent` endpoint. **Live-verified:** `e416a4e`
  added `platform/scripts/verify-causal-live.ts` (seeds a settled funding+relocation scenario, drives
  `runCausalPass()` through the REAL Haiku `/causal-agent` invoker) and the run PASSED on Haiku — a
  cross-chunk funding->relocation edge on the SETTLED ids, direction correct, 3 source refs, not stale.
  (`e416a4e` also made `causal_agent.py`'s prompt grounding-friendly — render the scope event's fact id,
  cite the event fact/entity as `source_references`. The corpus10/20 `expired_but_cited` check is a
  SEPARATE benchmark run, not this seeded scenario.)

- **E7** (`nmemo-vpz.7`, code LANDED — `fd448f4`; bead `in_progress` pending its `bd close`) — band-aids
  retired: `filterLiveEntityIds` DELETED from `pipeline.ts` (only explanatory comments remain), along with
  the optimistic arm's dependent post-hoc final-reconcile sweep; the **legacy per-chunk CAUSE path is GONE**
  — the `create_causal_edge` MCP tool def + handler were deleted from `causal-agent.ts`, and the legacy
  5-phase `graph_agent.py` prompt was converted to **4-phase / no-CAUSE** (`ORIENT → EXTRACT → RELATE →
  VERIFY`) for non-proposer actors too; orphan-entity cleanup folded into promotion step (e)
  (`planPromotion` `droppedOrphanEntities`); a new allow-list audit (`actor-tool-allowlist.test.ts`) asserts
  no canonical-write tool leaks. Causal edges now flow ONLY through the post-promotion causal pass
  (`propose_causal_edge` → `causal-promotion`) — the two CAUSE paths NO LONGER coexist. NOTE:
  `expire_causal_edge`/`revise_causal_edge` deliberately REMAIN (the reasoning agent's
  expire-on-contradiction uses them); only `create_causal_edge` was retired.

**Nothing in the epoch-v2 workstream is still in flight** — the entire propose/promote model is realized
in code at HEAD `fd448f4`.

### Cross-cutting merge implications for OUR work

1. **`graph_agent.py` is the highest-risk file — the risk is E4 proposer code PLUS the E7 CAUSE-retirement.**
   E5/E6 did NOT touch `graph_agent.py`, but **E7 (`fd448f4`) DID — it is now the LAST commit on the file**
   (was `82f42d0`/E4 before E7). The proposer posture landed in **E4**: a standalone `PROPOSER_SYSTEM_PROMPT`
   + `_build_proposer_user_prompt` (`ORIENT → EXTRACT → RELATE → VERIFY`, "NO CAUSE phase"), selected by
   `_system_prompt_for(content_type, actor)` when `actor == "extraction_proposer"`. **E7 then retired the
   per-chunk CAUSE write path for ALL actors** (doc 41 §11): `GRAPH_AGENT_SYSTEM_PROMPT` no longer says
   "five-phase", PHASE 4: CAUSE / WORKFLOW 5 / the `create_causal_edge` tool def / the REPORT "CAUSAL EDGES"
   section are deleted, and `_build_legacy_user_prompt` is now 4-phase (`ORIENT → EXTRACT → RELATE → VERIFY`,
   no CAUSE). `create_causal_edge` now appears 0 times in the file. So CAUSE is gone from BOTH the proposer
   path (E4) and the legacy/non-proposer path (E7) — **the merged file must NOT re-introduce the legacy CAUSE
   workflow**; causal reasoning runs only as the separate post-promotion causal pass. (E6's `e416a4e` did NOT
   touch this file — its "grounding-friendly prompt" is the new `causal_agent.py` system prompt, not anything
   here.) Our `hms`/`3f9.3` work rewrote the *prompt assembly* (compose-not-override segments, conversational
   vs narrative, subject-anchoring) and lives only on our side. **The entire collision is in two functions:**
   (a) `_system_prompt_for` — incoming is `(content_type, actor)` with an `extraction_proposer` branch + an
   OLD base+addendum content_type body (NO `conversational` branch); ours is `(content_type)` with a
   `conversational` branch + the segment assembler but NO `actor` param. The merged function must take BOTH
   params and keep BOTH branches. (b) the user-prompt builder split (`_build_legacy_user_prompt` — now
   4-phase, CAUSE-free after E7 — vs `_build_proposer_user_prompt`), which our side lacks. **Hazard to
   decide deliberately:**
   `PROPOSER_SYSTEM_PROMPT` is a standalone literal that does NOT route through our `_graph_agent_system_prompt(...)`
   segment assembler, so the proposer does NOT inherit our gate-absent conversational segments or
   subject-anchoring — a conversational chunk routed through the proposer would regress like `3f9.5`. Decide
   whether the proposer prompt should be re-expressed through our segments. Merge by hand, function by function,
   then run `speaker-aware-extraction`, `epoch-propose-tools`, AND `ml-services/tests/test_proposer_prompt.py`.
2. **Actor/allow-list posture (`causal-agent.ts`) — already landed, not future.** CORRECTION: E5 + E6
   are concrete on the branch now. The actor set / `VALID_ACTORS` is `graph_agent, reasoning_agent,
   gardener_agent, reconciliation_agent, user, system_trigger, cascade, extraction_proposer, causal_agent`
   (+ a `promotion` allow-list entry). `ACTOR_TOOL_ALLOWLIST`: `extraction_proposer` -> `PROPOSER_SURFACE`
   (reads + `resolve_anchor` + `propose_entity`/`propose_fact`); `causal_agent` -> `CAUSAL_SURFACE`
   (reads + `propose_causal_edge`, NO canonical causal writes); `reconciliation_agent` RECAST to
   `ARBITER_SURFACE` (reads minus `get_reconciliation_context` + `propose_identity_verdict` +
   `propose_conflict_resolution`, NO canonical writes); `graph_agent`/`reasoning_agent`/`gardener_agent`
   keep `LEGACY_SURFACE`. `execute_merge`/`create_same_as_link`/`resolve_contradiction` are absent from
   EVERY surface (their tool DEFS + handler `case` blocks REMAIN in the file — E7 did NOT delete them, they
   are just filtered out via `RETIRED_TO_PROMOTION`; do not delete those handlers on merge). New invokers:
   `invokeArbiterAgent` (E5), `invokeCausalAgent`/`CausalAgentInvoker` (E6). On the incoming branch
   `ContentType` is `'prose' | 'code-ts' | 'code-sql'` with NO `conversational` member — that member is
   OURS-only. **E7 (`fd448f4`) change to this file:** the `create_causal_edge` MCP tool DEF + handler are
   DELETED from `GRAPH_TOOLS` entirely (no actor can hold it; bring that deletion across, do not re-add),
   so `LEGACY_SURFACE` no longer carries it; a new audit `actor-tool-allowlist.test.ts` asserts the
   proposer/arbiter/causal non-read surfaces match doc-41 §8a exactly with no canonical-write leak.
   **Merge rule:** take their allow-list architecture WHOLESALE; from our side contribute ONLY the
   `conversational` `ContentType` member (ADD it to their union; it is not there to "keep") plus our graph
   tool-def edits. Do NOT preserve `reconciliation_agent`'s old full surface — it is intentionally recast to
   verdict-only. `graph_agent`/`reasoning_agent`/`gardener_agent` (plus the defensively-mapped
   `user`/`system_trigger`/`cascade`/`promotion`) keep `LEGACY_SURFACE`, which STILL carries `expire_fact`,
   `update_entity_summary`, `expire_causal_edge`, `revise_causal_edge` — **this is the intended FINAL state
   (E7 landed): the reasoning agent's expire-on-contradiction depends on `expire/revise_causal_edge`, so a
   merge that strips them is a regression.** No longer a "follow-up."
3. **`fact_units` link timing (`yxj.6`).** We write fact->unit evidentiary links at extraction/store
   time. `fact_units` does NOT exist anywhere on `feat/parallel-ingestion` (it is ours-only:
   `038_fact_units.sql`, `schema.ts`, `graph-fallback.ts`, plus the `extract()` write), so it lands
   additively — but in their model facts are not canonical until **promotion**, so for the EPOCH path the
   link-write must be re-homed into `promotion.applyPromotion` at step (b) ("Insert facts. Each fact is
   minted with a fresh id", `promotion.ts:288`), where canonical fact ids first exist. **This re-home is
   still OUTSTANDING** — E7 did not add it; promotion contains no `fact_units` reference. Sequencing note
   (post-E7): `planPromotion` now drops self-loop facts (`droppedSelfLoops`) AND orphan freshly-minted
   entities (`droppedOrphanEntities`, `fd448f4`) in step (e), so add the link write only for facts that
   actually land in `factsToInsert`/`insertedFactIds` — do not link dropped self-loops. Our single-pass
   `extract()` link write still serves the non-epoch paths. Verify fact->unit links point at canonical
   (promoted, SURVIVING) fact ids after the merge **on BOTH the single-pass and the epoch path** — the
   epoch path has no fact->unit write until you add one in `applyPromotion`, so this is a likely silent-drop.
4. **AGE sync (`zgw`/039) is MORE important post-merge, not less.** Promotion writes canonical in one
   transaction, firing the same `sync_entity_to_graph` trigger. The 039 fix must be present or promotion
   populates ZERO AGE nodes. Applies to both branches' DBs.
5. **Undici/timeout** — our `8w5` (AbortController) vs their `1tc` (disable undici response timeout):
   same problem, two fixes; pick one coherent approach (covered in the table below).

---

## Our changes, by theme (intent -> what -> why -> preserve)

### A. Personal-voice / speaker-aware extraction (epic `nmemo-3f9`)

**Intent.** The graph agent assumed third-person *narrative* (resolve "I" only to a named
character; proper-nouns-only entities). First-person chat ("I graduated with Business
Administration") has an *unnamed* speaker, so the agent created zero user facts. We reframed
extraction to be context-driven and speaker-aware without breaking narrative.

**What changed.**
- `nmemo-3f9.1` (`46512a2`) — `assistant` entity type + stream-scoped speaker identity.
- `nmemo-3f9.2` (`15fc893`) — thread speaker + `stream_id` through `ingest()`; platform
  pre-resolves a **Participants block** (USER always; ASSISTANT when assistant-role labels appear).
- `nmemo-3f9.3` (`8821249`) — prompt surgery in `graph_agent.py`: a `conversational`
  content_type path + **subject-anchoring** (anchor a fact to *who it is about*, not who said
  it: assistant saying "you graduated" -> USER; assistant "I recommend" -> assistant, dropped
  as self-profile). Self-facts are first-class.
- `nmemo-awi` (`e796439`) — bug fix: `parseContentType` was downgrading `conversational` ->
  `prose`, so the addendum never fired over HTTP. Widened the `ContentType` union end-to-end
  (`index.ts` + `causal-agent.ts`).
- `nmemo-3f9.6` (`5306880`) — guard so two anonymous stream-USER entities in different streams
  are not auto-merged.
- `nmemo-upn` (`604c9ec`) — thread the previous chunk's PHASE-6 report into the next agent's prompt.

**The failed run + its fix (read this before merging `graph_agent.py`).**
- `nmemo-3f9.5` (`79518d6`) **HALTED**: on the *real Haiku agent* the conversational addendum
  was ignored. Root cause: Haiku **obeyed the base prompt's proper-noun/narrator gate that
  physically PRECEDED the appended addendum** ("Business Administration is not a proper noun,
  explicitly forbidden"), so an end-positioned override never won. Reproduced on two runs.
- `nmemo-hms` (`9fb7f43`) — the fix: **compose-not-override**. The prompt is now *assembled
  from mode-swappable segment constants* (`_WORKFLOW3_*`, `_PHASE2_BODY_*`, `_REMINDER_PRONOUN_*`,
  NARRATIVE vs CONVERSATIONAL) via `_graph_agent_system_prompt()`. The conversational path has
  the proper-noun gate **absent**; the prose/code path splices the NARRATIVE variants and is
  **byte-identical** to the historical prompt. Verified 7/7 on real Haiku; q[0] degree fact
  proven end-to-end (`nmemo-yxj.5` / `adbd158`).

### B. Vector / embedding-unit retrieval (epic `nmemo-yxj`)

**Intent.** Decouple the *ingest window* (extraction-quality / agent-call-count unit) from the
*embedding unit* (small overlapping satellite that actually gets embedded for recall), so window
size is no longer bound by the nomic ~2048-token embed limit.

**What changed.**
- `nmemo-yxj.2` (`8877a58`) — `store()` carves small overlapping units under each window and
  does a **multi-point Qdrant write**.
- `nmemo-yxj.3` (`fcca165`) — unit-grained read path: search units -> dedup to parent -> return parent.
- `nmemo-yxj.6` (`cea1baf`) — offset-mapped **fact -> unit evidentiary links** (the `fact_units`
  table; mig `038_fact_units.sql`).
- `nmemo-yxj.4` (`dc87906`) — align the three chunking sites to one `store()` window policy;
  `nmemo-lpy` (`b64a476`) validates the 6000-char window default.
- `nmemo-1cp` (`2ab1ed9`) — nomic-embed task prefixes on the retrieval path.
- `nmemo-wow` (`823ce2c`) / `nmemo-agf` (`77b40e1`) — isolate Qdrant tests to `memories_test`;
  forward `QDRANT_COLLECTION` to the spawned graph-MCP server.

### C. Graph-anchored fallback retrieval (epic `nmemo-0wq`)

**Intent.** When plain vector recall misses, expand from graph anchors to recover evidence.
- `0wq.1` (`c160bb0`) design -> `0wq.2` (`f0be5be`) neighbour expansion + evidence-unit fetch
  (`expandFromAnchors`) -> `0wq.3` (`8b523b2`) query-failure trigger + re-rank wired into the
  query paths -> `0wq.4` (`b4abe99`) eval harness with an **honest "no uplift" finding** (kept
  as a negative result, not reverted).

### D. AGE sync fix (`nmemo-zgw`, `62cfe0c`)

**Intent / what.** `sync_entity_to_graph` / `create_entity_edge` ran a cypher
`SET ... = localtimestamp`, which this AGE build rejects (SQLSTATE 42703). The bare-catch
swallowed it as a WARNING, so **every entity insert synced ZERO nodes into the AGE
`knowledge_graph`** and all graph traversal returned []. Fix drops the `localtimestamp` SET
(mig `039_age_sync_no_localtimestamp.sql`). AGE is a traversal index only; canonical timestamps
live in the Postgres tables.

### E. Infra / robustness

- `nmemo-8w5` (`5cd112f`) — bound `agentFetch` by **AbortController**, not undici
  `headersTimeout` (long agent calls). NOTE: the incoming branch has `nmemo-1tc` which *disables
  undici client response timeouts* for the same reason — **reconcile these deliberately**, do not
  blindly take one side.
- `nmemo-klv.10` (`3f3498a`) — capture Claude CLI stderr+stdout tails in structured failure
  detail (the `rc=1` / `stdout_tail` shape).

### F. This session's UNCOMMITTED changes (benchmark harness)

- `benchmarks/longmemeval/run.py` — per-window `client.ingest()` wrapped in its own try/except:
  a slow/timed-out/500'd window logs `ingest WARN`, increments `ingest_failures`, and the run
  continues. Question-level abort reserved for query/judge.
- `benchmarks/.env` (gitignored) — `MNEMO_BENCH_HTTP_TIMEOUT=1200` (was 600).
- New: `benchmarks/results/longmemeval/runs/2026-06-15-*.json` + regenerated md/dashboard.
- Bead `nmemo-zro` filed (session-limit resilience for `claude -p`).

---

## Conflict hotspots and how to reconcile

| File | Our side | Incoming (epoch-v2) side | Reconcile rule |
|---|---|---|---|
| `ml-services/app/graph_agent.py` | `_system_prompt_for(content_type)` with `conversational` branch + compose-not-override segment assembler (`_graph_agent_system_prompt`, `_WORKFLOW3_*`/`_PHASE2_BODY_*`/`_REMINDER_PRONOUN_*`, NARRATIVE vs CONVERSATIONAL); subject-anchoring | `_system_prompt_for(content_type, actor)` with `extraction_proposer` -> standalone `PROPOSER_SYSTEM_PROMPT`; `_build_proposer_user_prompt` (ORIENT->EXTRACT->RELATE->VERIFY, no CAUSE); content_type body OLD base+addendum (no conversational branch). **E4 (`82f42d0`) THEN E7 (`fd448f4`, now the LAST commit): E7 retired the per-chunk CAUSE write path — the legacy prompt is now 4-phase `ORIENT → EXTRACT → RELATE → VERIFY`, `create_causal_edge`/WORKFLOW 5/PHASE 4: CAUSE deleted, `_build_legacy_user_prompt` no longer says CAUSE. Untouched by E5/E6 (E6's `e416a4e` only touched `causal_agent.py`).** | The whole collision is in `_system_prompt_for` (merge to one `(content_type, actor)` signature keeping BOTH the `extraction_proposer` branch AND our `conversational` branch + segment assembler) plus the user-prompt builder split (`_build_legacy_user_prompt` — now CAUSE-free, 4-phase — vs `_build_proposer_user_prompt`). Do NOT let their base+addendum body overwrite our segment assembler (the `hms` regression). Do NOT re-introduce the legacy CAUSE workflow — E7 removed it from the non-proposer path too. `PROPOSER_SYSTEM_PROMPT` is a standalone literal, so the proposer does NOT inherit our gate-absent/subject-anchoring segments — decide whether to re-express it through them. |
| `platform/src/services/causal-agent.ts` | `ContentType` union includes `conversational` (OURS-only); graph tool defs; `reasoning_agent` writes canonical directly | LANDED E5+E6: `ACTOR_TOOL_ALLOWLIST` w/ `extraction_proposer` (`PROPOSER_SURFACE`), `causal_agent` (`CAUSAL_SURFACE` = reads + `propose_causal_edge`), `reconciliation_agent` RECAST to `ARBITER_SURFACE` (+ `propose_identity_verdict`/`propose_conflict_resolution`, no `get_reconciliation_context`); `execute_merge`/`create_same_as_link`/`resolve_contradiction` filtered out of EVERY surface (defs+handlers REMAIN); `invokeArbiterAgent`/`invokeCausalAgent`. **LANDED E7 (`fd448f4`): `create_causal_edge` tool def + handler DELETED from `GRAPH_TOOLS` (no actor holds it); new audit `actor-tool-allowlist.test.ts`.** | ADD our `conversational` member to their union (theirs lacks it). Take their allow-list machinery WHOLESALE, incl. the E7 `create_causal_edge` deletion (do not re-add). Do NOT preserve `reconciliation_agent`'s old surface — it is intentionally verdict-only now; `graph_agent`/`reasoning_agent`/`gardener_agent` keep `LEGACY_SURFACE`, which STILL holds `expire_fact`/`update_entity_summary`/`expire_causal_edge`/`revise_causal_edge` BY DESIGN (E7 final state, not a follow-up — a merge that strips them is a regression). Do NOT delete the retired-trio handler `case` blocks (E7 left them). |
| `platform/src/pipeline.ts` | content_type plumbing -> graph agent; `fact_units` link writes; reconciliation auto-trigger | propose->promote wiring; **Phase-4 CAUSAL pass — `runCausalPass(epochId, result)` after `promote()`, best-effort try/catch, self-skips on no trigger (`648f209`)**; transient graph-agent retry; configurable arm concurrency. **LANDED E7 (`fd448f4`): `filterLiveEntityIds` DELETED (only comments at `:596`/`:751` remain) AND the optimistic arm's post-hoc final-reconcile sweep removed — promotion is the single writer.** | Keep our `fact_units` link write + content_type plumbing AND their retry/propose wiring AND their post-`promote()` CAUSAL call (`import { runCausalPass } from './services/causal-pass.js'`). CAUSAL wiring lives in `runEpochBatch`; our `fact_units` write lives in `extract()` — they rarely textually collide. Do NOT re-introduce `filterLiveEntityIds` or the optimistic final-reconcile sweep (E7 deleted both; the FK band-aid is moot under single-writer promotion). Do NOT fold `runCausalPass` into the promotion tx. Also merge config knobs `CAUSAL_PASS_FACT_THRESHOLD=5`, `CAUSAL_PASS_SCOPE_CAP=200`, `CAUSAL_PROMOTION_STRENGTH=0.6`. |
| `platform/src/index.ts` | `parseContentType` accepts `conversational`; `/api/reset` (PG+Qdrant); scheduler wiring | UNTOUCHED by E5/E6. Epoch batch routes (`/ingest/batch/{serial,epoch,optimistic}` via shared `handleBatch`, optional per-request `concurrency` body field) already present at base; `parseContentType` here does NOT accept `conversational` (3-member union) | Keep our 4-member `conversational` `parseContentType` (incoming would overwrite it — guardrail #3). No net-new epoch endpoints to merge. The E6 `/causal-agent` route is a **FastAPI route in `ml-services/app/causal_agent.py`** (mounted in `main.py`), NOT a Hono route here — reconcile it in the ml-services area. Keep our `/api/reset` + scheduler wiring on top of their batch handler. |
| `platform/src/db/schema.ts` | `fact_units`, `stream_participants`, `fact_sources` | `staging_proposed_facts`, `staging_proposed_entities` (mig `040`), `arbiter_verdicts` (E5, mig `043`), `staging_causal_edges` (E6, mig `044`), + two new columns on the EXISTING `causal_edges`: `stale_citation`, `stale_citation_reason` (E6, mig `044`) | Additive — keep all tables from both sides AND the `causal_edges` column ALTER. schema.ts itself merges cleanly. **The real hazard is in `migrations/`, not `schema.ts` — see guardrail 5: numbers `037`/`038`/`039` COLLIDE between the two branches.** |
| `platform/package.json` / `pnpm-lock.yaml` | — | — | Re-run `pnpm install` after a manual JSON merge; do not hand-merge the lockfile. |

---

## Don't-lose-functionality guardrails (verify each AFTER the merge)

1. **`graph_agent.py` must stay compose-not-override.** On Haiku, an appended override loses to
   an earlier gate. The conversational prompt must have the proper-noun gate ABSENT, not appended
   against. Re-read `nmemo-hms` before resolving this file.
2. **Prose path stable — but RE-BASELINE to the E7 4-phase text.** The Frankenstein narrative regression
   depends on the prose/code prompt's structure (NARRATIVE variants spliced, proper-noun gate present).
   E7 (`fd448f4`) legitimately changed that prompt from 5-phase to 4-phase (CAUSE removed), so the
   ml-services exact-equality test's expected string is now the E7 4-phase text ("ORIENT → EXTRACT →
   RELATE → VERIFY", no PHASE 4: CAUSE) — `test_graph_agent_prompt.py` was updated to match. Keep that
   test green against the NEW baseline; do not restore the historical 5-phase string.
3. **`ContentType` union keeps `conversational`** in BOTH `index.ts` (`parseContentType`) and
   `causal-agent.ts`. Otherwise conversational extraction is silently downgraded to prose over HTTP.
4. **Subject-anchoring + no-assistant-self-profile** semantics preserved (assistant "you graduated"
   -> USER; assistant "I recommend" dropped).
5. **Migrations must be applied to any DB the merged code runs against — and the numbers COLLIDE.**
   `migrate.ts` has NO journal and is not run on platform boot, so the live DB silently lags AND a
   duplicate-numbered file can be silently skipped. **OURS:** `037_stream_participants.sql`,
   `038_fact_units.sql`, `039_age_sync_no_localtimestamp.sql`. **INCOMING (epoch-v2, all required):**
   `037_fact_triple_unique.sql`, `038_fact_subject_fk_restrict.sql`, `039_canonical_role_hq_predicates.sql`,
   `040_staging_proposals.sql` (creates `staging_proposed_facts`/`staging_proposed_entities`),
   `041_promotion_actor.sql`, `042_staging_supersedes_hint.sql`, `043_arbiter_verdicts.sql` (E5),
   `044_causal_pass.sql` (E6: `staging_causal_edges` + the `causal_edges.stale_citation`/`stale_citation_reason`
   columns). **HARD COLLISION:** both branches use `037`/`038`/`039` for DIFFERENT SQL. The incoming
   chain `037`-`044` is contiguous, so renumber OUR three to `045`-`047` (simplest) before merging, then
   `ls platform/src/db/migrations | sort | awk -F_ '{print $1}' | uniq -d` must be empty. All new
   migrations are explicitly `public.`-qualified per the AGE search_path gotcha — verify those qualifiers
   survive any hand-edit during renumbering. Then run `npm run db:migrate` post-merge.
6. **Undici/timeout reconciliation.** Our `nmemo-8w5` (AbortController bound) vs their `nmemo-1tc`
   (disable undici response timeout) target the same long-agent-call problem. Pick one coherent
   approach; do not leave both half-applied.

## Post-merge verification checklist

- [ ] `cd platform && npm run typecheck` clean.
- [ ] Migration numbers unique after renumbering: `ls platform/src/db/migrations | sort | awk -F_ '{print $1}' | uniq -d` is EMPTY (no duplicate `037`/`038`/`039`).
- [ ] `npm run db:migrate` then verify: `to_regclass('public.fact_units')`, `stream_participants`,
      epoch `staging_proposed_*`, `arbiter_verdicts` (E5), `staging_causal_edges` (E6) all non-null;
      `causal_edges` has columns `stale_citation` + `stale_citation_reason` (E6);
      `sync_entity_to_graph` has NO `localtimestamp`; AGE graphs `knowledge_graph` + `causal_graph`
      present; `entity_types` includes `assistant`.
- [ ] `graph_agent.py` merged correctly: `_system_prompt_for` takes BOTH `content_type` and `actor`;
      `actor=='extraction_proposer'` -> proposer prompt AND `content_type=='conversational'` -> conversational
      prompt (neither branch lost); the legacy non-proposer prompt is FOUR-phase `_build_legacy_user_prompt`
      "ORIENT → EXTRACT → RELATE → VERIFY" with NO CAUSE phase and NO `create_causal_edge` def (E7 retired it):
      `grep -c create_causal_edge ml-services/app/graph_agent.py` is 0; module docstring says "multi-phase".
- [ ] ml-services prompt unit tests green (12 conversational tests) AND the prose-path byte-identical check
      RE-BASELINED against the E7 4-phase text (`test_graph_agent_prompt.py` now expects "Process the source
      text above through all phases" + "ORIENT → EXTRACT → RELATE → VERIFY"; the historical 5-phase string is
      stale) AND `ml-services/tests/test_proposer_prompt.py` green (proposer prompt has VERIFY, no `RELATE -> CAUSE`, says "NO CAUSE phase").
- [ ] `speaker-aware-extraction.test.ts` 7/7 on real Haiku (a/b/c first-person anchoring; d prose unchanged).
- [ ] `q0-degree-retest.test.ts` green (conversational re-ingest -> "Business Administration" on USER).
- [ ] Merged `ContentType` union includes BOTH `conversational` AND `prose`|`code-ts`|`code-sql` in
      `index.ts` `parseContentType` and `causal-agent.ts` (our member survived, theirs did not clobber it).
- [ ] `causal-agent.ts` allow-lists assert (via the new `actor-tool-allowlist.test.ts`, E7):
      `reconciliation_agent`=`ARBITER_SURFACE` (two verdict tools, no `get_reconciliation_context`, no canonical
      writes); `causal_agent`=`CAUSAL_SURFACE` (has `propose_causal_edge`); NO propose/verdict actor holds ANY
      canonical-write tool incl. `expire_causal_edge`/`revise_causal_edge`; `create_causal_edge` is ABSENT from
      `GRAPH_TOOLS` entirely (E7 deletion); `execute_merge`/`create_same_as_link`/`resolve_contradiction` absent
      from every surface (but their handler `case` blocks SURVIVE the merge); `gardener_agent` UNCHANGED (still
      has `update_entity_summary`/`add_entity_alias`, surface strictly larger than proposer); `LEGACY_SURFACE`
      actors (`graph_agent`/`reasoning_agent`) STILL hold `expire_fact`/`update_entity_summary`/`expire_causal_edge`/`revise_causal_edge`
      (deliberate E7 final state); `invokeArbiterAgent` + `invokeCausalAgent` exported.
- [ ] epoch-v2 surface tests green: `epoch-propose-tools.test.ts`, `destructive-tools-dispatch.test.ts`,
      `actor-tool-allowlist.test.ts` (E7), `promotion.test.ts`, `promotion-plan.unit.test.ts`,
      `causal-pass.test.ts`, `causal-pass-trigger.unit.test.ts`, `causal-promotion.unit.test.ts`.
- [ ] E7 band-aids stayed retired post-merge: `filterLiveEntityIds` ABSENT from `pipeline.ts`
      (`git grep filterLiveEntityIds platform/src` returns only the two comments at `:596`/`:751`);
      `runOptimisticBatch` has no post-hoc final-reconcile sweep; `runEpochBatch` still runs all five phases.
- [ ] Orphan-entity cleanup folded into promotion: `PromotionPlan.droppedOrphanEntities` exists,
      `planPromotion` filters `entitiesToMint` to fact-referenced cluster keys (order-independent,
      prior-canonical untouched), and `promote()` logs `dropped_orphans=...`.
- [ ] Epoch path runs all five phases: an epoch ingest logs STORE -> PROPOSE -> PROMOTE -> (conditional)
      "causal pass ran" OR self-skip, with NO thrown error failing the epoch.
- [ ] **fact->unit links on the EPOCH path** point at CANONICAL (promoted, SURVIVING) fact ids — run an epoch
      ingest and assert `fact_units` rows reference promoted fact ids AND do NOT reference facts dropped by
      promotion's E7 cleanup (`droppedSelfLoops`, `droppedOrphanEntities`). This C.3 re-home into `applyPromotion`
      is still UNIMPLEMENTED (highest-risk silent drop). Single-pass `extract()` path also still writes them.
- [ ] Causal pass is LIVE-VERIFIED (E6 closed, `e416a4e`): `verify-causal-live.ts` PASSED on real Haiku
      (cross-chunk funding->relocation edge on settled ids, 3 source refs, not stale). Optionally re-run
      post-merge (`ML_SERVICES_URL=http://localhost:8001 npx tsx scripts/verify-causal-live.ts`) to re-confirm;
      the corpus10/20 `expired_but_cited` check is a SEPARATE benchmark run if desired. No longer an outstanding step.
- [ ] Gardener long-range dedup regression (E5): merge/link were stripped from the gardener allow-list —
      check the filed follow-up bead and confirm whether the dedup execution path needs restoring.
- [ ] AGE sync check after first ingest: `SELECT count(*) FROM cypher('knowledge_graph', $$ MATCH (e:Entity) RETURN e $$) as (e agtype)` climbs; no `localtimestamp` warnings in the platform log; no `fact_units does not exist` warnings.
- [ ] Re-run the 1-question longmemeval smoke (`uv run python -m longmemeval.run --sample 1`) and
      confirm it scores the degree question correctly end-to-end.

## Live-environment gotcha (recurring)

The shared dev stack runs on the host (platform :3001, ml-services :8000, pi-bridge :3099); only
Postgres (:5433) and Qdrant (:6335) are dockerised. The `claude -p` agent path is shared session
quota — under contention from parallel agents it returns `rc=1` (empty stderr) and ingest windows
500 in a cascade. The harness now survives individual window failures (see F) and supports
`--resume-from N`. Tracked for a proper fix in `nmemo-zro`.
