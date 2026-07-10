# Substrate Readiness & Pre-Conditions — Phase 0

**Status:** Phase 0. Must reach the §3 exit criteria before Phase A of `04-hardened-spec.md` lands schema. Product of the readiness findings surfaced by the three-adversary feature review, plus a *planned* dedicated audit (PC-8) to catch what a feature-scoped review could not.

**Why a Phase 0.** The review validated the reusable core (propose→promote, causal-edge pattern, actor allowlist, ingest ledger) — but it also surfaced substrate gaps (a fragile graph layer, migration drift, a bifurcated write discipline, two latent bugs, a security gap). And it was **feature-scoped**: it only looked at the subsystems cross-corpus touches. So Phase 0 does two things — **remediate the known gaps** and **discover the unknown ones** — so we build on ground that is both solid *and* known.

**Key scheduling insight:** the E1 recall gate (`04` Step 0) is a schema-less script against Ollama with **no substrate dependency** — so it runs **in parallel** with Phase 0, not after it. Don't serialize the flagship bet behind substrate cleanup.

---

## 1. Readiness register

Severity: **Blocker** (Phase A can't safely start until addressed) · **Should-fix** (real defect; fix before the phase that depends on it) · **Hygiene** (cleanliness, no correctness impact). Gate = when it must be handled.

| ID | Item | Evidence (current code) | Severity | Gate | Remediation | Verified when |
|----|------|------------------------|----------|------|-------------|---------------|
| **PC-1** | Migration drift — live DB can lag repo (no journal, not run on boot) | `migrate.ts` (no journal); `to_regclass` self-ensure; migrate-drift incident | **Blocker** | Before A | Pre-flight: run `db:migrate`, confirm live == repo. Optional root-cause: add a journal table + boot check. | Live schema matches repo; migration list reconciled |
| **PC-2a** | AGE can silently fail to sync (bare-catch WARNING); live AGE may be broken now | `001` sync trigger bare-catch; migrate-drift (`localtimestamp` incident) | **Blocker (verify)** | Before A | Confirm AGE is populating on the live DB; if broken, apply the surgical fix or accept-and-route-around (feature already does, D2). | Cypher node count climbs on ingest; **no `localtimestamp` warnings** in the platform log |
| **PC-2b** | AGE sync fails *invisibly* (should fail loud); edge-`SET` silently dropped | `001:434-437` bare-catch; `001:444-447` | Should-fix | Anytime | Make the sync trigger fail loud (or emit a health metric) instead of a swallowed WARNING; document the edge-`SET` limitation. | A forced sync failure surfaces as an error/metric, not a silent no-op |
| **PC-2c** | Graph-anchored fallback recall returns `[]` silently when AGE unsynced | `graph.ts:270-273`; `graph-fallback.ts:189` | Should-fix | Anytime | Distinguish "no neighbours" from "AGE unavailable"; log/metric the latter. | Unsynced-AGE fallback emits a warning/metric, not a bare `[]` |
| **PC-3** | Corroboration count inflates on epoch-replay — breaches order-independence; **test only checks row-set** | `causal.ts:254-256`; idempotency test asserts row-set only | **Blocker** | **Before A** | Scope corroboration to `invocation_id`/staged-row identity (mig-034 UPSERT model); add a **count-stability** regression test. *Elevated to Blocker because Phase A clones corroborate-or-insert into `bridge_edges` — fix the pattern before copying it.* | Double-dispatch of the same staging leaves `corroboration_count` unchanged; new test green |
| **PC-4** | Client-supplied `actor` — validated, not route-pinned (anti-spoof gap) | `pi-agent-bridge.ts:137,168,175` | Should-fix | Before B | Route-derive/pin the actor server-side; reject a body `actor`. (No new route in Phase A, so not an A-blocker — but a live gap.) | A spoofed body `actor` is rejected/ignored; route value wins |
| **PC-5** | Word-prefix single-match auto-bind, no embedding gate, silent | `promotion-plan.ts:416-427` | Should-fix | **In A** | **Addressed by D5** — the `assimilating\|comparative` preset (comparative escalates to the arbiter). Not a separate pre-condition; it's fusion-guard #2. | Covered by the Phase-A word-prefix test (`04` §5.7) |
| **PC-6** | Two write disciplines — legacy `extract()` passes write canonical directly on run-count triggers vs the clean epoch propose→promote | `pipeline.ts` extract() gardener/decay/contradictions | Hygiene (coherence) | Decision now, refactor deferred | **Record a disposition**: leave-as-legacy (documented) vs migrate-to-staging later. Feature doesn't touch them; don't refactor in Phase 0. | Disposition recorded; no silent expectation that they share the clean discipline |
| **PC-7** | Dead code / inert schema | dead `mcp-server/` (`.mcp.json.disabled`, 404s); `inverse_predicate` inert; dead `event_embedding`/`pattern_embedding` columns | Hygiene | Anytime | Retire dead endpoints/tools — **keep the transport shell** (Phase B reuses it) and **keep `inverse_predicate`** (Phase B wires it, D-B2). Document or drop the dead embedding columns. | Dead paths removed or explicitly annotated "future-wired"; nothing needed later is deleted |
| **PC-8** | Unknown-unknowns beyond the feature blast radius | (not yet looked) | **Discovery** | **Step 0** | Run the dedicated readiness audit (§4); fold findings into this register before finalizing exit criteria. | Audit complete; new blockers remediated or explicitly accepted |

---

## 2. Sequencing

```
Step 0 (discovery)          PC-8 readiness audit  ── extends this register with beyond-blast-radius items
   │                        (runs in parallel with E1 — neither blocks the other)
   ▼
Hard pre-conditions         PC-1 migration-state verify  ┐
(parallelizable)            PC-2a AGE health verify      ├─ independent; do together
                            PC-3 corroboration fix+test  ┘  (PC-3 is the only code change among them)
   │
   ▼
Record dispositions         PC-4 (timing), PC-6 (bifurcation), PC-7 (hygiene scope)
   │
   ▼
EXIT (§3) ⇒ Phase A may land schema.   Meanwhile: E1 recall gate runs in parallel throughout.
Should-fix items (PC-2b/2c, PC-4) land before the phase that depends on them, not necessarily in Phase 0.
```

The only *code change* gating Phase A is **PC-3** (the corroboration fix) — because Phase A clones that pattern. PC-1/PC-2a are **verification**, not code. Everything else is discovery, decision, or deferrable.

---

## 3. Exit criteria (Phase 0 done ⇒ Phase A may start)

A concrete, checkable list (per the "verify, don't assume" discipline):

1. **PC-8 audit complete** — every new Blocker it finds is either remediated or explicitly accepted-and-recorded here.
2. **PC-1** — live DB migration state reconciled with the repo (run `db:migrate`; confirm no unapplied migrations).
3. **PC-2a** — AGE verified populating on the live DB (`SELECT count(*) FROM cypher('knowledge_graph', …)` climbs on ingest; **zero `localtimestamp` warnings**) — *or* AGE explicitly accepted as broken with the feature's route-around (D2) confirmed sufficient.
4. **PC-3** — corroboration replay bug fixed; the count-stability regression test is green. (Pre-req to cloning corroborate-or-insert into `bridge_edges`.)
5. **Dispositions recorded** for PC-4 (actor-pin timing), PC-6 (bifurcation), PC-7 (hygiene scope) — decided, not left implicit.

When 1–5 hold, the ground is solid *and* known, and Phase A schema (`04` §2 Step 1) may land. E1 (`04` Step 0) will typically have run in parallel and may already have passed or killed the whole thing first.

---

## 4. The readiness audit (PC-8) — scope

A **read-only** fan-out, distinct from the feature review, over the parts we have *not* looked at. Each slice returns: findings, severity, evidence (file:line), and whether it blocks Phase A — folded into §1.

- **Test-coverage breadth** — where are the gaps (like the corroboration test that checked row-set but not count)? Which invariants are asserted vs assumed?
- **Silent-failure patterns** — other bare-catch / swallowed-error sites like the AGE sync and the fallback `[]` (grep the pattern; these are the dangerous class).
- **Error handling & write-path integrity** beyond promote()/causal — the legacy `extract()` passes, reconciliation, decay.
- **ML-services (Python) health** — the `:8000` service, provider config fragility (the `LLM_PROVIDER` shell-override trap), the bounded pool.
- **Dependency & schema hygiene** — other declared-but-inert schema, migration ordering assumptions, the `search_path`/AGE gotchas.
- **Viz / API surface** — dead endpoints (like the mcp-server's), `/api/reset` not clearing AGE (orphan accumulation).

Output: this register, extended. Only *then* is "addressing everything" honest.

---

## 5. Dispositions to record (not code, but decisions)

- **PC-4 (actor-pin):** do now (it's a live security gap) vs bundle with the Phase-B MCP route. Recommend: bundle with Phase B (no new route until then), but note it as a known live gap meanwhile.
- **PC-6 (bifurcated write discipline):** migrate the legacy `extract()` passes to staging/promote *later* vs leave them documented as legacy. Recommend: leave-as-legacy for now, documented; revisit when the pass registry (Phase B) makes migration cheap.
- **PC-7 (dead code):** how aggressively to prune. Recommend: retire the dead mcp-server *endpoints/tools* but keep its transport shell and `inverse_predicate` (both future-wired); annotate the dead embedding columns.

---

## 6. Phase 0 execution log (2026-07-09) — dispositions decided, exit status

**Exit-criteria status:**

1. **PC-8 audit complete** — ✅ done (`pc8-readiness-audit.md`, 2026-07-08). No new **Blocker**; the Should-fix/hygiene findings are now folded into the register below and filed as beads (not Phase-A blockers).
2. **PC-1 (migration state == repo)** — ✅ verified (bead `nmemo-uhp.2`). `db:migrate` reaches "All migrations processed", exit 0; all 50 migration objects present live == repo. Hygiene finding (3 non-idempotent migrations 028/040/046 that ERROR on re-run) filed as **`nmemo-ved`** (P3) — does not block A (migrate.ts continues past per-file errors), but guard before Phase A adds a migration.
3. **PC-2a (AGE sync health)** — ✅ localtimestamp-clean (mig 048 applied; the migrate-drift failure mode is fixed) and AGE populates (1067 nodes). Orphan accumulation confirmed (reset never clears AGE → `nmemo-du2`). Live-ingest climb observation: see bead `nmemo-uhp.3`.
4. **PC-3 (corroboration replay-count)** — ✅ **fixed + verified** (bead `nmemo-uhp.4`, closed). `causal_edge_corroborations` ledger (migration 051, the mig-034 UPSERT model) makes corroborate-or-insert replay-idempotent; 5/5 count-stability regression tests green. This is the pattern Phase A clones into `bridge_edges`.
5. **Dispositions** — decided below.

**PC-8 Should-fix/hygiene findings folded into the register (all beaded, none block Phase A):**

| Finding | Bead | Severity | Note |
|---------|------|----------|------|
| PC8-1 — `embed()` swallows ML failure → NULL-embedding entity | `nmemo-avd` | Should-fix | On the corpus-scoped promote path A extends; E1 recall needs embeddings present. Fix with/before A. |
| PC8-2 — `/api/reset` leaves AGE + staging + audit tables uncleared | `nmemo-du2` | Should-fix | Phase A must extend the cleared-table set (or re-derive reset from a schema registry). |
| PC8-3 — `LLM_PROVIDER` unknown → silent Claude fallback; TS/Python default drift | `nmemo-gnt` | Should-fix | General robustness, not A-blocking. |
| PC8-4 — dead `event_embedding`/`pattern_embedding` columns carry live HNSW indexes | `nmemo-x8b` | Hygiene | Write-amplification; drop or annotate. |
| PC8-6 — no test asserts a minted entity carries an embedding | folded into `nmemo-avd` | Should-fix | The causal count-stability half of PC8-6 is now covered by PC-3. |

### Dispositions decided (§5, 2026-07-09)

- **PC-4 (actor-pin timing):** **DEFER to Phase B**, bundled with the MCP route + actor-pin work (Phase B epic `nmemo-uhp.12`). No new external route ships in the hand-seeded Phase A, so the client-supplied-`actor` gap is not reachable by a new surface in A. Recorded as a known live gap meanwhile; related test resync `nmemo-p0t`.
- **PC-6 (bifurcated write discipline):** **LEAVE-AS-LEGACY, documented.** PC8-7 confirmed the legacy `extract()` passes are logged (`console.warn`), not silently wrong. Revisit when the Phase-B pass registry makes migration to staging/promote cheap. Phase A does not touch them.
- **PC-7 (dead-code scope):** retire dead `mcp-server/` endpoints/tools but **keep the transport shell** (Phase B reuses it). **CORRECTION (PC8-5): `inverse_predicate` is LIVE, not inert** — read/written across the predicate path (`predicate-resolve.ts:39`, `predicates.ts:52,66`, mig 045, its own test) — so it stays because it is *in use*, not merely future-wired; do not remove. Dead embedding columns tracked in `nmemo-x8b`; `mcp-server/` dead-but-retained (annotate, PC8-8).

## Appendix — where Phase 0 sits

```
Phase 0 (this doc): substrate readiness ─┐
                                          ├─ then ─►  Phase A (04 §2): corpus_id + guards + bridge_edges family (hand-seeded)
E1 recall gate (04 Step 0): in parallel ─┘            Phase B: registry + edge-rule vocab + MCP + coverage
                                                      Phase C: external code graph + consistency model (Q12/Q13)
```

Phase 0 is the smallest amount of substrate work that makes Phase A safe — verification, one bug fix, and a discovery pass — not a general cleanup project. The bifurcation and dead-code items are explicitly *not* remediated here; they are recorded and deferred so Phase 0 stays bounded.
