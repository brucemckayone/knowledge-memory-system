# Hardened Spec — the converged plan we build from

**Status:** The spec of record. Supersedes the *decision-level* content of `00`–`03` (those remain as the investigation trail and full component detail). Product of a three-adversary review (endpoint-identity, scope/over-engineering, mechanism-correctness) of `03-detailed-plan.md`, 2026-07-06. Every "exists today" cite is current against `feat/cognitive-platform-v2`. Still nothing built.

**What changed in review (bad choices removed, including my own):**
- The "anchored entity" endpoint idea was **refuted and dropped** — it re-introduced the exact fusion hazard `00` V.2 designed away.
- "Remove the word-prefix bind globally" was **refuted and dropped** — it contradicted the pure-planner contract and would regress genuine coreference.
- Phase A was **cut hard** — most of it was building machinery for a code graph and a sweep that don't exist yet.
- Two **pre-existing code bugs** surfaced (not this feature) — logged in §8.

---

## 1. The register, closed

| # | Decision (hardened) | Why / what the review killed |
|---|---------------------|------------------------------|
| **D1** (Q1/Q2 endpoint identity) | `element_ref = uuidV5(scheme\|corpus\|symbol)` — **keep**. Code/rule elements are **bare catalog rows** (`code_elements`, `rule_elements`), **never `entities`**. `bridge_edges` endpoints are polymorphic UUIDs (`a_kind`/`a_ref`) validated at disposal against the catalogs. Behaviour/rule embeddings live in a **dedicated embedded table** the parser fills eagerly; E1 runs an explicit cross-corpus query over *that*. | The deterministic id genuinely dissolves the TEXT-vs-UUID fork. But making elements *entities* (my proposal) re-opened six within-corpus fusion paths and forced an eager-scale-vs-lazy-no-recall contradiction. Bare catalogs = **zero fusion surface by construction** and a clean resolution pool. Satisfies IX.1 (FK-able-in-spirit) *and* V.2 (no fusion surface) at once. |
| **D2** (A2 AGE) | **Ratify, verdict-scoped:** no *fusion or verdict* decision is ever sourced from an AGE traversal; Postgres is the sole source of truth; bridges do not sync to AGE in v1. | Verified: resolution and contradiction read Postgres; causal traversal is recursive-CTE — none read Cypher. **Caveat kept:** graph-anchored *recall* fallback does walk AGE and fails silently on unsynced data — so AGE-sync health stays a gate item (§8 issue 2). |
| **D3** (A3 derived state) | Query-time default for inverse / symmetric / single-hop composition / carry-forward. **Guards:** `fanout_cap` NON-NULL with a low default; low `max_depth` for any `is_transitive` relation over an unweighted store; **recursive composition forbidden at query time** (single-hop only; deeper chains materialize behind a maintainer). | A3's named derivations are all cheap (O(1) swaps / single joins). The perf cliff is the *transitive walker* on the dense fact graph, not A3. (Whole item is in deferred B2 anyway.) |
| **D4** (Q5 inter-pass) | Passes commit **independently**, communicate via **committed reads** (no shared tx). Every `dispose` must be replay-idempotent **including aggregates** — scope corroboration to `invocation_id`/staged-row identity (the mig-034 UPSERT model). A downstream pass **may not** make a deterministic decision off a prior pass's mutable aggregate (count/strength). | The sequential-visible contract is mechanically real, but the current corroborate-on-replay bumps `corroboration_count` every re-dispatch (§8 issue 1), which would make a cross-pass read replay-unstable. (Registry deferred; contract binds when a 2nd pass lands.) |
| **D5** (Q7 word-prefix) | **Adopt A4 verbatim.** `assimilating` corpora keep the rule-3 single-match bind; `comparative` corpora replace **only** that branch (`promotion-plan.ts:424-427`) with **arbiter escalation** — never an embedding gate, never touching `isWordPrefix`/rule-4. | My "remove globally" was wrong three ways: an embedding gate is illegal in the pure/DB-free planner (breaks the order-independence litmus); the line refs also power rule-4 fresh-cluster folding; global removal regresses genuine short-form→full-name coreference. |
| **D6** (Q10 no_violation) | **Fork by provenance, not blanket.** Sweep-level "checked, nothing worth keeping" → coverage-only. **LLM-reasoned `satisfies`** (carries reasoning + evidence) → emit a `satisfies` bridge row **and** stamp the coverage cell (`edge_id` set). Add a `not_applicable` coverage bin so the "satisfied nowhere" anti-join is single-table. | Coverage-only would discard the reasoning/evidence for exactly the verdict the regulated-evidence framing promised to retain, and the anti-join can't run over coverage alone (no N/A bin there). (Coverage is deferred; decision stands for when it lands.) |
| **D7** (Q6 exclusivity) | Model exclusivity as `exclusive_group_id` (not a bool); preserve `AUGMENTATION_GROUPS`. | The one fully-wired rule folds many predicates into one group; a bool regresses supersession. (In deferred B2.) |
| **D8** (Q11 carry-forward) | Query-time JOIN across runs; no verdict copying. | Consistent with D3; avoids detachment if an `element_ref` ever moves. (Coverage deferred.) |
| **D9** (corpus immutability) | The composite-FK backstop is correct (incl. `MATCH SIMPLE` on nullable `object_entity_id`). **Add** a BEFORE-UPDATE trigger rejecting any change to `facts.corpus_id` / `entities.corpus_id`. | Closes the one silent bypass: a bulk `UPDATE … SET subject_entity_id=X, corpus_id=<X's corpus>` satisfies the FK and skips `entity_merges`, migrating a fact across corpora. |
| **D10** (Q12/Q13) | **Genuinely open, deferred to Phase C, behind the empirical gate.** Working assumption: anchored-snapshot consistency (a bridge is "true as-of `(commit, model_version, valid-time)`"). SCIP-symbol stability across real file moves is a **new empirical bet**, a sibling to E1. | Not needed for v1 (stub resolver + hand-seeded refs). The only items that remain Open — and correctly so. |

**Result:** of the 15 register questions, **13 are resolved**; the 2 that remain open (Q12, Q13) are Phase-C empirical bets that do not block v1.

---

## 2. v1 scope — the minimal clean core

The discipline: **build nothing before it is needed, and validate the flagship bet before building any schema.**

### Step 0 — the E1 gate, schema-less
Run E1 as a **throwaway recall script** (verbalize code-behaviour → embed via Ollama; embed rule text; cross-corpus search; measure recall@5 on ≥50 hand labels). Bar: **≥0.65 recall@5**. Plus the **AGE-sync-health check** and the **`printf` fusion demo** (below). *No schema is written until E1 clears* — building on the unvalidated bet the whole design gates on is the one thing not to do. Also settle **D1/D2** on paper before any migration (irreversible once data exists).

### Step 1 — the thin schema (only if E1 clears)
**IN:**
- `corpus_id TEXT NOT NULL DEFAULT 'default'` on `entities` / `facts` / `causal_events`; the **four fusion guards** (scoped resolution candidate set; word-prefix per D5; gardener same-corpus; contradiction self-join — falls out free); the **composite-FK backstop** + the **corpus-immutability trigger** (D9).
- The **`assimilating | comparative` corpus policy preset** — the honest home for the word-prefix (D5) and contradiction-stance knobs, not `if (corpus)` branches.
- The **reduced `bridge_edges` family**: `bridge_edges` + `staging_bridge_edges` + `bridge_source_refs` + pure `planBridgePromotion` + `applyBridgePromotion`, reusing the causal-edge shape (NOT-NULL reasoning/refs, partial-unique dedup, `stale_citation`, corroborate-or-insert). `relation` is a **CHECK enum**. Anchor columns (`source_commit`, `source_ast_hash`, `model_version`, `rule_set_hash`) present but **dormant**. Endpoints polymorphic UUID, validated against the catalogs.
- **`element_ref = uuidV5(...)`** derivation + the sparse `code_elements` / `rule_elements` catalogs + the **dedicated embedding table** (parser-populated for the corpus being audited, so E1 recall has something to search).

**OUT of v1 — deferred, with the reason it's safe to defer:**
- `audit_runs` / `audit_coverage` and the sweep — nothing writes them until an MCP-driven run exists; the round-trip and demo don't sweep.
- `checker_unavailable` bin — vacuous with no checker until Phase C.
- The **~8 MCP tools + routes + 3 teaching primitives + actor-pin** — no external agent in a hand-seeded v1 (the actor-pin is a real fix, but only when a route ships).
- **SARIF importer** — hand-seed `staging_bridge_edges` directly; the importer's real input (CodeQL) is Phase C.
- **B6 staleness / reconcile / `onCodeChange` / stub resolver** — machinery for a code graph that doesn't exist yet; v1's "expire" is fact-side, which `cascadeFactExpiry` already does.
- **`graph_stats` PK surgery + per-corpus HDBSCAN / adaptive-weight recompute** — only bites with two live corpora at scale; the demo needs the guards, not reclustering.
- **B1 pass registry** — you extract it cleanly from *two* real passes; today there is one. The audit path is user-triggered and MCP-driven (reusing epoch→promote directly), so it isn't even shaped like a post-promotion pass.
- **B2 edge-rule vocabulary / generic walker / composition** — a bridge is a point assertion; nothing in the use case needs transitivity/inverse/composition.

### Does deferring B1/B2 damage the vision? No.
Both are *generalizations of working code* (causal pass → registry; causal chains → walker). Generalizing from one instance is guessing the abstraction; the disciplined path lands the *second* concrete instance (the audit pass, hardcoded; the bridge edge, an enum) and extracts B1/B2 from two real examples. v1 **keeps every seam** — the audit pass reuses the actor/allow-list/staging-only/`promote()` discipline, and `bridge_edges` reuses the causal-edge row shape — so the later extraction is a clean lift, not a rewrite. The vision (fixed core + two composition boundaries + plugin model) is intact; only its *code* is phased.

---

## 3. v1 data model (hardened DDL)

```sql
-- corpus scoping (instance tables only; fact_predicates/entity_types stay global)
ALTER TABLE public.entities      ADD COLUMN corpus_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE public.facts         ADD COLUMN corpus_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE public.causal_events ADD COLUMN corpus_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE public.entities ADD CONSTRAINT entities_id_corpus_uq UNIQUE (id, corpus_id);
ALTER TABLE public.facts
  ADD FOREIGN KEY (subject_entity_id, corpus_id) REFERENCES public.entities(id,corpus_id),          -- MATCH SIMPLE
  ADD FOREIGN KEY (object_entity_id,  corpus_id) REFERENCES public.entities(id,corpus_id);           -- nullable ⇒ skipped
-- D9: corpus is immutable
CREATE TRIGGER trg_corpus_immutable BEFORE UPDATE ON public.facts    ... RAISE IF NEW.corpus_id <> OLD.corpus_id;
CREATE TRIGGER trg_corpus_immutable BEFORE UPDATE ON public.entities ... RAISE IF NEW.corpus_id <> OLD.corpus_id;

-- element catalogs (bare rows, NOT entities → zero fusion surface)  [D1]
CREATE TABLE public.code_elements (
  element_ref UUID PRIMARY KEY,               -- uuidV5(scheme|corpus|canonical_symbol)
  corpus_id TEXT NOT NULL, scheme VARCHAR(8), canonical_symbol TEXT NOT NULL,
  source_commit VARCHAR(40), content_hash VARCHAR(64), file_path TEXT, line_start INT, line_end INT,
  status VARCHAR(12) NOT NULL DEFAULT 'live', UNIQUE (corpus_id, scheme, canonical_symbol));
CREATE TABLE public.rule_elements (            -- same shape for the standard corpus
  element_ref UUID PRIMARY KEY, corpus_id TEXT NOT NULL, rule_id TEXT NOT NULL, rule_set_hash TEXT,
  UNIQUE (corpus_id, rule_id));

-- dedicated embedding table for E1 recall (parser-populated, NOT in entities.embedding)  [D1]
CREATE TABLE public.element_embeddings (
  element_ref UUID PRIMARY KEY, corpus_id TEXT NOT NULL,
  kind VARCHAR(12) NOT NULL,                   -- 'behaviour' | 'rule_text'
  text TEXT NOT NULL, embedding vector(768));  -- HNSW index; E1 = explicit cross-corpus query over THIS

-- bridge_edges (polymorphic UUID endpoints; causal-edge shape reused)  [D1]
CREATE TABLE public.bridge_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  a_kind VARCHAR(12) NOT NULL, a_ref UUID NOT NULL,     -- validated at disposal vs the catalogs
  b_kind VARCHAR(12) NOT NULL, b_ref UUID NOT NULL,
  source_corpus_id TEXT NOT NULL, target_corpus_id TEXT NOT NULL,
  relation VARCHAR(16) NOT NULL CHECK (relation IN ('violates','satisfies','not_applicable')),
  severity VARCHAR(16), category VARCHAR(64), code_location JSONB,
  source_commit TEXT, source_ast_hash TEXT, rule_set_hash TEXT, model_version TEXT,  -- dormant in v1
  reasoning TEXT NOT NULL, source_references JSONB NOT NULL,                          -- invariant
  corroboration_count INT NOT NULL DEFAULT 1, strength FLOAT NOT NULL DEFAULT 0.5,
  stale_citation BOOL NOT NULL DEFAULT false, stale_reason TEXT,
  expired_at TIMESTAMPTZ, expire_reason TEXT, invocation_id UUID, created_at TIMESTAMPTZ DEFAULT now());
CREATE UNIQUE INDEX ON public.bridge_edges (a_ref, b_ref, relation) WHERE expired_at IS NULL;
-- staging_bridge_edges: no FK, structural CHECKs (reasoning non-empty, refs array len>=1)  [mirror 044]
-- bridge_source_refs: clone of edge_source_refs, ref_type widened to include 'code_element'
```

---

## 4. v1 interfaces (hardened pseudocode)

```
resolveElementRef(node):                                   # D1 — pure, no DB, hand-seedable
  canonical = node.scipSymbol ?? astContentHash(node); scheme = node.scipSymbol ? 'scip':'ast'
  return uuidV5(CODE_ELEMENT_NS, `${scheme}|${node.corpusId}|${canonical}`)

# the four fusion guards (D5 for #2)
findSimilarEntities(emb, {..., corpusId}):  ... WHERE ... AND e.corpus_id = $corpusId   # 1 resolution
loadPromotionInputs(staged, corpusId):      priors WHERE ... AND corpus_id = $corpusId    # 2 word-prefix inputs
  # D5: comparative ⇒ rule-3 single-match branch escalates to arbiter (never embedding gate; never touch rule-4)
detectMergeCandidates(ids, corpusId):       eligibles WHERE e.corpus_id = $corpusId       # 3 gardener
detectOpposingObjects(corpusId):            ... AND f1.corpus_id = f2.corpus_id           # 4 contradiction (free)

planBridgePromotion(prior, staged, verdicts) -> {create, corroborate, drop}:   # pure, mirrors planCausalPromotion
  for e in staged:
    if !catalogHas(e.a_ref) or !catalogHas(e.b_ref): drop('unresolved endpoint'); continue   # D1: validate vs catalogs
    stale = anyCitedFactInvalidated(e)                                                        # flag, never repoint
    p = priorByKey[(e.a_ref, e.b_ref, e.relation)]
    p ? corroborate.push(...) : create.push({...e, staleCitation: stale})
applyBridgePromotion(runId):   # D4: corroboration keyed on invocation_id/staged identity ⇒ replay-idempotent incl. counts
```

---

## 5. v1 acceptance tests (verifiable)

1. **E1 gate:** recall@5 ≥ 0.65 on ≥50 hand-labelled code-element × undecidable-rule pairs (cross-corpus query over `element_embeddings`). Smoke ~12 first; <0.3 = cheap disproof, stop.
2. **AGE-sync health:** node count climbs on ingest; no `localtimestamp` warnings.
3. **`printf` fusion demo:** seed `printf` in corpus A and corpus B with context embeddings forced >0.92; assert **distinct ids at all four guards**; assert two *same-corpus* `printf` mentions still fuse (regression); assert the composite FK rejects a bypassed cross-corpus `merge_candidates` insert (23503) and the immutability trigger (D9) rejects a `corpus_id` bulk update.
4. **Bridge round-trip (no external tooling):** hand-seed `staging_bridge_edges` → `applyBridgePromotion` → write/query/expire; endpoints validated against catalogs; NULL/empty reasoning rejected at the staging boundary.
5. **Hallucinated endpoint dropped at disposal** (unresolved `a_ref`/`b_ref` → `drop`, never canonical).
6. **Replay idempotency incl. aggregates (D4):** two `applyBridgePromotion` on the same staging ⇒ identical row set **and** `corroboration_count` unchanged (not just row-set — the §8-issue-1 trap).
7. **Word-prefix (D5):** under `comparative`, a single-match prior escalates to the arbiter (no silent bind); under `assimilating`, the short-form→full-name bind still resolves.

---

## 6. Phasing (vision preserved)

- **Phase 0 = substrate readiness** (`05-preconditions.md`). Runs *before* Phase A schema and *in parallel* with the E1 gate (E1 has no substrate dependency). The only code change gating Phase A is the corroboration replay-count fix (cloned into `bridge_edges`); the rest is a discovery audit, migration/AGE verification, and recorded dispositions. Bounded — not a general cleanup.
- **Phase A = §2 v1.** Hand-seeded, no external tooling. Gate: E1 + the round-trip + the fusion demo pass, and Phase 0 exit criteria met. Freeze the `element_ref` function and anchor columns now.
- **Phase B.** Extract the **pass registry** from the (now two) real passes; the **edge-rule vocabulary/walker** (D3/D7 guards); the **MCP surface + coverage sweep + `audit_runs`** (D6 fork, actor-pin, teaching primitives).
- **Phase C.** External code graph (SCIP/CodeQL) + SARIF importer + live `onCodeChange` + the cross-cadence consistency model — resolves D10 (Q12/Q13). Largest, partly external; behind its own empirical gate (SCIP-symbol stability, sibling to E1).

---

## 7. Still open (correctly deferred, not loose ends)

- **Q12 — cross-cadence consistency model.** Anchored-snapshot is the working assumption; read-time semantics (valid / stale / hidden for an anchored-but-behind bridge) decided in Phase C when a live code graph exists.
- **Q13 — SCIP-symbol stability across file moves.** An empirical bet run alongside Phase C's build, with a real indexer + a mutation corpus. AST-hash fallback is strictly worse and only a backstop.

Both are Phase-C only; neither blocks a clean v1.

---

## 8. Pre-existing issues surfaced by the review (not this feature)

1. **Corroboration inflates on epoch-replay.** `createCausalEdge` (`causal.ts:254-256`) calls `applyCorroboration` on an exact-match re-dispatch, bumping `corroboration_count` every replay; the idempotency test only checks row-set equality, so it passes while the count drifts — a latent breach of the epoch-v2 order-independence guarantee. Worth a bead independent of this feature.
2. **Graph-anchored fallback recall fails silently on unsynced AGE.** `findConnectedEntities` catches and returns `[]` (`graph.ts:270-273`), so `recallViaGraph`/`expandFromAnchors` (`graph-fallback.ts:189`) silently yields empty recall when AGE lags (the migrate-drift reality) — no error, just degraded recall. Worth a bead; also why AGE-sync health is a standing gate item.

---

## Appendix — what each earlier doc now provides

`00` = the code use case + prior art · `01` = the primitive/control-surface reframe (fixed core + two boundaries) · `02` = the diagrams · `03` = full component detail + the original open-questions register (now closed here) · **`04` (this) = the decisions, the v1 scope, and the phasing we build from.**
