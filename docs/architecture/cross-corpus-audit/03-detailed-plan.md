# Detailed Plan — Pseudocode Architecture, Test Strategy & Open-Questions Register

**Status:** Pre-implementation spec. Feeds a review pass, then implementation. Grounded in six read-only code investigations against `feat/cognitive-platform-v2` (2026-07-06); every "exists today" cite is current. Companion to `00-design-space.md` (the code use case), `01-primitives-and-control-surface.md` (the primitive reframe), `02-proposed-architecture.md` (the diagrams). Nothing here is built.

**How to read it.** Part A is the small set of cross-cutting decisions that gate everything and must be made *before* code — read it first. Part B is the per-component pseudocode architecture with a test strategy each. Part C is the consolidated open-questions register (the point of this exercise). Part D is the reuse-vs-build ledger; Part E the phasing against the empirical gate.

**Convention:** *exists today* = reuse, verified in current code · **NEW** = build · **DECISION** = an open choice that gates the migration.

---

## Part A — Cross-cutting decisions that gate everything

These recurred across three or more component specs. None is a table shape; each is a decision that changes multiple migrations. Implementation should not start until A1–A3 are settled.

### A1 — Endpoint identity: what *is* a bridge endpoint? **(DECISION — the headline hole)**
The two design docs contradict each other. `00` V.2 / `02` Parts 6–7 say endpoints are **code/rule elements** (external ids: SCIP symbol / AST-hash, rule strings like `MISRA-C:21.6`) — implying TEXT columns + validation-at-disposal, no FK. `00` IX.1 reframes toward **corpus elements are canonical entities resolved within their corpus** — implying UUID FKs exactly like `causal_edges → causal_events`. They cannot both be true.

**Proposed resolution (reconciles the two component specs that collided on it):** endpoints are **always UUIDs with a `kind` discriminator**, and a code element gets a *deterministic derived* UUID: `element_ref = uuidV5(CODE_ELEMENT_NS, "scip|corpus|<symbol>")` (the exact hand-rolled `uuidV5` already in `pipeline.ts:306`). This dissolves the TEXT-vs-UUID fork — the code element is a UUID *and* stable *and* mintable offline (Phase A hand-seeding needs no code build). A sparse `code_elements` catalog holds the reverse map (ref → symbol) for elements a bridge has actually cited.

**The sub-decision that remains, and why it matters beyond schema:** are code elements *also* run through the entity resolver (becoming embedded `entities` rows, per IX.1) or kept as *bare catalog rows only* (per the translation spec)? This is not cosmetic — **the E1 semantic-recall path needs the code side to be embedded** (you search behaviour-text against rule-text). If code elements are bare catalog rows, the `behaviour_summaries` embeddings must live somewhere explicit (Qdrant, or a dedicated embedded table). So A1 decides *where the semantic-recall substrate lives*, which is why it couples to the empirical gate (Part E).

### A2 — AGE is a non-authoritative hint-index. **(DECISION — recommend: yes, ratify it)**
Two independent specs (corpus scoping, translation unit) reached the same conclusion. AGE cannot persist edge-`SET` properties (`001:444-447`), its sync is a bare-catch WARNING that can fail invisibly (the migrate-drift reality), and `corpus_id` can only ride as a *node* property — so every `MATCH (a)-[:REL]->(b)` silently walks across corpora unless it self-filters `WHERE a.corpus_id = b.corpus_id`. **Rule to ratify:** Postgres tables are the sole source of truth; AGE is a hint-index only; **no fusion decision and no bridge verdict is ever made from an AGE traversal.** Bridge/chain traversal is Postgres recursive-CTE (the `causal.ts:801` pattern), never Cypher. Bridges do **not** sync to AGE in v1.

### A3 — Derived state: query-time by default, materialize only behind a maintainer. **(DECISION — recommend the default)**
The edge-rule walker (inverse, symmetric, composition) and the coverage carry-forward both raise "do we persist derived rows?" Materialization re-introduces exactly the soft-expiry staleness pain the system already fights, and collides with AGE dropping edge props. **Default: compute-on-read.** Materialize (composition edges, inverse edges, carried-forward coverage) only behind an explicit maintainer pass with `derived_from` provenance and an "all-parents-active" re-check. This keeps the hard core off the two most drift-prone mechanisms.

### A4 — Behavior knobs are policy presets, not global constants. **(carries into the plugin model)**
Two knobs surfaced that a single use case wants set opposite ways: the **word-prefix auto-bind** (keep for assimilating corpora, disable for comparative ones) and the **contradiction stance** (resolve within-corpus, record-as-finding across corpora). These are the first concrete `relation`/identity policy presets from `01` Part V — ship them as a **corpus policy preset** (`'assimilating'` | `'comparative'`), not as `if (corpus)` branches sprinkled through the code.

### A5 — Hallucinated *reasoning* has no structural gate. **(accept the limit)**
FK/existence validation at disposal catches hallucinated *ids* (endpoint doesn't resolve → dropped). It does **not** catch the dangerous sub-type: valid endpoints, wrong attribution ("this line violates 21.6" when it doesn't; prior art 1.8–10.3%/project). The only levers are `model_version` + `source_commit`/`source_ast_hash` anchoring (enables deterministic re-run/diff) and **mandatory human review of LLM-reasoned bridges in iteration one**. Accept this as a stated limit; do not pretend a CHECK covers it.

---

## Part B — Component specs

### B1 — Pass registry (composition boundary 1)

**Reuse:** the causal pass already *is* trigger→invoke→dispose under other names (`shouldRunCausalPass` → `invokeCausalAgent` behind an injectable seam → `applyCausalPromotion`), called from one hardcoded site (`pipeline.ts:1052`). Actor identity, per-actor allow-list, staging-only writes, deterministic promotion are all already actor-parameterized; the seam was exercised twice (`extraction_proposer`, `causal_agent`). **Build: the outer loop only** (plus per-pass code, which no registry abstracts away).

```
interface Pass {
  name: string
  actor: Actor                         // in VALID_ACTORS; absent from mig-009 audit CHECK (staging-only)
  order: number
  trigger(ctx): Promise<{run, reasons}>       // ← shouldRunCausalPass (pure) + its DB signal-gathering
  invoke(ctx):  Promise<void>                 // ← invokeCausalAgent seam; writes STAGING only
  dispose(ctx): Promise<{created, dropped}>   // ← applyCausalPromotion; deterministic, per-edge isolated
}
PassCtx = { epochId, promotion }

async function runPostPromotionPasses(ctx):     // replaces pipeline.ts:1051-1064
  for (pass of PASS_REGISTRY.sortedBy(order)):
    try {
      if (!(await pass.trigger(ctx)).run) continue
      try { await pass.invoke(ctx) } catch(e) { warn; /* fall through to dispose */ }
      results[pass.name] = await pass.dispose(ctx)
    } catch(e) { warn(`${pass.name} non-fatal`); results[pass.name] = {error:e} }  // ISOLATION
  return results        // NEVER rejects; promotion already committed upstream
```

**Hooks in:** epoch arm only, right after `promote()`. **Scope out of v1:** the `extract()` legacy passes (gardener/decay/contradictions) — they trigger on run-count, take a different ctx, and *write canonical directly*, so folding them in is a behavior change, not a refactor.

**Invariants:** staging-only invoke (allow-list = reads ∪ this pass's `propose_*`); pass actor never in the audit CHECK; dispose deterministic & idempotent; one pass failing can't abort others or fail the epoch; deny-by-default for unknown actor.

**Tests (concrete):** (a) trigger=false ⇒ neither invoke nor dispose called; (b) for every pass actor, `allowlistFor(actor)` contains zero canonical-write tools and the actor is not in the audit CHECK, and an unknown actor falls back to `PROPOSER_SURFACE`; (c) two `dispose` calls on the same staged rows ⇒ identical canonical row count + identical created-id set (idempotent); (d) pass A `invoke` throwing ⇒ A's own dispose still runs AND pass B still runs; `runPostPromotionPasses` resolves.

**Local holes:** **(biggest)** the current single pass *fuses trigger-evaluation with scope-assembly* and never defined **same-epoch inter-pass visibility** — may pass B read pass A's just-promoted output this epoch? Undefined and load-bearing (a bridge pass reading causal edges is exactly this). Also: sequential vs concurrent; multi-pass replay/janitor interaction; heterogeneous dispose result shapes need a common `{created,dropped}` contract.

---

### B2 — Edge-rule vocabulary + generic walker (composition boundary 2)

**Reuse:** three near-identical causal recursive CTEs (`traceCauses`/`projectTrajectory`/`findTransitiveChains`) collapse into one parameterized walker; `is_exclusive` is a live rule consumed by the contradiction detector and `createFact` supersession; `inverse_predicate` is already declared (but inert). **Build: the rule tables + composition derivation + live inverse/symmetric + acyclic write-validator.**

```sql
-- NEW: the declarative rule surface the walker reads (spans fact/causal/bridge stores)
CREATE TABLE public.relation_types (
  relation TEXT PRIMARY KEY, store TEXT, edge_table TEXT,
  head_col TEXT, tail_col TEXT, relation_filter TEXT, active_filter TEXT, weight_col TEXT, time_col TEXT,
  is_transitive BOOL DEFAULT false, is_symmetric BOOL DEFAULT false, is_acyclic BOOL DEFAULT false,
  is_exclusive BOOL DEFAULT false, inverse_active BOOL DEFAULT false, inverse_relation TEXT,
  requires_temporal_order BOOL DEFAULT false, materialize BOOL DEFAULT false,
  max_depth INT DEFAULT 10, fanout_cap INT
);
CREATE TABLE public.relation_compositions (   -- a ∘ b => c  (e.g. parent_of∘parent_of=grandparent_of)
  a_relation TEXT, b_relation TEXT, derived_relation TEXT, PRIMARY KEY (a_relation,b_relation,derived_relation)
);
```

```
walkChain(relation, startId, {direction, maxDepth, minWeight}) -> Path[]:
  rt = loadRelationType(relation)
  # emit the EXACT causal-CTE shape but with head_col/tail_col/active_filter/weight_col
  # substituted from rt; symmetric ⇒ force undirected; DISTINCT ON (edge_id) ORDER BY depth.
# the three legacy fns become wrappers:
traceCauses      = walkChain('CAUSED', ev, {backward, minWeight})
projectTrajectory= walkChain('CAUSED', ev, {forward,  minWeight})
findTransitiveChains = walkChain('CAUSED', root, {both, maxDepth})
queryInverse(rel, x)      # query-time endpoint swap over the BASE rows (A2/A3: no materialization by default)
deriveComposition(a∘b=>c) # join on shared middle node; compute-on-read unless materialize=true
validateWrite(rel, h, t)  # is_acyclic ⇒ reject if t already reaches h; requires_temporal_order ⇒ time(h)<=time(t)
```

**Control flow:** all traversal is Postgres CTE (A2 — AGE can't hold rule flags/derived props). Detector switch: `detectOpposingObjects` swaps its `fact_predicates.is_exclusive` lookup for `relation_types`; `detectCyclicCausal`/`detectTemporalImpossible` become rule-driven with the 2-cycle SQL as a fast-path.

**Tests (property-based, reuse the causal topology fixtures):** transitive closure = expected set at bounded depth; acyclic write-validator rejects a cycle-closing edge while the walker still terminates on forced-cyclic data; inverse round-trips; composition derives grandparent_of (and excludes self/direct); symmetric edge stored once is not double-counted; expired/invalidated edges drop out of chains; **regression parity** — `walkChain('CAUSED',…)` rowset == legacy `traceCauses`/`projectTrajectory`/`findTransitiveChains` on `diamond`, `cycle`, `deep-cycle-depth-20` fixtures.

**Local holes:** **(biggest)** derived-edge lifecycle if `materialize=true` — who expires a composed/inverse edge when a parent expires (A3 punts this to query-time default). **(sharpest migration hazard)** `is_exclusive` is *not* a clean per-row boolean — `AUGMENTATION_GROUPS` folds many predicates into one exclusivity group; the generic layer needs an `exclusive_group_id`, not a bool, or it regresses supersession. Also: generic-walker perf without a `weight_col` cutoff on dense fact graphs (needs mandatory `max_depth` + `fanout_cap`); symmetric+exclusive interaction (one active spouse, both directions).

---

### B3 — Corpus scoping (the assimilate-vs-compare toggle)

**Reuse:** threads exactly like `stream_id` does today (ingest → store → Qdrant payload → extract → promote). **Build: one `corpus_id` column on instance tables + one predicate at each of 4 choke points + a composite-FK DB backstop.**

```sql
-- instance tables get: corpus_id TEXT NOT NULL DEFAULT 'default'
--   entities, facts, causal_events, merge_candidates, entity_meta, entity_clusters,
--   contradictions, staging_proposed_{entities,facts}, staging_causal_edges
-- GLOBAL (unchanged): fact_predicates, entity_types (shared vocabulary); stream_participants (orthogonal)
-- DB backstop — declarative, no trigger except the executor:
ALTER TABLE entities ADD CONSTRAINT entities_id_corpus_uq UNIQUE (id, corpus_id);
ALTER TABLE merge_candidates ADD FOREIGN KEY (entity_a_id, corpus_id) REFERENCES entities(id, corpus_id),
                             ADD FOREIGN KEY (entity_b_id, corpus_id) REFERENCES entities(id, corpus_id);
ALTER TABLE facts ADD FOREIGN KEY (subject_entity_id, corpus_id) REFERENCES entities(id, corpus_id),
                  ADD FOREIGN KEY (object_entity_id, corpus_id)  REFERENCES entities(id, corpus_id); -- MATCH SIMPLE
-- mergeEntities has no candidate row ⇒ BEFORE INSERT trigger on entity_merges asserts same corpus.
-- graph_stats: break the id=1 singleton → PRIMARY KEY (corpus_id).
```

The four guards are each one predicate: (1) `findSimilarEntities` + `createEntity` dedup gain `AND corpus_id = $c`; (2) `loadPromotionInputs` prior/anchor queries gain `AND corpus_id = $c` (the word-prefix matcher itself needs no change — it only sees scoped priors); (3) `detectMergeCandidates` enumeration + `merge_candidates` INSERT gain corpus scope; (4) `detectOpposingObjects` — because entities never fuse across corpora, distinct `subject_entity_id`s mean the self-join *already* never crosses corpora; add `AND f1.corpus_id = f2.corpus_id` as defense-in-depth and tag the row. Cross-corpus disagreement is thus routed to the bridge pass as a *finding*, per A4.

**Migration sequencing:** ADD COLUMN with DEFAULT *is* the backfill (instant, every extant row → `'default'`); then constraints/FKs/trigger; then `graph_stats` surgery. Forward-only. Derived compute (HDBSCAN, `graph_stats`) becomes per-corpus — cluster ids are corpus-local; adaptive merge weights adapt to the corpus's own distribution.

**Tests — the `printf` collision fixture:** seed `printf`/`code_symbol` in corpus A and `printf`/`rule` in corpus B with context embeddings forced **> 0.92**; assert distinct canonical ids at *each* of the 4 paths (resolution, word-prefix, gardener, contradiction); assert two same-corpus `printf` mentions at >0.92 **still** fuse (regression); assert the composite FK rejects a bypassed cross-corpus `merge_candidates` insert (SQLSTATE 23503) and the trigger blocks a bypassed `mergeEntities`.

**Local holes:** **(biggest)** the AGE mirror (A2) — `corpus_id` only as a node prop, every Cypher walk must self-filter, sync unreliable. Also: global-vocabulary *leakage* (B's predicates/types appear in A's extraction prompt; `is_exclusive` is one global flag with no per-corpus override); denormalize-vs-inherit `corpus_id` on derived tables (recommend denormalize on pairwise/enumeration tables for the FK trick, inherit elsewhere; safe because corpus is immutable); word-prefix scope-vs-disable is the A4 policy knob.

---

### B4 — bridge_edges + audit pass

**Reuse (~70%):** the `causal_edges` row shape wholesale — `reasoning`/`source_references` NOT NULL, reverse-ref index, soft-expiry + `stale_citation`, partial-unique dedup, propose→stage→pure-plan→deterministic-promote, deny-by-default allow-list, fact-staleness cascade. **Build: the two-corpus span + provenance bin + drift anchors + the `audit_agent` wiring.**

```sql
CREATE TABLE public.bridge_edges (
  id UUID PK,
  a_kind VARCHAR(12), a_ref UUID,           -- endpoint A (A1: kind ∈ code_element|entity|fact; a_ref is a UUID —
  b_kind VARCHAR(12), b_ref UUID,           --   code_element uses the derived uuidV5, entity/fact use real ids)
  source_corpus_id TEXT, target_corpus_id TEXT,       -- the span (decisive reason for own table)
  relation VARCHAR(16) CHECK (relation IN ('violates','satisfies','not_applicable')),  -- not_applicable first-class
  severity VARCHAR(16), category VARCHAR(64), code_location JSONB,        -- reporting/group-by
  extraction_method VARCHAR(24) CHECK (... IN ('sarif_seed','llm_audit','checker_unavailable')),  -- provenance bin
  source_commit TEXT, source_ast_hash TEXT, rule_set_hash TEXT, model_version TEXT,   -- drift anchors (A5)
  reasoning TEXT NOT NULL, source_references JSONB NOT NULL,              -- non-negotiable invariant
  corroboration_count INT DEFAULT 1, strength FLOAT DEFAULT 0.5,
  stale_citation BOOL DEFAULT false, stale_reason TEXT, stale_source VARCHAR(8),  -- 'code' | 'fact'
  expired_at TIMESTAMPTZ, expire_reason TEXT, run_id UUID, invocation_id UUID, created_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ... ON bridge_edges (a_ref, b_ref, relation) WHERE expired_at IS NULL;  -- dedup: relation in key
-- staging_bridge_edges: NO FK, structural CHECKs (reasoning non-empty, refs array len>=1) — mirrors 044
-- bridge_source_refs: clone of edge_source_refs with ref_type widened to include 'code_element' (ref_id stays UUID)
```

```
planBridgePromotion(prior, staged, verdicts) -> {create, corroborate, drop}:  # PURE, mirrors planCausalPromotion
  for e in staged:
    if !resolved(e.a_ref) or !resolved(e.b_ref): drop("unresolved endpoint"); continue   # catches hallucinated IDS
    if selfSpan(e): drop; continue
    stale = anyCitedFactInvalidated(e)            # KEEP + flag, never repoint
    p = priorByKey[(e.a_ref, e.b_ref, e.relation)]
    p ? corroborate.push(...) : create.push({...e, staleCitation: stale})
    # optional: SARIF ground-truth override on a decidable cell
applyBridgePromotion(runId): load staging → build verdicts (resolve endpoints, cited-fact status)
                             → planBridgePromotion → createBridgeEdge(actor='promotion') per create; bump per corroborate
```

**Audit pass wiring:** register in the B1 registry; `invoke` has two staging producers — a SARIF importer (`extraction_method='sarif_seed'`, decidable rules) and the LLM agent (`propose_bridge_edge`, undecidable remainder); both land in `staging_bridge_edges`, one deterministic disposer. Add `audit_agent` to `VALID_ACTORS`, an `AUDIT_SURFACE` allow-list entry, and route-pin the actor (B5).

**Tests — the Phase-A gate (hand-seeded, no external tooling):** write→query→expire round-trip with two seeded corpora; hallucinated endpoint dropped at disposal (never in canonical); re-run corroborates (count→2), no duplicate; cited-fact invalidation flags `stale_citation` and does **not** repoint or auto-expire; NULL/empty reasoning rejected at the staging boundary.

**Local holes:** the A1 endpoint tension is *the* gate; A5 hallucinated-reasoning has no structural catch (needs `reviewed_by`? — undecided); does `no-violation` emit a bridge row or live only in coverage (forks the write path — B5); SARIF-seed vs LLM disagreement precedence on a decidable cell (stub).

---

### B5 — MCP surface + audit_runs + coverage

**Reuse:** `audit_runs` is a field-swap on `ingest_jobs` (self-ensured via `to_regclass`, resume-by-name, hash-mismatch-throws); coverage idempotency copies mig-034's nullable-`invocation_id` UPSERT; `assert_connection` is `propose_causal_edge` with a different endpoint pair; the allow-list/deny-by-default/write-queue machinery exists. **Build: the 4-bin coverage matrix + ~8 thin routes + 3 teaching primitives + the actor-pin fix.**

```sql
CREATE TABLE public.audit_runs (            -- near-copy of ingest_jobs, self-ensured
  id UUID PK, name TEXT UNIQUE, source_corpus_id TEXT, target_corpus_id TEXT,
  rule_set_hash TEXT NOT NULL,              -- resume against a changed rule set THROWS (like corpus_hash)
  model_version TEXT, status TEXT DEFAULT 'running', ...);
CREATE TABLE public.audit_coverage (
  id UUID PK,                               -- uuidV5(RUN_NS, `${run}:${element_ref}:${rule}`)
  run_id UUID REFERENCES audit_runs(id), element_ref TEXT, rule_id TEXT,
  verdict TEXT DEFAULT 'pending',           -- pending | violation | no_violation | checker_unavailable  (4 bins)
  edge_id UUID REFERENCES bridge_edges(id), -- NULLABLE: set only when adjudication produced a durable bridge
  invocation_id UUID, UNIQUE(run_id, element_ref, rule_id));
CREATE INDEX ... ON audit_coverage(run_id) WHERE verdict='pending';   -- nextPendingAuditUnit hot path
```

**~8 tools** (each with a non-empty inputSchema — the dead server's bug was empty schemas): `start_or_resume_audit_run`, `ingest_corpus`, `search_corpus`, `traverse`, `find_candidates`, `assert_connection` (the one write tool), `query_connections`, `get_ref`, `audit_status`. Thin corpus-scoped HTTP routes — **not** a passthrough of the 49 internal tools.

**The actor-pin fix (load-bearing):** today `pi-agent-bridge.ts` reads `actor` from the request *body* (validated, not pinned). New audit routes **derive the actor from the route** (`ROUTE_ACTOR='audit_agent'`), reject a body actor; the explicit ctx wins over env/default and composes with the existing double enforcement (advertise-filter + `handleToolCall` re-check).

**Two modes, one write path:** systematic sweep (`nextPendingAuditUnit` filters `verdict='pending'`, order-independent) and free exploration (opportunistic `assert_connection`, `run_id` optional) both hit the same staging→promote path.

**Tests:** every advertised tool has a non-empty inputSchema and only the 8 audit tools are exposed (no leak of the 49); a spoofed body actor is rejected/ignored and never persisted, and cannot widen the surface; resume returns the first pending cell and skips settled ones; the 4 verdict bins are distinct (`no_violation` ≠ `pending` ≠ `checker_unavailable`); deny-by-default (unknown tool for actor rejected); duplicate assert with same `invocation_id` upserts to one row.

**Local holes:** `element_ref` stability (A1/translation); **carry-forward on re-audit unresolved** (new run copies unchanged verdicts vs JOIN-at-report-time — A3 leans query-time); does free-exploration stamp coverage cells (else `audit_status` under-counts); does `no_violation` emit a bridge or coverage-only (forks the write path); `checker_unavailable` fall-through-to-LLM semantics.

---

### B6 — Translation unit (the hard core)

**Reuse:** `uuidV5` determinism (`pipeline.ts:306`), the "derived read index, JSONB authoritative" pattern of `edge_source_refs`, the flag-don't-repoint cascade (`causal.ts:568`, `044`). **Build: the id-derivation + sparse catalog + two-source staleness + reconcile.**

```
element_ref = uuidV5(CODE_ELEMENT_NS, `${scheme}|${corpusId}|${canonical_symbol}`)  # SCIP symbol preferred; AST-hash fallback
CREATE TABLE public.code_elements (          -- SPARSE: a row only once a bridge cites the element
  element_ref UUID PK, corpus_id UUID, scheme VARCHAR(8), canonical_symbol TEXT,
  commit_sha VARCHAR(40), content_hash VARCHAR(64),
  file_path TEXT, line_start INT, line_end INT,  -- MUTABLE locator, not identity
  last_seen_commit VARCHAR(40), status VARCHAR(12) DEFAULT 'live',   -- 'live' | 'vanished'
  UNIQUE(corpus_id, scheme, canonical_symbol));

onCodeChange(commit):        # CODE-side staleness (the NEW second source)
  external.build(commit)     # scip/CodeQL — EXTERNAL
  for row in code_elements:
    live = external.resolve(row.canonical_symbol, commit)
    if !live: mark vanished; flag citing bridges stale(source='code'); NEVER repoint
    elif live.content_hash != row.content_hash: catalogUpsert; [flag if verdict depends on body — OPEN]
    else: catalogUpsert   # pure line-move ⇒ locator update ONLY, ref stable, no flag
onFactExpiry(factId):        # MNEMO-side, reuse cascadeFactExpiry: corroborated ⇒ weaken; sole-source ⇒ expire
reconcileBridges(commit):    # ASSERTS invariants (flag-consistency), never auto-heals
```

**Split:** the *full* code graph stays external (`index.scip` / CodeQL DB, built at commit time); Mnemo stores only the sparse cited subset. Line-move is invisible (identity is line-independent); rename/signature-change *changes* the symbol → a staleness event by design.

**Tests — writable in Phase A (stub resolver, no indexer):** `element_ref` deterministic and line-independent (same symbol, different line ⇒ same ref); rename ⇒ different ref; fact-side cascade (sole-source expires, corroborated weakens); code-side with a stub resolver (symbol vanished ⇒ flag + `status='vanished'`, kept not expired; line-move ⇒ no flag, locator updated); hand-crafted SARIF imports to stable refs and re-import is idempotent; NULL `model_version`/`commit` rejected. **NOT writable until resolved (state so):** SCIP stability across real file moves; body-change→flag policy; cross-cadence consistency window.

**Local holes:** **(the two genuinely unsolved)** the cross-cadence **consistency model** (does a read-time query return an anchored-but-behind bridge as valid / stale / hidden — no accepted answer); the **empirical stability of SCIP symbols** across the file-level mutations we care about (descriptor path encodes enclosing scope — file moves *may* churn it; needs a real indexer + mutation corpus, a sibling empirical bet to E1). Also: full-vs-sparse (sparse needs the external index reachable to detect vanishing); who runs the build and when; per-commit re-resolution cost; rename-detection vs the never-repoint discipline (the single most tempting place to violate the anchor).

---

## Part C — Consolidated open-questions register

The point of this exercise. **R** = resolved by the fleshing-out · **S** = sharpened, recommendation given, needs sign-off · **O** = still open, needs a decision.

| # | Question | Status | Component(s) | Recommendation / what it gates |
|---|----------|--------|--------------|-------------------------------|
| Q1 | **Endpoint identity: entity-UUID-FK vs external-id** | **O** | B4, B6, A1 | Endpoints are UUIDs + `kind`; code element = derived `uuidV5(symbol)`. **Gates the bridge_edges migration.** Decide before any Part-B4 code. |
| Q2 | Are code elements *also* embedded entities, or bare catalog rows? | **O** | A1, E1 | Decides where the semantic-recall substrate (behaviour embeddings) lives. **Couples to the E1 gate.** |
| Q3 | AGE authority under multi-corpus | **S** | B3, B6, A2 | Ratify: Postgres source of truth, AGE hint-index only, never decide fusion/verdict from a traversal. |
| Q4 | Derived edges/coverage: materialize vs query-time | **S** | B2, B5, A3 | Query-time default; materialize only behind a maintainer with `derived_from` + all-parents-active re-check. |
| Q5 | Same-epoch inter-pass visibility (may B read A's promoted output?) | **O** | B1 | Correctness-critical for a bridge pass reading causal edges. Define the pass contract before N>1 passes. |
| Q6 | `is_exclusive` generalization (bool vs group-id) | **S** | B2 | Use `exclusive_group_id` not a bool; preserve `AUGMENTATION_GROUPS` matching. The "wired" rule is the hardest to move — do it carefully. |
| Q7 | Word-prefix: scope vs disable | **S** | B3, A4 | Corpus policy preset: `assimilating` keeps it, `comparative` disables auto-bind. |
| Q8 | Contradiction stance: resolve vs record-as-finding | **R** | B3, B4 | Falls out for free — cross-corpus entities are distinct, so the self-join never fires across corpora; route to the bridge pass as a finding. |
| Q9 | Hallucinated *reasoning* gate | **S** | B4, A5 | No structural catch; anchoring + mandatory human review in iteration one. Open: `reviewed_by` column vs separate adjudication table. |
| Q10 | Does `no_violation`/`satisfies` emit a bridge row or coverage-only? | **O** | B4, B5 | Decides whether the "satisfied nowhere" anti-join runs over bridges or coverage, and whether the write path forks. Per-domain (compliance asserts; fiction wouldn't). |
| Q11 | Re-audit carry-forward (copy vs JOIN-at-report-time) | **O** | B5, A3 | Interacts with Q1 (if `element_ref` moves, copy detaches history). Lean query-time JOIN. |
| Q12 | Cross-cadence consistency model (code commit vs ingest) | **O** | B6 | The genuine hard core. Anchored-snapshot + flag-on-divergence proposed; read-time semantics (valid/stale/hidden) undecided. |
| Q13 | Empirical SCIP-symbol stability across file moves | **O** | B6 | A *new empirical bet* alongside E1: needs a real indexer + a mutation corpus. AST-hash fallback is strictly worse. |
| Q14 | `checker_unavailable` fall-through to LLM | **O** | B5, B4 | Affects whether `nextPendingAuditUnit` re-surfaces those cells. |
| Q15 | Global vocabulary leakage + per-corpus `is_exclusive` override | **S** | B3 | Accept vocabulary sharing for v1; per-corpus exclusivity override deferred. |

**Two brand-new holes this exercise surfaced (not in `00`/`01`):** Q5 (inter-pass visibility) and Q13 (SCIP stability as its own empirical bet). **One doc contradiction found:** Q1 (`00` V.2 vs `00` IX.1).

---

## Part D — Reuse-vs-build ledger (updated, grounded)

**Reuse, verified in current code:** the causal-pass trigger→invoke→dispose lifecycle + injectable invoker + deterministic promotion; the causal-edge row shape (NON-NULL reasoning/refs, reverse-ref index, soft-expiry, `stale_citation`, partial-unique dedup, corroborate-or-insert); the propose→promote single-writer + pure planners; the deny-by-default double-enforced actor allow-list; `ingest_jobs`/`to_regclass` self-ensure + resume-by-name + `invocation_id` UPSERT; the three causal recursive CTEs (→ one walker); `is_exclusive` rule consumption; `inverse_predicate` (declared); the `stream_id` metadata-threading path (→ `corpus_id`); `uuidV5` determinism; the dead server's transport shell.

**Build, net-new:** the pass-registry loop (small); `relation_types`/`relation_compositions` + generic walker + composition/inverse/acyclic runtime; `corpus_id` column + 4 guards + composite-FK backstop + `graph_stats` surgery + per-corpus derived compute; the `bridge_edges` family (2-corpus span, provenance bin, drift anchors, staging, `planBridgePromotion`, widened reverse index); `audit_runs`/`audit_coverage` (4-bin) + `nextPendingAuditUnit`; the ~8 tools + 3 teaching primitives + actor-pin; the `code_elements` catalog + `element_ref` derivation + two-source staleness + reconcile; **the external code-graph build + SARIF importer** (largest, partly external — Phase C).

---

## Part E — Phasing & the empirical gate

**The gate (must pass before committing to Phase C external tooling):** E1 behaviour↔rule recall (≥0.65 recall@5 on ≥50 pairs) + AGE-sync health + the live cross-corpus fusion demo. Plus the two new gate items this exercise added: **Q13** (SCIP-symbol stability, empirically) belongs in the same gate, and **Q1/Q2** (endpoint identity + where embeddings live) must be *decided* before Phase A schema lands because they are irreversible-once-data-exists.

**Phase A — hand-seeded, no external tooling.** `corpus_id` + guards + backstop (B3); `bridge_edges` family + `planBridgePromotion` + the `audit_agent` actor (B4); `element_ref` derivation + `code_elements` + stub-resolver staleness (B6); `audit_runs`/`audit_coverage` (B5). **Freeze the `element_ref` derivation function and the anchor columns now** (cheap, irreversible once data exists). Gate: the bridge write→query→expire round-trip passes with hand-crafted SARIF and a stub resolver.

**Phase B — pass registry (B1) + edge-rule vocabulary (B2) + the ~8 MCP tools/routes + coverage sweep.** All testable against Phase-A data.

**Phase C — the external code-graph build (scip/CodeQL) + SARIF importer + live `onCodeChange`.** Replaces the stub resolver. Blocked on Q12/Q13; the largest, partly-external piece.

---

## Appendix — contradictions & divergences found between the docs

1. **Q1 endpoint identity** — `00` V.2 (code/rule elements, no FK) vs `00` IX.1 (canonical entities, FK). Resolved-proposal in A1; must be ratified.
2. **bridge_edges column shape** — the B4 spec used `source_element_id`/`target_rule_id` TEXT; the B6 spec used polymorphic `a_kind`/`a_ref` UUID. Reconciled here to **polymorphic UUID endpoints** (a_kind/a_ref), because deriving `element_ref` as a `uuidV5` makes the code endpoint a UUID and lets the reverse index (`bridge_source_refs`) keep `ref_id UUID`, reusing `edge_source_refs` with only a widened `ref_type` CHECK.
3. **"reuse the causal-edge pattern wholesale"** is true at the *shape* level, false at the *column* level: `edge_source_refs.ref_id` is `UUID` and `ref_type` is a 3-value CHECK — a code element fits only because A1 gives it a derived UUID and B6 widens the CHECK.
