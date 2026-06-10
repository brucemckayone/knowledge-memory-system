# 41 — Epoch v2: Propose / Promote Architecture

**Status:** Design — basis for continued work (written to survive a fresh-context handoff)
**Branch:** `feat/parallel-ingestion`
**Builds on:** [38 — Parallel Ingestion](38-parallel-ingestion.md) (Approach A), [39 — Validity Harness](39-graph-validity-harness.md), [40 — Epoch Hardening Issues](40-epoch-hardening.md), [01 — Dual-Graph Architecture](01-dual-graph-architecture.md), [04 — Sparse Branch Design](04-sparse-branch-design.md), [07 — Graph-Agent Workflow](07-graph-agent-workflow.md).
**Supersedes (in intent):** the current single-epoch `runEpochBatch` in `pipeline.ts`.
**Revision:** 2026-06-09 — fleshed out §8a (per-agent tool surface + return shapes) and resolved §12 #1–#9; remaining open item is migration (#10 → §13).

> This document is the agreed redesign of epoch ingestion (Approach A). It exists because the 2026-06-09 benchmark ([report](../../benchmarks/results/parallel-ingestion-2026-06-09.md)) showed the current epoch implementation parallelises *writes* but treats *reconciliation* as an afterthought, which is the root of every correctness failure we saw. It records the locked design decisions, the full target architecture, what it reuses/retires, and the questions still open — enough to resume the design or start building in a clean session.

---

## 0. Why we are redesigning (the evidence)

The benchmark ran all three arms (serial, epoch, optimistic) over a 10- and 20-chunk authored corpus. Findings that drive this design:

- **Supersession fails structurally.** `createFact → findSupersedingFacts` matches an *exact predicate string* (`facts.ts:148,412`); the cross-predicate exclusivity-group map (`resolveExclusiveGroup`, `graph-invariants.ts:55`) exists but is **detection-only**. Result: `job_title`/`has_job_title`/`has_role` coexist; HQ lives under `lives_in`/`relocated_to`/`headquartered_in` at once. Failed in 5 of 6 runs.
- **Entity identity fragments under parallelism.** The optimistic arm produced **three** Elena entities; facts split across them, so no supersession could ever unify them.
- **Order leaks into truth.** Litmus (forward vs reverse ingest) fact-F1 was 0.18–0.38 — the reverse graph genuinely differs. Supersession is `valid_at`-based and order-sensitive when dates are missing; `chunk_index` is persisted but never used.
- **Causal edges dangle.** CAUSE runs per-chunk on pre-reconciliation ids; after merges/supersession those ids change → `expired_but_cited` contradictions and repointing debt.
- **Decision (recorded):** adopt **epoch (Approach A)**. Its weaknesses are deterministic and addressable; optimistic's strengths (order-stability, self-correction) it can get *deterministically and cheaply*, without optimistic's continuous-reconcile cost, operational fragility, and entity-dup. See the benchmark report §4–§7.

---

## 1. Core thesis

> **Agents propose, reconciliation disposes.**

The parallel extraction agents stop being authoritative writers to the canonical graph. They become **proposers** that write candidate entities/facts into a per-epoch **staging** buffer, working in clean isolation. A single deterministic **promotion** step is then the *authority* that resolves identity, orders by time/narration, enforces exclusive-group supersession, and writes the canonical graph — escalating only genuinely ambiguous judgements to an LLM. Causal reasoning is a **separate pass** over the settled canonical graph.

This inverts the current design's centre of gravity: correctness concentrates in one deterministic, testable, replayable place instead of being an emergent property of racing writers + a one-shot LLM cleanup.

---

## 2. Architecture overview

```
Phase 1  STORE           store each chunk (sourceId + chunkIndex), embeddings → Qdrant      [as today]
Phase 2  PROPOSE         parallel extraction agents → PROPOSALS into staging (ISOLATED)
                         workflow: ORIENT → EXTRACT → RELATE → VERIFY   (no CAUSE)
                         read: stable entity registry + own chunk + prior report + "chunk N/M"
Phase 3  PROMOTE         deterministic pure fn: (prior canonical + staged proposals) → new canonical
                         a. resolve proposed entities → canonical ids (dedup-once, full visibility)
                         b. rewrite fact refs to canonical ids
                         c. group-aware supersession in valid_at‖chunkIndex order
                         d. fact-triple dedup (P1) across the whole epoch
                         e. cleanup: self-loops, orphans, opposing_object
                         f. write canonical in ONE transaction + audit rows
                         g. escalate only ambiguous identity/contradiction → LLM arbiter
Phase 4  CAUSAL          SEPARATE pass over the SETTLED canonical graph (conditional, delta-scoped)
                         one informed agent reads canonical; proposes edges; causal-promotion validates
Phase 5  GARDEN          background cross-source structural pass                              [as today]
```

The boundary that triggers Phase 3 is the doc-34 Rule-2 DB-reactive event **"all chunks of this source proposed."** One promotion per source (see §12 open Q on granularity).

---

## 3. The staging model

Proposals are durable and queryable (staging tables or a `status='proposed'` flag — see §12). They carry everything promotion needs to resolve them, and **nothing** is written to canonical until promotion.

**ProposedEntity:** `{ handle (epoch-local id), name, type, summary?, anchorCanonicalId? }`
- `anchorCanonicalId` set when the agent matched a *known* entity in the registry (see §4, anchoring).

**ProposedFact:** `{ subjectHandle, predicate, objectHandle | objectValue, validAt | undated:true, chunkIndex, sourceId, confidence }`
- Entity refs are *handles*, not canonical ids — promotion resolves them after identity is settled.

Extraction proposers do **not** propose causal edges (CAUSE is Phase 4). Causal proposals are produced later, against canonical events.

---

## 4. Phase 2 — extraction proposers (parallel, isolated)

- **Workflow:** `ORIENT → EXTRACT → RELATE → VERIFY`. CAUSE is removed from the per-chunk agent (moved to Phase 4).
- **Read posture — isolated.** Each agent reads: the **stable entity registry** (canonical entity `name → {id, type}` as of epoch start), its own chunk, the prior extraction report (bead `nmemo-upn` continuity), and **its chunk position ("chunk N of M, narration order")**. It does **not** read the in-flight graph — and there is nothing in-flight to read, because canonical only changes at promotion. This kills read-skew by construction.
- **Anchoring (LOCKED):** agents **anchor known entities, propose unknowns.** If a referenced entity matches the registry, the agent anchors to that canonical id (`anchorCanonicalId`); otherwise it proposes a new named handle. This keeps the registry useful (no re-inventing "Helix") without exposing peers' in-flight state. New entities introduced by two peer chunks in the same epoch will still duplicate — promotion's deterministic merge absorbs that (cheap), which is the accepted trade.
- **Prompt enforcement (the ordering inputs):**
  - tell the agent it is "chunk N of M" (narration order);
  - require an explicit `valid_at` for every time-sensitive fact, or an explicit `undated` flag — no silent omission;
  - VERIFY-phase asks the agent to flag any fact it believes supersedes/▸is superseded by another (by attribute), as a hint to promotion;
  - assert exclusive attributes in a structured form where possible (subject, group-ish predicate, value, date) so promotion gets clean signals.
- **Writes:** proposals → staging only.

---

## 5. Phase 3 — promotion (the deterministic authority)

Promotion is a near-pure function `promote(priorCanonical, stagedProposals) → newCanonical`. Steps:

**(a) Entity resolution — dedup once, with full visibility.**
- Collect all proposed entities across the epoch. Deterministic clustering first: normalise `name`+`type`, merge obvious variants (title prefixes "Dr.", first-name-only, known aliases); anchored proposals inherit their `anchorCanonicalId`.
- Each cluster resolves to a canonical id: an existing one (anchor / exact registry match) or a freshly minted one.
- **Ambiguous clusters only** (e.g. "is *Elena* the same as *Dr. Elena Vasquez*?") escalate to the **identity arbiter** (LLM, §8). The arbiter sees only the candidate cluster + canonical neighbours — never the whole graph.
- Output: `handle → canonicalId` map. (This is where the "3 Elenas" problem dies — all proposals are visible at once, before any fact lands.)

**(b) Fact ref-rewrite.** Rewrite every proposed fact's `subjectHandle`/`objectHandle` to canonical ids using the map.

**(c) Group-aware supersession in time order (the order-independence core).** For each `(canonicalSubject, exclusiveGroup)`:
- collect member facts = prior canonical actives in that group **+** new proposals in that group;
- sort by `validAt`, falling back to `chunkIndex` for undated facts, then `confidence`, then a stable id tiebreak;
- keep the latest as active; expire the rest (`expired_at`, `expire_reason`, audit row).
- `exclusiveGroup = resolveExclusiveGroup(predicate)` from the **shared** ontology (§9) — the same map detection uses. **Ordering decision (LOCKED): `valid_at` wins**; a later chunk carrying an earlier date is normal narration, not suspect; `chunk_index` is fallback + tiebreak only.

**(d) Fact-triple dedup (P1).** `uniq_facts_active_triple` applied across the whole epoch's promoted set — deterministic, not racing at write time. Duplicate triples corroborate (bump observation), not duplicate.

**(e) Cleanup.** Drop post-merge self-loops; resolve `opposing_object` contradictions using the same time order; flag/prune orphan entities (no active fact, not a fresh arrival).

**(f) Promote.** Write resolved entities + facts to canonical in one transaction, each mutation paired with its `fact_history` / audit row (doc 12 contract).

**(g) Escalate residue.** Only genuinely ambiguous identity (→ arbiter) and genuine contradictions needing world knowledge go to the LLM. Everything mechanical is done in (a)–(e).

---

## 6. Phase 4 — causal pass (separate, post-promotion)

Causality (Graph C, doc 01) is built **over the settled Graph S**, as its own run:

- **When:** after promotion, **conditional** (doc 04 triggers — explicit causal language in the source, enough new facts, or existing causal history on the touched entities) and **delta-scoped** (the new/changed events + their neighbourhood, à la `getCausalDelta`), so it is bounded, not a full re-reason.
- **Read posture — reads canonical.** This is the *one* agent that should read the live canonical graph, precisely because it runs after promotion when the graph is clean and stable. Opposite posture from the isolated proposers — and correct for the job (causality is global, needs the coherent timeline).
- **Shape:** a single informed pass (not fanned-out) reasoning over the settled subgraph; it can now see cross-chunk causality ("Series B → HQ relocation") that per-chunk extraction never could.
- **Edges are proposals too.** The causal agent proposes `(causeEvent, effectEvent, reasoning, sourceReferences)` against **canonical** event ids (minted deterministically by promotion, so they are stable); a **causal-promotion** sub-step validates refs resolve, drops self-loops, and dedups. An edge whose cited fact *later changes* branches on the existing tag (`facts.ts:159`): **superseded** (a newer value landed in the group) → **keep** — the past event is still real, the timeline merely moved on; **invalidated** (was wrong / never true) → **flag `stale_citation`** for the next delta pass to re-ground or expire, **never auto-repoint** (a different fact may not support the same claim). Because edges are built on settled ids, the repointing / `expired_but_cited` problem is designed out.
- **Invariant preserved:** every edge keeps non-empty `reasoning` + `source_references` (doc 01).

---

## 7. Phase 5 — gardener (background)

Unchanged in spirit (doc 36): the slow, periodic, cross-source structural pass (island bridging, long-range dedup, summaries). It is the safety net *behind* promotion, not a substitute for it.

---

## 8. Agent roster + read postures

| agent | when | reads | writes |
|---|---|---|---|
| **extraction proposer** (graph_agent − CAUSE) | Phase 2, parallel | registry + own chunk + prior report + chunk N/M | proposals → staging |
| **promotion-escalation arbiter** (reconciliation_agent recast) | Phase 3 (a)/(g) | pushed dossier + live canonical (frozen during arbitration) | identity + conflict verdicts (§8a.5) |
| **causal agent** (CAUSE promoted to its own pass) | Phase 4 | canonical graph (settled), delta-scoped | causal proposals |
| **gardener** | background | cross-source structural | canonical (slow) |

**Note (LOCKED):** we are not adding a net-new agent. The causal "new run" is the existing CAUSE phase **split out** of the monolithic graph_agent; the identity arbiter is the existing `reconciliation_agent` recast as the **promotion-escalation seam** — cluster identity **and** exclusive-group conflict (§8a.5). Per-agent tool surfaces (what each may call, the new `propose_*`/verdict tools, return shapes) are specified in §8a.

---

## 8a. Tool surface — the propose/dispose tool model

The propose/promote split changes *what each agent is allowed to do*, not just what it is told to do. This section specifies the per-agent MCP tool surface that **enforces** the read/write postures in §8 — turning them into a property of the tool set rather than the prompt. It also answers the original "which tools are missing / what return data helps" question.

### 8a.1 Current state (the gap)

`GRAPH_TOOLS` (`causal-agent.ts:83`) defines ~42 tools (~24 read-only, ~18 mutating; each carries a `mutates` flag) served by the unified `graph-mcp.ts`. A per-actor seam already exists — the `Actor` type, `getMcpConfigPath(actor)`, `MNEMO_AGENT_ACTOR`, `VALID_ACTORS` — **but it does not scope tools**: every actor connects to the same server and receives the same full surface (`--allowedTools mcp__mnemo-graph__*`). The actor only sets the audit `actor` stamp and the system prompt. The `mutates` flag is wired to a write-**serialisation** queue (`WRITE_TOOLS`, `causal-agent.ts:1163`) — concurrency safety, not access control.

Consequence: an extraction proposer is *told by its prompt* to extract, yet technically holds `execute_merge` (destructive entity delete), `resolve_entity`, `create_fact` (supersession baked in), `expire_fact`, `invalidate_fact`. Nothing **structural** stops a proposer from rewriting canonical.

### 8a.2 Two structural moves

1. **Most write tools stop being agent-facing.** `create_fact`, `resolve_entity`, `execute_merge`, `create_same_as_link`, `expire_fact`, `invalidate_fact`, supersession and dedup become **promotion / disposal code** calling the service layer directly. Agents never call them. This is what makes order-independence partly a property of *what agents can't do* (§10).
2. **Per-actor allow-lists become the enforcement primitive** (§9.5). Each actor's MCP config / `--allowedTools` is built from an explicit `actor → tool[]` map derived from the tables below, on the existing `mutates` + `Actor` seam. A proposer cannot write canonical because the tool is absent from its config.

### 8a.3 Return-data principle

Today `create_fact` performs supersession **and** dedup as hidden side-effects and returns a bare fact id (`facts.ts:148–233`) — the agent never learns what it touched. Every epoch-v2 proposal tool inverts this: **its return previews what disposal will do and what the proposal touched**, scoped to what the agent is permitted to know (isolation-respecting). Opaque writes become guiding feedback, and the proposer's VERIFY phase gets the supersession hints promotion wants.

### 8a.4 Extraction proposer (Phase 2) — read registry, write staging

| tool | kind | in → out |
|---|---|---|
| `resolve_anchor` | read | `(mention, type?)` → `{ matched, canonicalId?, name?, type?, aliases?, confidence }` |
| `propose_entity` | stage | `{ name, type, summary?, anchorCanonicalId?, mentionText? }` → `{ handle }` |
| `propose_fact` | stage | `{ subjectHandle, predicate, objectHandle?\|objectValue?, validAt?\|undated, confidence, reasoning }` → `{ stagedFactId, exclusiveGroup, priorCanonicalActiveInGroup[] }` |

- `resolve_anchor` is one deterministic call against the **epoch-start registry snapshot** (§9.2), replacing the `search_similar_entities` + `search_entity_aliases` dance. Known → anchor; miss → propose new.
- `propose_entity` mints a **server-side, epoch-local handle** and returns it; anchored entities also go through it (carrying `anchorCanonicalId`) so `propose_fact` references handles uniformly and promotion gets one `handle → canonical` map (§5a). The agent never invents id strings — killing in-chunk "3 Elenas" fragmentation.
- `propose_fact`'s preview is **prior-canonical only** — never peer in-flight proposals — because isolation (§4) makes the full promotion outcome unknowable at propose time. Group + prior-canonical member is exactly enough for VERIFY to emit a supersession hint. `chunkIndex`/`sourceId` are injected by the harness, not the agent.
- **Loses** every canonical-write tool.

### 8a.5 Promotion-escalation arbiter (Phase 3) — read dossier + canonical, emit verdicts

Invoked **by promotion**, not as a self-driven patrol. Two escalation types (this broadens the arbiter beyond identity, per §12 #7):
- **identity** — a cluster deterministic merge couldn't settle ("is *Elena* the same as *Dr. Elena Vasquez*?");
- **conflict** — an exclusive-group collision `valid_at` ordering can't break (missing/equal/suspect dates).

Promotion **pushes a focused dossier** (the cluster/conflict + *why it escalated* + each member's key facts, aliases, source snippets); the agent starts informed and uses live reads only to go deeper. This inverts the old `get_reconciliation_context` "pull everything" entry point.

| tool | kind | note |
|---|---|---|
| `get_neighbourhood_profile`, `query_entity_facts`, `get_entity_sources`, `search_entity_aliases`, `get_fact_history`, `get_fact_source`, `get_memory_text`, `analyze_blast_radius` | read | "talk to the real graph" (§12 #4) |
| `propose_identity_verdict` | verdict | ← repurpose `resolve_candidate`, **decoupled from execution**: `{ members, decision: merge\|same_as\|distinct, canonicalTarget?, reasoning }`; one decision per call |
| `propose_conflict_resolution` | verdict | new: `{ subject, group, activeFactId, expire:[{factId, reason}], correctedValidAt?, notExclusive?, reasoning }` |

- **Loses to promotion code:** `execute_merge`, `create_same_as_link`, `resolve_contradiction` — the arbiter *decides*, promotion *executes*.
- **Subsumed:** `get_reconciliation_context` (replaced by the pushed dossier).
- **Replay (answers §12 #4):** reading live canonical does **not** fight replay, because promotion is the single writer and sources don't interleave (#8) ⇒ the graph is **frozen** during arbitration (prior canonical + the fixed staging set). The only nondeterminism is the LLM verdict, bounded by **recording the verdict against its dossier** — replay reuses the recorded decision.

### 8a.6 Causal agent (Phase 4) — read settled canonical, propose edges

| tool | kind | note |
|---|---|---|
| `get_causal_delta`, `trace_causes`, `project_trajectory`, `get_causal_history`, `find_causal_ghosts`, `get_active_patterns`, `get_pattern_instances`, `get_neighbourhood_profile`, `search_memories`, `get_memory_text`, `get_fact_source`, `get_fact_history` | read | `get_causal_delta` is the scope primitive; the rest gather `source_references` and check cited-fact status |
| `propose_causal_edge` | stage | `{ causeEventId, effectEventId, reasoning, source_references }` → `{ stagedEdgeId, refsResolve, citedFactStatus:[{factId, status: active\|superseded\|invalidated}] }`; revision/expiry also flow as proposals |

- **Disposed by causal-promotion (code):** ref-resolve, self-loop drop, dedup, and the cited-fact branch (§6, §12 #5) — **superseded → keep**, **invalidated → flag `stale_citation`**.
- Events are minted by **promotion** (stable ids), so the pass only ever sees settled events — no repointing debt.
- **Invariant:** every proposed edge carries non-empty `reasoning` + `source_references` (doc 01).

### 8a.7 Gardener (background)

Unchanged (§7). Keeps its structural/topology read+write set, operating slowly behind promotion — the safety net, not a substitute for it.

---

## 9. Enabling primitives

1. **Shared exclusive-group ontology.** Lift `resolveExclusiveGroup` + `AUGMENTATION_GROUPS` out of `graph-invariants.ts` into a shared module consumed by **both** detection (the invariant) *and* prevention (promotion supersession). "Exclusive" must mean the *group*, everywhere. This is the single highest-leverage change (closes the headline failure).
2. **The stable entity registry.** A cheap `name → {canonicalId, type}` view as of epoch start, given to proposers for anchoring.
3. **`chunkIndex` + `sourceId`** on every memory (already persisted) — the narration-order fallback and the promotion boundary key.
4. **P1 fact-triple uniqueness** — kept, but enforced at promotion across the epoch rather than racing per-write.
5. **Per-actor tool allow-lists.** An explicit `actor → tool[]` map (built on the existing `mutates` flag + `Actor` type) so each agent's MCP config exposes only its permitted surface (§8a). Read/write posture becomes structural, not prompt-enforced — and most write tools leave the agent surface entirely for promotion/disposal code.

---

## 10. Order-independence as a structural property (the payoff)

Promotion sorts each exclusive group by a **total order** — `(validAt, chunkIndex, confidence, idTiebreak)` — that is *independent of the order proposals arrived in*, then applies supersession on that order. Entity-resolution clustering operates on the full proposal set (commutative). Therefore:

> `promote(forward-order proposals) == promote(reverse-order proposals)`

i.e. the litmus test (doc 38's headline acceptance test) passes **by construction** for the deterministic backbone. The only residual run-to-run variance is the LLM layers — extraction phrasing (the "determinism floor" the harness already measures) and the identity arbiter on ambiguous merges — which the deterministic-first design minimises. We stop *chasing* order-independence and start *proving* it.

---

## 11. What this reuses / what it retires

**Reuses:** P1 uniqueness; `resolveExclusiveGroup`; `chunkIndex`/`sourceId`; the snapshot/rich-export infra (39); `reconciliation_agent` (recast); the CAUSE workflow (relocated); the gardener; the audit contract (12); the validity harness (39) as the regression gate.

**Retires / subsumes (the issues from 40):**
- **I1** (group supersession) — done by promotion (c) + the shared ontology (9.1).
- **I3** (entity dedup) — done once, centrally, at promotion (a).
- **I2** (ordering) — done deterministically at promotion (c); prompts feed it (§4).
- **I5** (deterministic-first barrier) — promotion *is* that.
- **I6 / P3** (FK CASCADE band-aid) — **moot**: canonical only mutates single-threaded at promotion, so no concurrent merge/delete races a live write. `filterLiveEntityIds` is deleted.
- **I7** (orphans) — promotion cleanup (e).
- **I8** (mid-run correction) — the arbiter + deterministic re-validation at promotion + the separate causal pass catch what the old one-shot barrier let through.
- **I4** (snapshot isolation) — achieved *for free*: isolation is structural under staging (nothing to read mid-epoch). No separate snapshot machinery needed.

---

## 12. Decision ledger

**Locked:**
- Strategy: **epoch (Approach A)**, not optimistic.
- Write model: **staging → promotion** (proposers write staging; promotion writes canonical).
- Tool surface is **propose/dispose** (§8a): agents propose into staging; deterministic code disposes. Most write tools stop being agent-facing; **per-actor allow-lists** (9.5) enforce read/write posture structurally, not by prompt.
- Agents **anchor known entities, propose unknowns**; handles are **server-minted** by `propose_entity` (anchored included), and `propose_fact` is **handle-only**.
- `reconciliation_agent` recast as the **promotion-escalation arbiter**: cluster identity **and** exclusive-group conflict, with scoped reads + a promotion-pushed dossier (§8a.5).
- Causal reasoning is a **separate, post-promotion, conditional, delta-scoped pass**; CAUSE removed from the per-chunk agent.
- Supersession ordering: **`valid_at` wins**, `chunk_index` is fallback + tiebreak; disagreement is not treated as suspect.
- Supersession operates on **exclusive groups**, via a shared ontology used by detection and prevention.
- Every proposal tool returns a **disposal preview** (what it will do / what it touched), isolation-scoped (§8a.3).

**Resolved (this revision):**
1. **Staging mechanism:** dedicated `staging_*` tables (not a `status` flag) — cleaner promotion + replay.
2. **Promotion granularity:** **one promotion per source.** Staging decouples *proposing* (many parallel epochs) from *promotion* (one, at the doc-34 Rule-2 "all chunks of this source proposed" boundary), so a large source can be proposed over multiple passes yet stays consistent for upstream agents — canonical only moves once. #8 (no interleaving) keeps the unit clean.
3. **Deterministic merge aggressiveness:** **conservative first** — route ambiguity to the arbiter; tighten the normalisation/alias rules during hardening.
4. **Identity arbiter contract:** promotion **pushes a focused dossier** (cluster/conflict + why + members' facts/aliases/sources); the arbiter also **queries live canonical** and **emits verdicts** via two tools (§8a.5). Nondeterminism is bounded by **recording the verdict against its dossier** — the graph is frozen during arbitration (single writer + #8), so reads are stable and replay reuses the recorded decision.
5. **Causal-promotion:** causal **events are minted deterministically by promotion** from settled fact mutations (stable ids) ⇒ no repointing debt. An edge whose cited fact later changes branches on the existing tag (`facts.ts:159`): **superseded** (newer value) → **keep** (the past event is still real); **invalidated** (was wrong) → **flag `stale_citation`** for the next delta pass to re-ground or expire — **never auto-repoint** (§6, §8a.6).
6. **Conditionality + delta scope (Phase 4):** trigger if (a) causal language in the promoted source(s) **or** (b) promoted-fact count ≥ N **or** (c) a touched entity already has causal history — evaluated on the **precise promotion delta**. Scope = derived events + the **K-hop causal neighbourhood** of touched entities, capped (§8a.6).
7. **`valid_at` trust:** `valid_at` is the **validity source of truth**; an exclusive-group conflict that ordering can't resolve **escalates to the arbiter** (the single promotion-escalation seam — this broadens it beyond identity, per §8a.5).
8. **Cross-source / interleaved ingestion:** **do not interleave sources** — epochs and promotions are per-source.
9. **Failure / partial promotion:** promotion is deterministic ⇒ a failed promotion is **safe to retry/replay**; recovery is guided by **informative tool returns** (the §8a.3 return-data principle) rather than hidden state.

**Open:**
10. **Migration path** from the current `runEpochBatch` — incremental; see §13.

---

## 13. Suggested build sequence (rough)

Each step is harness-gated (39) and ordered for incremental value, keeping `runEpochBatch` working throughout.

1. **Shared exclusive-group ontology + group-aware supersession** (9.1 + promotion step c). Highest leverage; testable against the validity harness immediately; helps *all* arms even before staging lands. Also produces the `exclusiveGroup` that `propose_fact` returns (§8a.4).
2. **Staging tables + the propose tool surface** (§8a.4): `staging_*` tables, `propose_entity` / `propose_fact` / `resolve_anchor`, the epoch-start registry snapshot (9.2), and **per-actor tool allow-lists** (9.5) so the proposer loses canonical writes.
3. **The promotion pure function** (§5): entity resolution (dedup-once + arbiter seam) → fact ref-rewrite → group-aware supersession → triple dedup → cleanup → one-transaction write + audit. Wire `runEpochBatch` to propose→promote at the "all chunks proposed" boundary.
4. **`chunk_index` ordering** in promotion + the Phase-2 prompt enforcement (§4).
5. **Arbiter recast** (§8a.5): the promotion-pushed dossier, `propose_identity_verdict` (← `resolve_candidate`, decoupled) + `propose_conflict_resolution`; move `execute_merge` / `create_same_as_link` into promotion code.
6. **Causal pass split-out** (Phase 4, §8a.6): promotion-minted events, `propose_causal_edge`, causal-promotion (refs / self-loops / dedup + superseded-keep / invalidated-flag), the conditional trigger + delta scope.
7. **Retire** `filterLiveEntityIds`; delete the per-chunk CAUSE path; fold orphan/self-loop cleanup into promotion; remove the remaining canonical-write tools from agent surfaces.
8. Re-run the validity harness per step; the litmus metric should climb toward order-independence as (1)+(3)+(4) land.

---

## 14. References

- **Docs:** [01 dual-graph](01-dual-graph-architecture.md) · [04 sparse-branch / conditional causal agent](04-sparse-branch-design.md) · [07 graph-agent 5-phase workflow](07-graph-agent-workflow.md) · [12 audit trail](12-audit-trail-foundation.md) · [34 architectural principles (Rule 2 DB-reactive cadence)](34-architectural-principles.md) · [35 reconciliation agent](35-reconciliation-agent.md) · [36 gardener](36-gardener-agent.md) · [38 parallel ingestion (Approach A, P1/P2/P3, litmus)](38-parallel-ingestion.md) · [39 validity harness](39-graph-validity-harness.md) · [40 epoch hardening issues](40-epoch-hardening.md).
- **Benchmark evidence:** [parallel-ingestion 2026-06-09](../../benchmarks/results/parallel-ingestion-2026-06-09.md).
- **Code anchors:** `pipeline.ts` (`runEpochBatch`, `filterLiveEntityIds:508`, `runSerialBatch`/`runOptimisticBatch`) · `facts.ts` (`createFact:148`, `findSupersedingFacts:401` — exact-predicate match to replace) · `graph-invariants.ts` (`resolveExclusiveGroup:55`, `AUGMENTATION_GROUPS:35` — lift to shared) · `predicate-ontology.ts` (`normalizePredicate`, `getPredicateInfo`) · `causal-agent.ts` (`invokeGraphAgent`, the CAUSE path to relocate) · `services/batch.ts` (`prepareBatch`).
- **Beads:** `nmemo-bsb` (supersession), `nmemo-wyb` (entity dup), `nmemo-3bp` (FK violations / retired by staging).

---

## 15. Continuation note (fresh context)

The architecture is agreed at the level above. To resume: pick up the **Open** decisions in §12 (start with staging mechanism #1 and causal-promotion #5, the two with the most unresolved shape), or begin building at §13 step 1 (shared exclusive-group ontology + group-aware supersession), which is independently valuable and the fastest path to moving the litmus metric. The validity harness (39) is the regression gate for every step. Planning was done with services running in a separate session — coordinate before any live runs.
