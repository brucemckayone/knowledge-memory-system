# Cross-Corpus Comparison & Reasoning Graph — Design-Space Doc

**Status:** Investigation / position doc — captures an investigation and the framing decisions from it. **Not a build spec.** No branch, no code, no migration ships with this. (Follows the repo norm of design-before-code for P1+, and the discussion-doc style of `truth-graph/39-natural-language-graph-querying.md`.)
**Date:** 2026-07 · **Base branch context:** `feat/cognitive-platform-v2`
**Provenance:** consolidates a six-part codebase+web investigation and the preceding system-understanding pass, then hardened by an adversarial multi-agent review (four review lenses + verify + synthesis). Working notes (scratchpad, ephemeral) — `understanding-00..04`, `research-05`, `investigate-00..06` — can be moved into this folder if we want them retained.

---

## Part 0 — The vision

The core capability, stated generally: **graph-comparison reasoning over disparate corpora for knowledge work in any domain.** Ingest two (or more) *independently-built* bodies of knowledge, keep them separable, and let an agent build durable, reasoned, source-referenced **bridge** edges *between* them — then query the result. The corpora can be anything textual: a coding standard and a codebase; a body of research papers and a textbook; design notes and a manuscript; a world-building bible and a draft novel; tutorials and reference docs.

Exposed to agents as an **MCP** (a web UI is a plausible later consumer; MCP is the surface we're designing for now).

**Two layers — a domain-agnostic core + thin domain adapters.** This separation is the load-bearing idea: nothing in the core knows about code or MISRA.

- **General core (domain-agnostic):** corpus partitioning; neutral within-corpus extraction; durable cross-corpus bridge edges with reasoning + provenance; the recall → adjudicate → bridge → traverse pipeline; a coverage matrix; cross-session comparison runs; the MCP tool surface.
- **Domain adapter (per domain):** (a) the *structured tags* both sides can be matched on symbolically; (b) the *relation vocabulary* the bridges use; (c) an optional *deterministic oracle* to seed ground-truth bridges, if the domain has one; (d) the domain's *epistemic caveats*.

| Domain | Corpora | Structured tags | Relation vocabulary | Deterministic oracle |
|---|---|---|---|---|
| **Code compliance** (worked example) | standard + codebase | AST/language constructs | violates / satisfies / not-applicable | yes — CodeQL/linters (SARIF) |
| Research synthesis | papers + textbook/survey | topics, methods, citations | supports / contradicts / extends / refutes | none — semantic + LLM only |
| Fiction / world-building | story bible + manuscript | characters, places, timeline, motifs | contradicts / elaborates / references / retcons | none |
| Learning | tutorials + reference docs | concepts, prerequisites | teaches / assumes / conflicts-with | none |

**Why code first:** it's the domain we work in and — decisively — the *only* one with a deterministic oracle (CodeQL) to check the LLM against, so it's the easiest to verify. Code/MISRA **illustrates** the design; it does not **shape** it. Everything domain-specific below (decidability routing, SARIF, "never emit compliant") is the *code-compliance adapter*, not the core — read it as one worked instantiation.

---

## Part I — Settled framing (co-designed in dialogue)

These were decided during the investigation and are treated as given below. Each is revisitable, but the investigation did not surface a reason to.

1. **Partition by `corpus_id` on the canonical tables**, reusing the existing `stream_participants` anti-merge mechanism so entity resolution never fuses across corpora. (Chosen over overloading `stream_id`, and over separate databases which would make the comparison — the whole point — hard.)
2. **Durable cross-corpus bridge edges**, not ephemeral per-run reports. Findings persist, accumulate, and are the product; the report is a query over them. (Chosen over a read-only report path.)
3. **Neutral within-corpus extraction; opinionated cross-corpus bridges.** The base graphs stay reusable and objective; the caller's use-case lens lives *only* at the bridge layer. This reconciles "let the caller steer the connections" with "don't pollute a reusable substrate."
4. **Code-up audit direction.** The agent walks the code and, per element, finds the governing rules and builds relationships. (Chosen over rules-down; a rules-down *completeness* pass is a possible later complement — see Part VII.)
5. **The external agent self-adjudicates; Mnemo stores the verdict.** The audit agent has its own model and standards expertise; it reads, decides, and records a reasoned bridge. Mnemo does not reason about the use case — it enforces write discipline. This dissolves the "we can't inject Mnemo's fixed extraction prompt" problem.
6. **Retrieval/mapping pipeline:** coarse recall (a *symbolic* join on tagged language constructs ∪ *semantic* search over verbalized behaviour↔rule text) → LLM adjudication → durable bridge → cheap bootstrapped graph traversal thereafter.
7. **Non-goals (this phase).** (a) Not a replacement for a formal GCS/deviation workflow — findings require human sign-off. (b) Not a compliance *certification* — `satisfies` rows are method-scoped observations, never a whole-corpus compliance claim. (c) Static analysis only — no runtime behaviour. (d) MISRA C first — MISRA C++, CERT and other standards are a later extension; cross-standard from day one (IX.6) is out of scope for this phase. (e) Not a real-time CI gate — offline, session-based audit only.
8. **Two modes of connection-making, one tool surface.** The agent is not only a scripted comparison runner. (a) *Systematic sweep* — methodically check every source element against every relevant reference, track coverage, miss nothing (verifiable, exhaustive). (b) *Free exploration* — the agent roams the graph through the MCP read tools and asserts a connection whenever it notices one worth making, including links no recipe would generate. Both write the *same* durable, reasoned, sourced edge; the sweep is one way to use the tools, not the only way. The graph is the agent's **reasoning surface**, not just an output store — so it can also assert *higher-order* connections (a link between findings, a pattern across a cluster), always under the same reasoning + provenance discipline. This is where novel insight lives, and per Part V.6 it is the real reason the system beats "just run a linter."

---

## Part II — How Mnemo works today (feature-relevant mechanics)

Condensed from the system-understanding pass; verified against code. Fuller detail in the `understanding-*` working notes.

**Runtime is three tiers; the model call is a subprocess.** Platform (Node/Hono :3000) → HTTP → ml-services (Python FastAPI :8000, a bounded pool of 6) → shells out to `claude -p` (Haiku-first, auto-escalating) → that process connects *back* over stdio to the internal MCP server (`graph-mcp.ts`) and writes the graph by calling tools. The LLM-drives-graph-via-MCP loop is the production write path, not a new idea.

**Stores.** Qdrant holds source text as a parent "window" point + 128-char "unit" satellites (payload carries `stream_id` — the scoping precedent). Postgres (pgvector + Apache AGE) holds entities/facts/causal. **AGE edge-property `SET` is silently dropped** (so canonical data lives in Postgres tables) — but *entity-graph* traversal still goes through AGE Cypher (`getAllEdges`, `getEntityDegrees`, `getSubgraph` in `graph.ts` use MATCH via `executeCypher()`); only *causal*-graph traversal uses recursive CTEs over `causal_edges` (`causal.ts:827,940`). `causal_events.event_embedding` / `causal_patterns.pattern_embedding` are declared-but-never-written dead columns.

**Provenance chain.** text → units → `memory_entities` mentions → bi-temporal `facts` → `fact_sources`/`fact_units` → `causal_events` → `causal_edges` (which *require* `reasoning NOT NULL` + `source_references JSONB NOT NULL`) → `edge_source_refs` reverse index.

**Two write disciplines.** Legacy path: the agent writes canonical rows via `createFact`, serialized by a per-process promise queue. Epoch/batch path: agents run as restricted proposers that write *only staging* via epoch-local handles, and a single deterministic `promote()` is the sole canonical writer — pure `f(prior, staged, verdicts)`, order-independent, idempotent (re-runs corroborate, never duplicate). Actor allowlists are enforced server-side twice (advertise + execute), deny-by-default.

**Identity.** Entity resolution: `>0.92` cosine auto-merge, `0.75–0.92` take-best, `<0.75` new. Fact identity is a partial-unique active triple; duplicate insert → SQLSTATE 23505 → corroboration.

**Resumability.** `ingest_jobs` + `ingest_sub_batches` (self-ensured via `to_regclass` because the live DB doesn't run migrations on boot), stable `sourceId` → deterministic `windowPointId` → retries UPSERT. A resumable driver loop pauses on session limits and resumes from the next pending sub-batch.

**Continuity today (thin).** `extract()` seeds the agent with the single latest extraction report; `reasoning_reports` + `get_reasoning_history` (entity-scoped) persist working notes; `invocation_id` gives per-call idempotency.

**Corrections to stale docs.** `create_causal_edge` was retired (it's `propose_causal_edge` via a post-promotion pass); the live internal tool count is **49**; the external `mcp-server/` (6 tools) is **dead** on this branch — it runs over stdio (transport shell reusable), but every platform API endpoint it calls (`/api/hybrid-search`, `/api/briefing`, …) is absent from the platform so those calls 404 at runtime, and its ListTools handler advertises empty inputSchemas though the handler-side Zod schemas in `tools.ts` are intact; `fact_predicates`/`entity_types` are global ontology.

---

## Part III — The code-compliance adapter (evidence graph, not linter)

*This Part is the **code-compliance domain adapter** (Part 0), not the general core. Its three ideas each instantiate a general principle: (1) **use a deterministic oracle where the domain has one** — here CodeQL for decidable rules — and fall back to the LLM only where none exists; (2) **the relation vocabulary and its epistemic limits are domain-defined** — "never emit compliant" is compliance's caveat, other domains have their own or none; (3) **anchor every bridge to source-version + model-version** — general. Most domains have no oracle and rely on the semantic + LLM path alone.*

The prior-art pass is decisive: **nobody publicly ships this, but every building block exists, and the novelty is narrow.** What is new is the *durable, reasoned, source-referenced, temporally-versioned bridge edge spanning two heterogeneous graphs* — not the code graph, the rule model, or the LLM+analyzer split, all solved elsewhere.

So the honest framing is **a persistent, cross-session compliance evidence graph** that:
1. consumes deterministic checker output (SARIF / CodeQL) as ground-truth seed edges for the **decidable** rules,
2. uses an LLM agent — grounded in a deterministic code graph — to reason only about the **undecidable** rules and directives no linter can settle,
3. records every verdict with reasoning + verifiable source refs + **model version + commit/AST-hash anchor**,
4. accumulates and self-invalidates across sessions.

This meets regulated-evidence expectations (chain-of-custody, immutability, retained model versions) a SARIF finding-dump cannot.

**Decidability is the master routing key.** ~37 of ~158 MISRA C rules — and *all* directives — are undecidable. Route decidable rules to a deterministic checker (ground truth); reserve the LLM for the undecidable remainder. This one decision de-risks the two scariest failure modes at once (candidate explosion, hallucination): the LLM never touches the rules where recall/precision collapse.

**Never emit "compliant."** Undecidability is a hard ceiling MISRA itself declares. Emit "no violation found by method M with evidence E," and slot into MISRA's deviation/GCS workflow rather than claiming to replace it. Overclaiming is a safety-critical liability. Consequently `satisfies` (Part V.2) is a *per-element, per-method, per-evidence* observation — shorthand for "no violation found by this method with this evidence at this commit" — not a whole-element or whole-corpus compliance claim; the "satisfied nowhere" anti-join in Part IV depends on that scoped reading.

---

## Part IV — Target architecture

```
Reference corpus (standard)                 Active corpus (codebase)
─────────────────────────                   ────────────────────────
MISRA/CERT/CWE rules                         code entities + constructs
+ structured attributes                      built DETERMINISTICALLY:
  (category, DECIDABILITY,                     tree-sitter / SCIP / CodeQL DB
   scope, directive?)                          (NOT LLM extraction)
+ construct tags (LLM-tagged                 + construct tags (parser-emitted,
   ONCE, offline)                               confidence 1.0)
        │                                            │
        └──────────────┬─────────────────────────────┘
                       │  coarse recall = symbolic construct join (exact SQL)
                       │                 ∪ semantic (verbalized behaviour↔rule)
                       ▼
              candidate (element × rule) cells
                       │
        decidable rule?├── yes ──► deterministic checker (CodeQL/linter, via SARIF)
                       │                      ──► ground-truth seed bridge edge
                       └── no  ──► LLM audit agent (external, self-adjudicating,
                                    grounded in the code graph)
                                              ──► reasoned bridge edge
                       ▼
              bridge_edges  (violates | satisfies | not_applicable)
              reasoning NOT NULL + source_references NOT NULL
              + severity/category/code_location + corpus pair
              + commit/AST anchor + model version
                       │  written staging-only via audit_agent actor → promote()
                       ▼
              audit_coverage matrix (run_id × element × rule → verdict)
                       │
                       ▼
              findings = flat/recursive SQL over bridges + coverage
              (counts, anti-joins "satisfied nowhere", per-file, per-category)
```

Everything above `bridge_edges` is recall/adjudication; everything below is Mnemo's existing machinery plus one new table family.

**Routing note — a third bin.** Some rules are formally *decidable* but need whole-program / build-DB analysis (e.g. MISRA C 17.3, 14.3); when the checker can't build the project its silence is indistinguishable from "no violation." Treat *decidable-but-checker-unavailable* as a distinct outcome — record a `checker-unavailable` verdict in `audit_coverage` (separate from both `no-violation-found` and `pending`), optionally falling through to the LLM path with a "no deterministic result" note in `source_references`.

**Modes note.** The diagram shows the *systematic sweep* (Part I.8a). *Free exploration* (I.8b) reuses the same read/write tools and writes the same edges — the agent roams the graph and asserts connections it notices, without the exhaustive coverage loop. Coverage tracking applies to the sweep; the free mode contributes edges opportunistically.

---

## Part V — Design space by area

Each area: **ideas → issues → resolutions → reuse-vs-build**, grounded in code (file:line) where verified.

### V.1 Corpus partitioning
- **Ideas.** `corpus_id` is `stream_id` one level up. Qdrant scoping is *already built* — `store()` writes `stream_id` into every point payload (`pipeline.ts:478,501`), `searchMemoriesByUnit` filters on it (`qdrant.ts:213,258`). `findOrCreateSpeaker` (`entities.ts:87`, mig 046) is the exact anti-merge template. Corpus scope is a **predicate on the candidate set** fed to the pure planner (`loadPromotionInputs`, `promotion.ts:91-181`; lines 128-140 are the prior-entity candidate query inside it) — keeps order-independence.
- **Issues.** Resolution is globally unscoped in ~4 places; the sneaky one is `applyPromotion`'s mint-dedup SELECT (`promotion.ts:264-268`, name+type, no corpus) — the *idempotency* path, not "resolution." `createEntity` lock+dedup key (`entities.ts:246-256`) also global — as is the `loadPromotionInputs` prior-entity query (`promotion.ts:128-140`, scoped only by entityType + first-token `split_part`), whose word-prefix path (`promotion-plan.ts:416-426`) can resolve a code-entity handle to a rule-entity canonical id with *no* embedding threshold if their first tokens match (a `printf` function vs MISRA Rule 21.6). The **gardener is a second fusion path**: `merge_candidates` centroid detection (`003:40`) + `mergeEntities` (`entities.ts:708`) would merge a rule with a code symbol. Derived layers are global-compute (HDBSCAN `015`, `graph_stats` singleton `013:53`), and `contradictions.opposing_object` (`011`) would misread a code-vs-rule disagreement as a contradiction to auto-resolve rather than a finding.
- **Resolutions.** `corpus_id TEXT NOT NULL DEFAULT 'default'` on instance tables (entities, facts, causal_events); derived inherit via owning entity. Guard `mergeEntities`/`merge_candidates` with same-corpus assertions — and add `corpus_id` to the `merge_candidates` table (`003:40`) *and* the `merge-scorer.ts` detection INSERT, since cross-corpus pairs enter the candidates table *before* any code-level `mergeEntities` guard is reached (the DB constraint is the last line of defence). Scope derived compute per-corpus (freeze the static corpus's clustering once; recluster only the active corpus). AGE stays one graph with a `corpus` node prop. **Do not partition** `fact_predicates`/`entity_types` (global ontology). **Do not overload** `stream_id` (orthogonal; `(default,user)` is the load-bearing SELF entity). Migration `public.`-qualified, applied manually (sequencing: `corpus_id` backfill is one `UPDATE … SET corpus_id = 'default'`, safe pre-deploy with `NOT NULL DEFAULT`; `bridge_edges`/audit tables are additive, apply after; rollback = drop `corpus_id` after verifying no non-default values).
- **Reuse/build.** Reuse: payload-filter scoping, anti-merge template, pure planner. Build: the column threaded through choke points + gardener guards + per-corpus derived compute.

### V.2 Bridge edges
- **Ideas / verdict.** **BUILD a dedicated `bridge_edges` table, REUSE the causal-edge pattern wholesale.** A `causal_edges` row is already the shape (reasoning+source_references NOT NULL @ `002:124`, `edge_source_refs`, history, soft-expiry, corroborate-or-insert, staleness flag, propose→promote disposer).
- **Issues.** Can't reuse `causal_edges` directly — its endpoints FK `causal_events` (fact *transitions*); code/rule are neither, and faking events breaks `traceCauses`/`projectTrajectory`. **Two-corpus-id problem is decisive:** a bridge spans two corpora, so a single `corpus_id` is structurally wrong; `source_corpus_id`+`target_corpus_id` would be NULL for 99% of causal edges → own table. The fact-with-analysis-predicate option is dead (no reasoning invariant; forces code/rule to *be* entities → exposed to >0.92 auto-merge).
- **Resolutions.** Dedicated `bridge_edges`: FK-to-canonical endpoints + type + immutable denormalized `source_corpus_id`/`target_corpus_id`; CHECK'd `relation` enum (`violates|satisfies|not_applicable` — **`not_applicable` is first-class**, distinct from "nobody looked yet" = no row; the "satisfied nowhere" anti-join excludes it); GROUP-BY columns (`severity`, `category`, groupable `code_location`). **Staleness solved verbatim** by `stale_citation` (`044_causal_pass.sql:60-62`) + `cascadeFactExpiry`/`findEdgesCitingReference` (`causal.ts:568-620,1101-1120`) — code changes → flag, never auto-repoint. Write via staging + pure `planBridgePromotion`; dedup key `(source_element_id, target_rule_id, relation) WHERE expired_at IS NULL` (mirrors `037_fact_triple_unique`). **`source_element_id`** is the canonical name for the code-side endpoint id — used consistently here and in `audit_coverage` (V.5 currently calls it `element_ref`; unify on one).
- **Reuse/build.** Reuse: the entire causal-edge pattern. Build: the table family (+ staging, planner, reverse index, history).

### V.3 Construct tagging + recall
- **Ideas.** Code and standard are **asymmetric**. Code constructs are syntactic facts with ground truth → **parser** (tree-sitter / clang-tidy matchers), deterministic, conf 1.0. Standard side has no parser but the rule set is tiny/fixed → **LLM-tag each rule once, offline** (zero per-audit cost). A "construct" models as a `fact_predicates`-style vocabulary row; the symbolic join is a **plain SQL equality join** (`element_constructs ⋈ rule_constructs`). Semantic half needs a NEW artifact: **verbalize code behaviour into rule-shaped NL and embed it** in one space with verbalized rule text (`behaviour_summaries`, not synthetic facts).
- **Issues.** Cold-start floor = genuinely semantic rules with no AST node — but **MISRA's own decidability classification predicts which rules the symbolic join misses** → router. Prefix-alignment (symmetric vs `search_document:`/`search_query:`) untested → recall side-test. Only tag what the parser can decide; dataflow-derived constructs are semantic candidates. Multi-language: taxonomy is per-language-family/per-standard.
- **Resolutions (reconciled with V.6 prior art).** Don't hand-roll a parser — integrate existing tooling (tree-sitter/SCIP for structure/constructs) and consume **SARIF from CodeQL** as ground-truth seed edges for decidable rules; reserve LLM construct/behaviour work for the undecidable remainder.
- **Reuse/build.** ~70% reuse (content-mode plumbing, `fact_predicates`→`constructs`, predicate-normalization fold, additive link-table discipline, recall side-test protocol). Build: code-graph tooling integration + SARIF importer + the `constructs`/link tables + behaviour-verbalization recipe.

### V.4 MCP surface + write-guidance
- **Ideas.** **External agent self-adjudicates; Mnemo stores the verdict** (Part I.5) — and the surface gives the agent genuine *agency*, not just an audit runner (Part I.8). Lead with strong **read/explore** tools (search, traverse, read existing connections) so the agent can reason *over* the graph and spot non-obvious links, plus a **write** tool it can call *any time it has something to assert*, not only inside a scripted loop. A **~8-tool workflow-shaped surface:** `ingest_corpus → search_corpus → traverse → find_candidates → assert_connection → query_connections → get_ref` (+ `audit_status` for the coverage-tracked sweep), each description leading with when-to-use, the rest behind tool-search. `assert_connection` covers cross-corpus bridges, within-corpus edges, and higher-order links alike — all requiring reasoning + provenance, so a free-exploration insight is as auditable as a swept one.
- **Issues.** No corpus/namespace anywhere (biggest blocker; = V.1). External `mcp-server/` DEAD (endpoints 404, empty inputSchemas `index.ts:42-51`, personal-memory framing) — only transport shell salvageable. Internal `graph-mcp.ts` declares `capabilities:{tools:{}}` only (`:35`) — no `instructions`/`resources`/`prompts`; its 49 descriptions assume the pipeline prompt vocabulary (exposing verbatim is harmful). No read-only annotations → confirm-prompt per read. Guidance channel is a finite `content_type` switch (`graph_agent.py:762-777`), no free-text field.
- **Resolutions.** Stamp a `corpus` tag beside `stream_id`; keep the dead server's shell, discard its endpoints/tools, add the ~8 audit tools over thin corpus-scoped HTTP routes (do **not** passthrough `graph-mcp.ts`). Fill the three teaching primitives — `instructions` (mental model + corpus vocab + bridge golden rules), `resources` (schema/rule cookbook; the code addenda at `graph_agent.py:588-642` are ready-made glossaries), an `audit_playbook` prompt, `readOnlyHint` on reads. Persist a `guidance_tag` on the bridge (guidance-as-data). Write discipline: a **staging-only `audit_agent` actor** whose bridge writes flow through `handleToolCall → writeQueue → promote()` (serialization/audit/error-mapping inherited). *Build prerequisites, not yet implemented:* add `audit_agent` to `VALID_ACTORS` (`causal-agent.ts:1402-1406`) + the staging-only CHECK (mig 009, same carve-out as `extraction_proposer`) + `ACTOR_TOOL_ALLOWLIST`. The audit HTTP route **must derive the actor from the route, never accept it as a client body param** — today `pi-agent-bridge.ts` *validates* actor values but does not *pin* them (allowlist-gating ≠ anti-spoof).
- **Reuse/build.** Reuse: transport shell, actor-scoping, write-serialization, error mapping. Build: the ~8 tools + routes, the three teaching primitives, the `audit_agent` actor.

### V.5 Cross-session orchestration
- **Ideas.** The one genuinely new artifact is a **coverage matrix**: `(run_id × code element × rule → verdict)`. An audit asks a 2-D question ingest never did. It also **makes compliance visible / closes the code-up blind spot**: a `no-violation-found` verdict is a *real row*, pending cells are *pending rows* — so "what's left" and "which rules satisfied nowhere" become queryable. `audit_coverage` is the *enumeration/tracking* surface over `bridge_edges` — it records which `(element, rule)` cells still need adjudication and FK-links the resulting bridge via a nullable `edge_id`; `bridge_edges` rows remain the primary product (Part I.2).
- **What exists.** `ingest_jobs`/`ingest_sub_batches` (self-ensured `ingest-ledger.ts:78`; resume-by-name + `corpus_hash` `:133-166`; `nextPendingSubBatch` `:202`; pause/fail split `:247-266`); resumable driver (`ingest-resumable.ts:148-222`); `invocation_id` (mig 034, per-HTTP-call); `windowPointId` + corroborate-or-insert (`causal.ts:241-301`) = idempotency floor already holds.
- **Issues.** No agent-facing session/run abstraction (ledger is driver-owned; `actor` is a *type* not an instance). Audit resumability is a matrix, not linear; `status=done` too coarse; seq pattern over-constrains. Continuity wrong-shaped: `extract()` threads only the latest report; `get_reasoning_history` is *entity-scoped*, but a resuming audit agent has a *run + position*. Reports/edges are run-blind.
- **Resolutions.** `audit_runs` (near-copy of `ingest_jobs`, self-ensured, + `rule_set_hash`); `audit_coverage` (run_id × element_ref × rule_id, `verdict` enum, nullable `edge_id`, `invocation_id`, UNIQUE key, deterministic `uuidV5(RUN_NS,"run:element:rule")` — where **`element_ref` is the deterministic code-graph node id (AST-hash / SCIP symbol id), not the canonical entity UUID**, so the key is stable across graph mutations; carry-forward on re-audit is unresolved, see IX.5); `nextPendingAuditUnit` filters `verdict='pending'`; nullable `run_id` on `reasoning_reports` (partial index like `invocation_id`) + run-scoped `get_audit_run_history`; expose `start_or_resume_audit_run`/`get_audit_run` as MCP tools so the *agent* owns resumption. Coverage is a *cost* optimization on an idempotency floor that already holds.
- **Reuse/build.** Reuse: job/resume pattern, `to_regclass` self-ensure, session-limit loop, `invocation_id` threading, corroborate-or-insert. Build: `audit_runs`, `audit_coverage`, `nextPendingAuditUnit`, run-scoped history, `run_id` threading.

### V.6 Prior art & positioning
- **Reuse (don't reinvent):** GitHub **CodeQL Coding Standards** — reference impl of MISRA/CERT/AUTOSAR as queries, already encodes MISRA-Compliance:2020 machine-readably (recategorizations, deviations, category reports). **CWE** ships versioned XML+XSD that maps onto a KG. **MISRA structured attributes** (category, **decidability**, scope, directive?) usable via **CodeQL Coding Standards (MIT-licensed)**; the prose rule text needs a MISRA license, so behaviour-verbalization (V.3) must be grounded in CodeQL query intent + structured metadata unless a MISRA license is confirmed in place. **SARIF 2.1.0** = import/export adapter w/ CWE taxonomies. Build the code side **deterministically** (tree-sitter/SCIP/CodeQL; Codebase-Memory shows persistent tree-sitter graph over MCP at 83% quality / 10× fewer tokens). LLM+analyzer division settled: **detect deterministically, LLM reasons/triages** (IRIS +35% over CodeQL alone; LLM-triage F1 0.91-0.95 vs 0.10-0.55). Requirements→code traceability is the same problem (LiSSA retrieve-then-judge; ReqToCode = durable trace links).
- **Genuinely novel:** the durable, reasoned, versioned bridge edge across *heterogeneous* graphs (alignment research assumes same entities); coverage of undecidable rules/directives; reasoned `not_applicable` edges; one graph spanning standards (cross-refs → one verdict lights up related rules).
- **Pitfalls:** candidate explosion / precision collapse → gate by decidability; hallucinated mappings (1.8-10.3%/project) — two sub-types: (a) hallucinated entity/rule *ids* → caught by FK validation at disposal; (b) hallucinated *reasoning* about a real entity (valid FKs, wrong attribution) → NOT caught by any structural check → needs commit/AST-hash + model-version anchoring (to enable re-run) + human review in iteration one; FK validation is not a mitigation for (b); drift (code + model) → anchor to commit/AST-hash + model version, invalidate on change; undecidability ceiling → never "compliant"; cost at scale → conditional trigger + deterministic pre-filter + Haiku-first.

---

## Part VI — Cross-cutting convergences (high-confidence)

Reached independently by multiple investigators:
- **`corpus` = the `stream_id` pattern one level up** (V.1, V.4) — no new store, no second graph.
- **An "audit run" is the scoping/resumption primitive** (V.2 as staging partition key, V.5 as resumable job) — near-copy of `ingest_jobs`.
- **Reuse the causal-edge pattern in a *separate* `bridge_edges` table; propose→promote is the right write discipline for `bridge_edges` findings** (V.2, V.4, V.5) — reproducibility + idempotent re-audit + graceful handling of hallucinated ids at disposal. (The `audit_coverage` write discipline is *not* settled — IX.3: whether a `no-violation` cell always emits a bridge row or is written directly.)
- **Decidability routes everything** (V.3 recall router, V.6 deterministic-vs-LLM split).
- **Build code structure deterministically, not with the LLM** — reconciles the one investigator disagreement (integrate existing tooling; don't hand-roll a parser).

---

## Part VII — Hard problems remaining (honest)

1. **Cold-start recall for undecidable rules** — the symbolic join returns nothing for them by definition; recall rests on semantic matching + LLM. Decidability routing *contains* this (you know which rules are affected) but doesn't *solve* it. The genuine quality floor.
2. **Hallucination** — an external LLM will confidently cite lines/ids that don't do what it claims. Structural mitigation (ground in the deterministic code graph; validate existence), not promptable-away.
3. **Behaviour↔rule embedding alignment** — an untested bet requiring a recall side-test (like the memories 0.38→0.75 test). *Acceptance bar:* a hand-labelled sample of ≥50 code-element × undecidable-rule pairs from a real MISRA C codebase; require ≥0.65 recall@5 before the semantic path ships; use CodeQL Coding Standards SARIF as the ground-truth comparator for decidable rules; human expert review as final arbiter for LLM-reasoned bridges in iteration one.
4. **Model + code drift vs. reproducibility** — solvable via commit/AST + model-version anchoring, but real schema+process work.
5. **Deterministic-tooling integration scope** — CodeQL/tree-sitter/SCIP + SARIF is the largest net-new engineering and partly lives outside Mnemo.
6. **Code-up coverage of absence rules** — largely addressed by the coverage matrix (pending/no-violation cells), but rules about what's *missing* may still want a rules-down completeness pass.

---

## Part VIII — Reuse-vs-build ledger (consolidated)

**Reuse (built, verified):** propose→promote single-writer + pure planners; `causal_edges` traceability invariant + `edge_source_refs` + history + `stale_citation` + `cascadeFactExpiry`; corroborate-or-insert dedup; `stream_id` payload-filter scoping; `findOrCreateSpeaker` anti-merge; `ingest_jobs`/`ingest_sub_batches` + `to_regclass` self-ensure + resumable driver + pause/fail split; `invocation_id` threading; `windowPointId`/`uuidV5` determinism; `fact_predicates` normalization; the dead server's transport shell; Haiku-first + conditional-agent patterns.

**Build (net-new):** `corpus` scope tag (threaded through resolution choke points + gardener guards + per-corpus derived compute); `bridge_edges` table family (+ staging, `planBridgePromotion`, reverse index, history); `constructs` + `element_constructs` + `rule_constructs` + join; `behaviour_summaries` verbalization + embedding recipe; `audit_runs` + `audit_coverage` + `nextPendingAuditUnit` + run-scoped history + `run_id` threading; the ~8-tool corpus-aware external MCP + three teaching primitives + `audit_agent` actor; **deterministic tooling integration (tree-sitter/SCIP/CodeQL) + SARIF importer** (largest piece, partly external).

**Phase sequencing.** Phase A = `corpus_id` column + gardener guards + `bridge_edges` table family (end-to-end write→query→expire, testable with hand-seeded data, no external tool). Phase B = deterministic-tooling integration + SARIF importer (largest external dependency; fakeable with hand-crafted SARIF during A). Phase C = MCP surface + `audit_runs`/`audit_coverage` + `audit_agent` actor. **Phase gate after A:** the `bridge_edges` round-trip must pass before committing to CodeQL integration.

---

## Part IX — Open questions for the design phase

The general framing (Part 0) resolves or reframes several of these:

1. **Bridge-endpoint resolution — [reframed, likely resolved].** Generally, corpus elements are canonical entities resolved *within* their corpus (corpus-scoped, so the 0.92 auto-merge is safe — it never crosses corpora). "Deterministically-built code entities that bypass resolution" was a code-adapter optimization, not the general rule. Lean: corpus-scoped resolution for all domains; deterministic build is an optional code-adapter shortcut.
2. **Coverage vs bridges — [reframed].** Generally `bridge_edges` hold *asserted relations*; the coverage matrix (rename → `comparison_coverage`) enumerates which (source × reference) cells have been checked. "Checked, no relation found" is usually coverage-only, not a durable edge — but a domain may assert a "no-relation" bridge if that claim carries value (compliance's `satisfies` does; fiction rarely would).
3. **Re-comparison carry-forward** — new `run_id` copying unchanged verdicts vs. JOIN-at-report-time. Domain-agnostic; still open.
4. **Calibration / recall side-test** — per-domain; code is first because it's the only domain with a deterministic oracle to calibrate against.
5. **Consumer — [answered]:** MCP now; a web UI is a plausible later consumer. SARIF *export* is a code-adapter-only output, not core.
6. **One vs many reference corpora — [dissolved]:** the architecture is N-corpora native — "MISRA-only vs multi-standard" is just data, not a design decision. Reference↔reference bridges (e.g. CWE↔CERT, or paper↔paper) use the same mechanism. (Phasing still validates on code first — Part I.7d.)
7. **Code-adapter specifics (live in the adapter, not the core):** how far to lean on CodeQL/SARIF vs. a lighter tree-sitter pass; the behaviour-verbalization prefix scheme; MISRA prose licensing.

---

## Appendix — Sources & working notes

**External sources:** github.com/github/codeql-coding-standards · cwe.mitre.org/data/xsd/cwe_schema_v7.2.xsd · misra.org.uk MISRA-Compliance-2020 · docs.oasis-open.org/sarif · arXiv 2405.17238 (IRIS) · 2603.27277 (Codebase-Memory) · 2601.08773 (AST-vs-LLM KG) · 2603.13999 (ReqToCode) · LiSSA (ICSE 2025).

**Related in-repo docs:** `truth-graph/30-mcp-transport.md`, `39-natural-language-graph-querying.md`, `38-graph-anchored-fallback-retrieval.md`, `41-epoch-v2-design.md`, `07-graph-agent-workflow.md`, `34-architectural-principles.md`, `architecture/multi-source-processing.md`.

**Working notes (scratchpad, ephemeral):** `understanding-00..04`, `research-05`, `investigate-00..06` — the underlying detail behind this consolidation.
