# 31 — Review Cycle Synthesis (Reviews #1–#13)

**Status:** DRAFT (Review #14, nmemo-2yv.14) — 2026-05-25
**Scope:** Wiring-improvement plan distilled from the 13-feature audit cycle that ran 2026-05-13 → 2026-05-25 under epic [nmemo-2yv](../../../platform/.beads/issues.jsonl).

This doc is the durable artefact of the review cycle. The individual review notes (in `platform/.tmp/review-N-*-notes.md`) are scratch; this doc is the permanent reference.

## Reading order

1. [§1 Recap](#1-recap) — the numbers
2. [§2 Theme inventory](#2-theme-inventory) — patterns that recur across features
3. [§3 Cross-feature compose gaps](#3-cross-feature-compose-gaps) — where Feature A should call Feature B and doesn't
4. [§4 New cross-cutting findings](#4-new-cross-cutting-findings) — beads filed only because the synthesis surfaced them
5. [§5 Prioritised landing roadmap](#5-prioritised-landing-roadmap) — bead clusters with rationale + critical path

---

## 1. Recap

13 features audited in 12 working days. 115 findings filed across them; 8 closed (mostly retroactive cleanup of obsolete state), 107 open as of close.

### 1.1 Reviews and headlines

| # | Feature | Findings | Range | Headline |
|---|---|---|---|---|
| 1 | Graph S core (entities/facts/predicates) | 8 | .15–.22 | Pipeline bypasses Graph S service layer |
| 2 | Causal layer (Graph C) | 5 | .24–.28 | Standalone causal agent path is dead; unified graph agent replaced it |
| 3 | Audit trail | 8 | .29–.36 | `createFact` corroborate path non-atomic with its audit row; `merge_entities()` PL/pgSQL bypasses fact audit |
| 4 | Contradiction detection | 5 | .37–.41 | Edge-only resolution gap + race condition in `resolveContradiction`; `chain_conflict` has no INSERT path |
| 5 | Graph meta + stats | 9 | .42–.50 | Two writers to `merge_candidates` with divergent scoring (graph-meta + cross-cluster-generator) |
| 6 | Entity profile / summary | 9 | .51–.59 | Feature fragmented across three silos that don't talk to each other |
| 7 | Reconciliation + gardening | 11 | .60–.70 | Functionally broken-by-default — enum mismatch + no auto-trigger + PL/pgSQL FK violations |
| 8 | Reasoning reports | 12 | .71–.82 | Adversarial surface (round-tripped untrusted text) + missing auto-trigger |
| 9 | Entity topology + clusters + drift | 7 | .83–.89 | Master-plan locks unmet (W6 patrol-time promise); auto-triggers missing for all three computes |
| 10 | Cluster bridging / cross-cluster | 9 | .90–.98 | Sibling features have `*_runs` telemetry; cross-cluster doesn't |
| 11 | Impact / blast radius | 11 | .99–.109 | Service surface clean; gaps are observability + hardening |
| 12 | Integrations (ML / Qdrant / Pi bridge) | 13 | .110–.122 | No canonical Integrations doc; port-collision land-mine; three boundary-module dead exports |
| 13 | MCP servers | 7 | .123–.129 | `/api/mcp-health` probes the wrong server; duplicate `causal-mcp.ts`; transport divergence |

### 1.2 Priority and theme spread

**By priority (115 findings):**
- P1 — 26 (23%) blocking correctness or production observability
- P2 — 48 (42%) hardening, doc gaps, telemetry
- P3 — 41 (35%) polish, micro-correctness, deferred-default schema

**By theme (deduplicated finding count; cross-cuts many features):**

| Theme | Findings | What it captures |
|---|---|---|
| T1 — doc-vs-code drift | 8+ | Doc claims X, code does Y |
| T7 — naming mismatch | 3+ | Schema CHECK / tool enum / prompt vocabulary disagree |
| T8 — adversarial surface | 4+ | Agent-writable text round-tripped without sanitisation |
| T9 — observability gap | 9+ | Missing `*_runs` telemetry, missing probes, lost diagnostics |
| T10 — deferred-default schema | 1+ | FK ON DELETE defaults bite later |
| T11 — silent drift | 5+ | Config / model / dim / transport divergence with no signal |
| T12 — missing auto-triggers | 1+ | Compute exists, never fires automatically |
| T13 — half-built pipeline | 8+ | Caller exists, callee never invoked; export defined, never called |

Theme tagging was introduced systematically from Review #7 onwards; reviews #1–#6 produced findings that match the same themes without explicit Tn tags. See [§2](#2-theme-inventory) for the full bead lists per theme.

### 1.3 Cycle hygiene metrics

- **Falsified premises (retraced findings that didn't hold):** 5 across reviews #3–#13 — cumulative rate ~7%. Re-validation before locking is doing real work.
- **Scope extensions vs. standalone:** ~4 findings absorbed into existing beads (e.g. C7 → .83 in #9); the rest stand alone.
- **Bead body shape:** Premise / Falsifying test / Result / Impact / Scoped fix / Acceptance / Decision (locked YYYY-MM-DD). Standardised from Review #4 onward.

---

## 2. Theme inventory

Each theme below: definition, the cross-feature pattern that produces it, the open beads that hit it, and the highest-leverage cross-cutting fix when one exists.

### 2.1 T1 — doc-vs-code drift

**Pattern.** A design doc states a contract; the code diverges silently. Either the doc was written ahead of implementation and never reconciled, or a refactor moved on without updating the doc. Three-way variant: pre-impl `issues/0N-*.md` + post-impl arch doc + code, all three disagreeing (named "T11 three-way" in Review #9).

**Beads (tagged T1):** .67 (.gardening_reports under-reporting), .70 (recon/gardener doc-gap), .80 (causal-agent.ts misnaming), .106 (Rule 1b broadening), .112 (Pi bridge port 3001/3099 collision), .123 (MCP probe), .124 (delete causal-mcp.ts), .125 (MCP transport doc 30).

**Cross-feature observation.** T1 is the most common theme; >20 findings across all 13 reviews if you count titles that mention "doc says X, code does Y" without the explicit tag. The places where docs and code diverge most heavily are the boundary points where two features compose (MCP transport, integrations, port allocations).

**Highest-leverage fix.** Doc 29 (Integrations layer, nmemo-2yv.110) + doc 30 (MCP transport, nmemo-2yv.125) + this doc 31 are the three canonical references that close the largest doc-vs-code gaps. After they land, T1 becomes a single-bead problem per drifted feature rather than a cross-feature theme.

### 2.2 T7 — naming mismatch

**Pattern.** Schema CHECK constraint, tool enum, agent prompt, or HTTP API use disagreeing vocabulary tokens for the same concept. The system stays superficially happy because each layer validates locally, but cross-layer messages get rejected silently.

**Beads (tagged T7):** .60 (resolve_candidate enum vs. merge_candidates.resolution CHECK).

**Untagged but T7-shaped:**
- .42 / .43 / .44 (scoreMergeCandidates — two writers using disagreeing field shapes).
- .39 (chain_conflict — schema admits it, no insert path).
- .27 / .28 (doc 03 §5.2 / §5.3 sentinels diverged from code).

**Cross-feature observation.** T7 manifests where multiple layers own a vocabulary — schema layer + tool layer + agent prompt + HTTP/viz API. It's the cost of having no single source of truth for enums.

**Highest-leverage fix.** No single bead; the closest pattern is to export enum values from a TS constant + use a `CHECK ... IN ($constants)` pattern in migrations + reference the same constant in tool schemas. Not a cross-cutting bead in the current set; could become one (see §4 candidate).

### 2.3 T8 — adversarial surface

**Pattern.** Agent-writable fields (question, report, reasoning, source_text) get read back into a subsequent agent's prompt without sanitisation. The system trusts text it produced. A small prompt-injection in user-submitted text can steer the next patrol or reconciliation.

**Beads (tagged T8):** .62 (centralised prompt-safety helper), .79 (test scaffolding gap), .82 (other agents reading reasoning_history).

**Cross-feature observation.** T8 is contained to the reasoning/recon/gardener path today because those are the only agents that read prior agent output. As more agents compose (e.g. the Pi-bridge tool surface keeps growing), the surface area expands.

**Highest-leverage fix.** .62 (centralised prompt-safety helper) is the right shape — single helper, every read-back through it. The remaining beads .79/.82 are consequences: tests for the helper, and broader rollout to recon/gardener.

### 2.4 T9 — observability gap

**Pattern.** A compute runs (sometimes manually, sometimes auto-triggered) but produces no `*_runs` row, no audit entry, no count. Sibling computes do have telemetry — the gap is one feature out of step. When something breaks in production, the gap is the difference between "I can grep for it" and "I have to instrument it first".

**Beads (tagged T9):** .74, .75 (reasoning_reports CHECK + actions_taken shape), .92 (cross_cluster_runs), .111 (platform /health composes nothing), .123, .125, .126, .128, .129 (MCP probe + integration test + stderr capture).

**Untagged but T9-shaped:**
- .17 (AGE sync swallows exceptions), .33 (decay actor attribution).
- .67 (gardener auto runs not persisted).

**Cross-feature observation.** Eight features have a `*_runs` table (graph_stats_runs, entity_topology_runs, hdbscan_runs, drift_runs, gardening_reports, reasoning_reports, reconciliation_runs, audit_log). Three don't (cross-cluster, MCP transport, /health composition). Plus three "swallow exceptions" patterns. Plus dead boundary-module probes (`ml.health`, `checkQdrantHealth`).

**Highest-leverage fix.** .111 (compose health endpoints) + .92 (cross_cluster_runs) + a cross-cutting "no compute without a *_runs table" invariant would close most of T9 in one phase. See §4 candidate.

### 2.5 T10 — deferred-default schema policies

**Pattern.** FK ON DELETE defaults (`RESTRICT`) silently block future migrations or sweep operations. Migrations move on; the default bites later.

**Beads (tagged T10):** .78 (reasoning_report_id FK columns).

**Cross-feature observation.** Single-finding theme — likely there are more if every FK in the schema were re-audited. Low priority unless a sweep operation actually fails.

### 2.6 T11 — silent drift

**Pattern.** A configuration value, model name, embedding dimension, or transport implementation changes; some consumer still has the old value; the system runs without error but produces wrong output (e.g. embedding-dim mismatch silently writes garbage vectors).

**Beads (tagged T11):** .121 (qdrant.ensureCollections doesn't validate dim), .123 (MCP wrong target), .125 (MCP doc drift), .126 (probe env passing), .127 (write-tool serialization across transports).

**Cross-feature observation.** T11 lives at the boundary between code and infrastructure config — env vars, model names, dimensions, transport-selection toggles. The cross-feature pattern is "this value is owned by config but referenced from code; nobody validates them against each other".

**Highest-leverage fix.** Boundary-validation invariants: `ensureCollections` should validate dim at startup; `getMcpConfigPath` env should be a typed dict; transport-selection should fail loudly when transports diverge (see also §4 candidate on transport-parity testing).

### 2.7 T12 — missing auto-triggers

**Pattern.** A compute exists and is correctly implemented but is never invoked automatically. Only a manual viz button or HTTP POST runs it. Production deploys depend on operators remembering to push the button.

**Beads (tagged T12):** .84 (topology/clustering/drift auto-triggers).

**Untagged but T12-shaped:**
- .71 (reasoning agent auto-trigger — review #8).
- Reconciliation manual-only (review #7 headline).
- .67 ish (gardener triggered but not logged).

**Cross-feature observation.** Every compute in the graph layer should have a documented trigger condition: post-ingest hook, patrol-interval, or *_runs count threshold. Today the trigger model is per-feature and inconsistent. .84 is the architecturally correct response for topology/clustering/drift; the same pattern should apply to reasoning and reconciliation but is filed only piecemeal.

**Highest-leverage fix.** See §4 candidate — a single architecture doc enumerating every compute and its trigger.

### 2.8 T13 — half-built pipeline

**Pattern.** Code exists for both ends of a relationship — caller side and callee side — but the wire between them was never connected. Either the caller bypasses the callee (.15 pipeline-bypasses-Graph-S), the callee has no caller (.6 entity-profile zero callers, .24 standalone causal agent, .25 causal query interface, .124 causal-mcp.ts), or an export is defined and never imported (.26 CAUSAL_AGENT_TOOLS, .12 ensureCollections, .12 ml.health, .12 checkQdrantHealth).

**Beads (tagged T13):** .86 (topology test scaffolding), .92 (cross_cluster_runs), .103 (impact subpanel for facts), .104 (dead hypothetical modes), .124 (delete causal-mcp.ts), .125 (MCP doc), .127 (transport divergence), .128 (integration test gap).

**Untagged but T13-shaped (heavy):**
- Reviews #1, #2, #6, #12 are entirely about T13 dynamics.

**Cross-feature observation.** T13 is the largest theme by far when untagged findings are counted. Every review surfaced at least one example. The cross-feature pattern: features ship with their primary path implemented and their integration-point implemented, but the connecting wire — pipeline.ts call, viz panel read, auto-trigger, MCP tool reference — is missing or wrong. Often a sign that a feature was implemented in a worktree and merged before the integration audit caught the missing connector.

**Highest-leverage fix.** No single bead. The pattern argues for a "feature integration checklist" — every new feature PR must verify: is it called from pipeline.ts? Is it read from viz? Is there a *_runs row? Is the MCP tool registered? Does it have an auto-trigger? This is a process change, not a code change. See §4 candidate.

### 2.9 Transport divergence (new candidate from #13)

**Pattern.** A replacement transport (Pi bridge) lands; the original transport (MCP servers) is neither retired nor maintained at parity. The old path rots silently: write-tool serialization added to Pi only; tool count drifts; the probe targets a duplicate. One env-var change reactivates the rotted path.

**Beads:** .124, .125, .126, .127 from Review #13.

**Cross-feature observation.** This is the first review where a transport-replacement pattern was named. It probably applies elsewhere — the ml-services LLM provider switch (`claude` / `pi` / `zai`) is the same dynamic. Each provider needs parity testing or one will silently rot.

**Highest-leverage fix.** See §4 candidate.

---

## 3. Cross-feature compose gaps

Seven gaps where Feature A should call Feature B and doesn't. Each gap names the cure (existing bead cluster) and the structural lesson (often pointing at a §4 cross-cutting finding).

### G1 — Health composition

Every boundary module has a probe. Nothing composes them.

- `ml.health()` (exported by `ml-client.ts`) — never called.
- `checkQdrantHealth` (exported by `qdrant.ts`) — never called.
- `/api/mcp-health` — exists with its own issues (see G8).
- Pi bridge `/health` (port 3099) — checked only by `ml-services PiBridgeProvider` at startup.
- Platform `/health` reports platform liveness only, no aggregation.

**Why it exists.** Each boundary module was added as a separate worktree; each built its own probe as a sibling primitive. Platform `/health` predates the boundary modules and was never refactored when ml-services, Qdrant, and Pi bridge were added.

**Cure.** `.111` composes all probes into one platform `/health`. After it lands, this gap closes.

**Related dead-export dynamic.** `ensureCollections` (`.121`) is also a dead boundary-module export, but it's a startup-bootstrap concern with a different cure (call from startup + add inline dim check). Same root pattern, different cure shape; the dim-validation half is captured under T11.

**Structural lesson.** Adding a new boundary module must update the platform `/health` composer in the same PR. Process invariant — links to C4.

### G2 — Service-layer bypass

Pipeline.ts and the API layer write directly to the DB instead of going through the service layer (entities.ts, facts.ts, predicates.ts).

- `.15` — pipeline.ts bypasses Graph S service layer.
- `.19` — API layer (index.ts) bypasses Graph S services.
- `.29` — `createFact` corroborate path non-atomic with audit row (downstream consequence).
- `.30` — `merge_entities()` PL/pgSQL bypasses fact audit (same shape, different layer).

**Why it exists.** Incremental extraction. The service layer was carved out of earlier monolithic code; the callers were never refactored. Bypass paths write directly via raw SQL or pre-extraction helpers.

**Why it matters.** Every bypass loses one or more of: audit rows, advisory locks, dedup/corroboration logic, entity-meta updates, AGE sync triggers. Review #3's audit-trail headlines (`.29`, `.30`) are exactly this.

**Cure.** `.15 + .19 + .29 + .30` collectively refactor the callers. Service layer becomes the only write path.

**Structural lesson.** New write paths must go through the service layer. Links to C4.

### G3 — Entity-profile fragmentation

The "Entity Profile" feature exists in three silos that don't talk (Review #6 headline).

- `entity-profile.ts` — the named service. Zero production callers at HEAD.
- `entity_meta.summary` — written by causal-agent via `update_entity_summary`, read by causal-agent in 3 places. Self-contained inside the causal silo.
- `/api/viz/unified` — emits `summary` on entity nodes; frontend ignores it. Compute-and-discard.

**Why it exists.** Bottom-up implementation — service, tool, viz endpoint — without ever connecting the read-through wires. The viz endpoint was added "to expose the summary"; the frontend integration was deferred.

**Why it matters.** Users never see the summaries the system pays to compute. `entity-profile.ts` looks live (exports, types, tests) but is effectively dead.

**Cure.** `.51` (P1, wire `entity-profile.ts` as canonical read assembler) is the lead. `.52` (viz reads summary), `.53` (sanitize input on write), `.55-.58` (hardening), `.59` (doc gap) supporting. After all land, viz → entity-profile.ts → entity_meta.summary becomes the one read path.

**Structural lesson.** This is the canonical T13 case for the cycle. The feature ships if each silo passes its unit tests; only an integration audit catches that nothing reads the output. Strongest argument for C4 (feature integration checklist).

### G4 — Auto-trigger absence

Five major computes have no auto-trigger; all are manual-only or fire-and-forget without scheduling logic.

| Compute | Status | Bead |
|---|---|---|
| Reconciliation | Manual-only — `merge_candidates` pile up until a user clicks `/api/reconcile` | `.61` P1 |
| Reasoning patrol | Manual-only — no temporally-aware re-run | `.71` P1 |
| Topology / clustering / drift | All three manual-only despite doc 21 §10 W6 promising patrol-time drift | `.84` P1 |
| Pattern detection + graph-stats | Coupled to reasoning patrol cadence; should be reactive to DB state | `.72` P1 |
| Cross-cluster generator | Doesn't refresh on drift events | `.85` P3 |

**Why it exists.** Each compute was implemented with a manual viz button + HTTP endpoint. The triggering policy was deferred as "Phase 2". The patrol cadence (one tick every N patrols) grew into a kitchen-sink coupling — everything that needed a trigger got hooked onto reasoning patrol whether or not that was the right cadence.

**Why it matters.** State accumulates without reconciliation. `merge_candidates` rows from auto-detection never resolve unless a user clicks Reconcile. Drift events don't surface as cross-cluster candidates. Reasoning patrols don't fire — the agent never learns from new data without operator intervention.

**Cure.** `.61 .71 .72 .84` (four P1) + `.85` (hook) + supporting tests `.79 .86`.

**Structural lesson.** Every compute needs a documented trigger condition: post-ingest hook, DB-state-change reactive, scheduled, or threshold-driven. Strongest argument for C2 (compute-trigger registry).

### G5 — Telemetry siblings

Eight features have `*_runs` audit tables. Two gaps in places where the pattern would clearly apply.

| Has `*_runs` | Gap |
|---|---|
| graph_stats_runs, entity_topology_runs, hdbscan_runs, drift_runs, reconciliation_runs, reasoning_reports, gardening_reports, audit_log | **cross-cluster generator** has no run table (`.92`) |
| | **gardener** auto-trigger writes bypass `gardening_reports` (`.67`) |

**Why it exists.** Same incremental pattern as G4. Each new compute ships with primary logic + maybe a run table; new arrivals sometimes skip it. The gardener case is worse — table is there but the auto-trigger writer doesn't reach it.

**Why it matters.** No way to grep "did cross-cluster fire today? how long? did it find candidates?" without instrumenting first. Sibling features all answer the same question from their run table. The asymmetry breaks the operator's mental model at exactly the features that need observability most.

**Cure.** `.92 + .67`.

**Structural lesson.** Every compute writes a `*_runs` row; every trigger path writes. Links to C2.

### G6 — Multi-writer with divergent scoring

Two services write `merge_candidates` rows with different scoring formulas.

- `graph-meta.detectMergeCandidates` — "three_signal" (name + alias + structural). Owns its own scoring block.
- `cross-cluster-generator.generateCrossClusterCandidates` — "cross_cluster" (across disconnected components). Owns a different scoring block.

The reconciliation agent reads `merge_candidates` rows whose scores aren't comparable: a three-signal `0.7` and a cross-cluster `0.7` mean different things. The agent prompt has been hand-tuned to paper over the divergence with heuristics.

**Why it exists.** The two computes were built in different reviews (#5 owned graph-meta; cross-cluster came later as #10-territory). When the second writer landed, the right move was to factor out a shared `scoreMergeCandidates` and route both through it. Instead each carried its own formula. The reconciliation agent inherited the divergence.

**Why it matters.** Comparable scores are the whole point. Two formulas mean "high-score = high-confidence" doesn't hold uniformly. Add a third writer and divergence compounds.

**Cure.** `.42` (extract `scoreMergeCandidates` module) + `.43` (wire `graph_stats` for adaptive weighting) + `.44` (retire cross-cluster local block + simplify agent prompt).

**Structural lesson.** If a column is written by N services, the value transformation must live in one module that all N call. Links to C4.

### G8 — MCP / Pi transport drift

Two transports for the same agentic tool-call surface; one (Pi bridge) was introduced as a replacement but the other (MCP servers) wasn't retired or maintained at parity. Every fix landed in Pi-only.

| Divergence | Bead | Pi | MCP |
|---|---|---|---|
| Duplicate server file | `.124` | n/a | `causal-mcp.ts` ships alongside `graph-mcp.ts`, identical surface |
| Write-tool serialization | `.127` | 17 tools forced `sequential` | No mutex; concurrent writes |
| Doc-vs-code drift | `.125` | n/a | docs 04/07/11 quote 7/12/25 tools (actually 38), wrong file name |
| Health probe target | `.123` | Pi `/health` works | MCP probe targets the wrong file |
| Probe env | `.126` | Same-process, env inherited | Subprocess; env must be passed explicitly, not done today |
| Stderr capture | `.129` | Same-process, visible | Subprocess stderr swallowed on success |
| End-to-end test | `.128` | Has `pi-agent-bridge.test.ts` | No subprocess startup test |

**Why it exists.** Pi bridge replaced MCP-server-per-invocation for performance. The MCP path was left as fallback (selected via `LLM_PROVIDER=claude`, which is the code default). No parity contract was written; no test enforces parity.

**Why it matters.** One env-var flip silently reactivates the rotted path. Production gets concurrent unserialized writes, a misleading health endpoint, missing diagnostics, and a 75-line dead file in `services/`.

**Cure.** All seven Review #13 beads collectively + doc 30 (from `.125`) writes the parity contract down.

**Structural lesson.** When a replacement transport lands, retire the original OR maintain it at parity via a parity test. Same pattern likely applies to `LLM_PROVIDER=zai`. Links to C5 (transport parity testing).

---

## 4. New cross-cutting findings

Five findings the cross-cutting view surfaced that no per-feature review had filed. Each is now a standalone bead under the epic.

### C1 — Enum-vocabulary single source of truth — `nmemo-2yv.130` (P2)

**Pattern.** T7 — naming mismatch. Schema CHECK constraints, tool enums, agent prompts, viz strings, and HTTP values declare disagreeing copies of the same vocabulary. Each layer validates locally; cross-layer messages get rejected silently.

**Fix.** Stand up `src/services/enums.ts` as the canonical declaration of each enum vocabulary; tool schemas + agent prompts + viz import from it; migration CHECK constraints hand-sync with a comment pointing at the constant. Canary migration: `.60`'s `resolve_candidate` / `merge_candidates.resolution` instance. Other T7 instances (`.27 .28 .39 .69`) migrate independently as their own beads land.

### C2 — Compute-trigger registry — `nmemo-2yv.131` (P2)

**Pattern.** T12 — missing auto-triggers. Five major computes have no trigger or have triggers coupled to the wrong cadence (kitchen-sinked onto reasoning patrol). No canonical doc enumerates them.

**Fix.** Create `docs/architecture/truth-graph/32-compute-trigger-registry.md`. One row per compute with trigger condition / cadence / `*_runs` table / source-of-trigger-code. Computes whose auto-trigger is still missing get `MANUAL ONLY — see <bead>` rows pointing at the P1 trigger beads (`.61 .71 .72 .84 .85`); rows resolve to real entries as each bead lands. Doc 32 itself lands first.

### C3 — Boundary-validation invariants at startup — `nmemo-2yv.132` (P2)

**Pattern.** T11 — silent drift. Config values that span code + `.env` + migrations drift without runtime signal. Qdrant dim mismatch silently corrupts vectors; port collisions silently route bridge traffic to the wrong process.

**Fix.** New `src/services/startup-validation.ts` with four initial validators (Qdrant collection dim vs `config.EMBED_DIMENSIONS`; ml-services `/health`; transport health conditional on `LLM_PROVIDER`; port-collision check). Called from `src/index.ts` before `serve()`. Strict fail-fast — failed validator → `process.exit(1)`. No `STRICT_STARTUP` opt-out.

### C4 — Feature integration checklist — `nmemo-2yv.133` (P3)

**Pattern.** T13 — half-built pipelines. Multiple per-review headlines were variants of "feature exists but the connecting wire is missing". No process gate forces "show me the read path" before merge.

**Fix.** Add a "Feature integration checklist" section to `CONTRIBUTING.md`. Eight items: service-layer-write-only, compute-trigger registered, pipeline/viz/MCP wires, `*_runs` row, enums in SSOT, cross-language strings match, health composed, startup validator. Items reference C1/C2/C3 forward — checklist becomes load-bearing as those beads land. No PR-template modification; no mechanical enforcement.

### C5 — Transport parity contract test — `nmemo-2yv.134` (P3)

**Pattern.** §2.9 transport divergence. Two LLM transports (Pi bridge, MCP server) implement the same agentic flow with subtle divergences. Each transport's own tests verify *its own* shape; nothing asserts equivalence.

**Fix.** New `src/test/harness/transport-parity.test.ts` with four assertions: same tool name set, same total count vs `GRAPH_TOOLS.length`, write-serialization parity (concurrent `create_fact` serialized in both), unknown-tool error envelope identical. Pi + MCP only — ZAI excluded with a documented note in doc 30. Depends on `.127` (write-serialization moved into `handleToolCall`) before the serialization assertion can pass.

---

## 5. Prioritised landing roadmap

Six phases. Phase boundaries map to "what becomes possible after these beads land" — not to time or sprint cadence.

### Phase 1 — Stop bleeding

P1 correctness or observability bugs that mask other bugs or run with silent wrong output. Land these first; downstream reasoning is harder while they're live.

| Bead | Why first |
|---|---|
| `.123` MCP probe targets wrong server | Health endpoint is lying; later transport work assumes the probe is honest |
| `.112` Port collision (3001) | New devs hit it on first `npm run bridge`; blocks clean reproduction |
| `.60` `resolve_candidate` enum mismatch | Same-as resolutions silently dropped; reconciliation broken; C1's canary |
| `.29 .30` Audit atomicity / `merge_entities()` PL/pgSQL | Audit rows missing from bypass writers; G2 work assumes audit completeness |
| `.37 .38` Contradiction edge-only / race | Edge-only contradictions can't resolve; race in `resolveContradiction` |

### Phase 2 — Doc anchors

Canonical reference docs that other beads cite. Land before sprawling refactor work so PRs can point at them.

| Bead | What |
|---|---|
| `.110` | Doc 29 — Integrations layer (port table, retry policy, TS→Python→TS round-trip) |
| `.125` | Doc 30 — MCP transport (parity contract + count/file-name fixes in docs 04/07/11) |
| `.131` (C2) | Doc 32 — Compute-trigger registry (lands first with TODO rows pointing at trigger beads) |
| `.133` (C4) | `CONTRIBUTING.md` feature integration checklist referencing all of the above |

Doc 31 (this synthesis) lands as part of closing Review #14.

### Phase 3 — Cross-cutting infrastructure

The C-findings that downstream beads consume.

| Bead | What |
|---|---|
| `.130` (C1) | `src/services/enums.ts` + migrate `.60` canary |
| `.132` (C3) | `src/services/startup-validation.ts` + four initial validators |

### Phase 4 — Compose gaps

Structural gaps from §3. Bigger refactors but each closes an entire class of bug.

| Cluster | Cure beads |
|---|---|
| G1 health composition | `.111` |
| G2 service-layer bypass | `.15 .19` (`.29 .30` landed in Phase 1) |
| G3 entity-profile fragmentation | `.51 .52 .53 .55-.58 .59` |
| G4 auto-triggers | `.61 .71 .72 .84 .85` |
| G5 telemetry siblings | `.92 .67` |
| G6 multi-writer divergent scoring | `.42 .43 .44` |
| G8 MCP/Pi transport drift | `.124 .126 .127 .128 .129` + `.134` (C5) |

### Phase 5 — Adversarial + observability hardening

T8 + remaining T9. Lower urgency once cross-cutting infrastructure exists.

| Cluster | Cure beads |
|---|---|
| T8 adversarial surface | `.62 .79 .82` |
| T9 stragglers | `.74 .75 .121` and other observability gaps not covered in Phase 4 |

### Phase 6 — Polish

P3 stragglers — dead-export cleanups, deferred-default schema (T10), doc nits, dead-script cleanup. ~25 beads. Land opportunistically.

### Critical path

A handful of beads gate the rest. Sketch:

```
.123 (Phase 1) ──┐
                 ├─→ .125 (Phase 2)  ──→  .134 (Phase 4)
.127 (Phase 4) ──┘                  ──→

.60  (Phase 1) ──→ .130 (Phase 3)  ──→ (other T7 instances .27 .28 .39 .69)

.111 (Phase 4) ──→ .132 (Phase 3)  ──→ (other startup checks)

.84  (Phase 4) ──→ .131 (Phase 2)  ──→ (TODO rows resolve)
```

Everything else parallel within its phase. Phase 4 is the largest by bead count (~40 beads across seven clusters) and where the bulk of the cycle's value lands.

---

## Closeout

Review #14 — Cross-feature synthesis — closed 2026-05-25.

- **Findings filed:** 5 new cross-cutting beads (`.130-.134`).
- **No falsifications.**
- **Doc 31 (this doc) ships with Review #14's closing commit.**

The 13-feature review cycle produced 115 standalone findings plus the 5 cross-cutting findings here. ~26 P1, ~50 P2, ~45 P3. The roadmap above sequences them for landing.
