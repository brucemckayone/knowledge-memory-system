# Appendix 7 — the iOS surface (being stripped) and the MCP tool surface (kept)

**The iOS surface is being removed** by user decision — it arrived via branch-management pull-over from
`feat/ios-api-v1` and is not part of this direction. It is recorded here because (a) two things in it are
worth extracting before deletion, (b) its analysis of *what the product actually demanded of the graph*
is the clearest statement anywhere of which engine features were earning their keep, and (c) the MCP
half of this survey is **kept** and load-bearing.

**Provenance.** `ee4d4cf` (2026-06-23) added 1,458 lines across 10 files with **zero tests**. `cc3d305`
(2026-07-09) added +53. Migration `049` **predates** `052_corpus_scoping.sql` — the iOS surface was
written before corpus partitioning existed and was never revisited.

---

## 1. Two things to extract before deleting

**1.1 Source-traced synthesis spans (`voice-c-composer.ts`, ~80 lines, zero deps).**
`composeVoiceC(parts)` takes `VoiceCPart[]` where each part is `{phrase, source?}`, concatenates with
single spaces (suppressing the space before leading punctuation) and records each sourced phrase's
**UTF-16 code-unit offset** in the final string. Output: `{text, annotations:[{start, end, source:{type,
id}}]}`, source types `memory | entity | event | fact | pulled_line`.

**This is grounded synthesis with provenance, and it is the only implementation in the repo.** Any clause
can be traced back to the entity/fact/event that justified it — exactly what "knowledge synthesis" needs.
Two load-bearing invariants come with it:

1. **Multi-sentence guard** — if the composed text has more than one sentence and `annotations` is empty,
   it **throws**. Sentence test is `/[.!?…]+\s+\S/g`.
2. **Non-empty span** — a sourced part with an empty phrase throws, so `start < end` always holds.

**1.2 The `assertVoiceC` lint as a pattern.** Not the specific rules (a lowercase-only, 15-forbidden-verb,
8-forbidden-modifier, 5-system-self-reference persona guard), but the *shape*: a deterministic, testable
gate on generated prose, prefix-anchored word-boundary regex, deliberately over-broad. If an LLM ever
composes user-facing prose here, this is the only defence that does not itself require a model.

---

## 2. What the product actually demanded of the graph

The analytically useful part. Ranked by how load-bearing each capability was.

**Load-bearing (the product broke without it):**

1. **Entity identity + canonical name.** Every hero field routed through it.
2. **1-hop traversal.** `getSubgraph([seedId], {maxDepth:1, limit:20})` produced the home-screen
   constellation. The single most product-visible graph feature.
3. **2-hop traversal, degraded to a count.** A depth-2 subgraph minus the 1-hop set became
   `secondDegreeStubs` — ids plus a `directionHint` derived from **hashing the UUID**. A heavy way to
   compute a cardinality.
4. **Provenance / source references.** The whole span-attribution mechanism (§1.1) exists to deep-link
   prose back to the graph. The one place the engine's traceability discipline was directly visible.
5. **Contradiction detection.** The only populated notification kind. Needs `(subject, predicate, object)`
   triples, the `expired_at IS NULL AND invalid_at IS NULL` active-fact predicate, and the
   `fact_predicates.is_exclusive` registry to suppress supersession-handled collisions.
6. **Confidence — but only as a severity bucket.** `GREATEST(f1.confidence, f2.confidence) >= 0.8 →
   'high' else 'medium'`. **That single threshold was confidence's only product consumer.**
7. **`entity_meta` counters** → `entriesCount`, `isNewThisMonth`. Cheap denormalised counts, not graph
   reasoning.
8. **Speaker/stream identity.** `getSelfEntity()` via the `stream_participants('default','user')` join;
   `pipeline.ts` force-links the self entity to every default-stream memory so `entriesCount > 0` for
   bare first-person text.

**Consumed but thin:**

9. **Topology / articulation points** → one boolean per node. The only structural analytic the product
   read, and a **precomputed batch artifact** requiring a manual `POST /api/topology/compute`. On a fresh
   graph it is absent and the code **silently degrades to `false`** — a dependency on a manually-triggered
   pipeline stage with no freshness signal on the wire.

**Demanded by the design, NOT delivered:**

10. **Entity descriptions / living summaries.** `hero.ts:169-170` comments *"Prefer the agent-authored
    summary if present"* — **but the code at `:173` unconditionally calls the deterministic
    `summarizeEntity()`.** `profile.summary` is fetched and thrown away. Neighbour summaries are worse:
    a map is built and **every value set to `null`**, so `HeroNeighbor.summary` is always null by
    construction. The `update_entity_summary` tool, the gardener's summary pass and the whole
    living-summary apparatus had **zero product consumers.**
11. **The `offer`** — the question that would make the hero conversational. Hardcoded `null`.

**NOT consumed at all:**

12. **Bi-temporal facts.** No wire field carried `valid_at`/`valid_to`/`expired_at`/`invalid_at`.
    Bi-temporality was used *internally* by contradiction detection, but the product read **counts of
    facts**, never fact content or fact time.
13. **Predicates / the predicate ontology.** `getSubgraph` returns `GraphEdge.type` and `hero.ts:204`
    **discards it** — `HeroEdge` is `{fromEntityId, toEntityId, strength}`. **The entire
    predicate-canonicalisation, inverse-predicate and exclusive-group machinery was invisible to the
    product.**
14. **Edge weights.** `edgeStrength` and `strength` **hardcoded `1.0`** with the comment *"The AGE
    subgraph carries no per-edge weight in v1"*. The route's `clamp01` guards a literal constant.
15. **Causal chains (Graph C).** No product endpoint touched `causal_events`, `causal_edges`,
    `trace_causes`, `project_trajectory`, patterns or ghosts. **The entire causal layer — including the
    mandatory `reasoning` + `source_references` traceability CLAUDE.md calls non-negotiable — had no
    product consumer.** The `contradiction_type` values `cyclic_causal` and `chain_conflict` could have
    surfaced causally-derived cards; the composer only handles the generic case and never inspects the
    type.
16. **Semantic / vector recall.** Neither hero nor notifications embedded or searched. Qdrant served
    `recentMemories` in `getEntityProfile`, which hero fetched and discarded.
17. **Merge candidates, same_as links, drift, clustering, cross-cluster, reasoning reports, blast radius,
    patterns, aliases.** All have HTTP endpoints; none was read by the iOS surface.

**The blunt summary:** the product consumed *entity identity + 1-hop shape + counters + one boolean +
contradiction pairs + confidence-as-severity*. **The features carrying the most engine complexity —
bi-temporal fact semantics, the predicate ontology, the causal layer, entity descriptions, vector recall
— were either unconsumed or fetched-then-discarded.** Entity descriptions are the one unconsumed
capability the code was visibly written to consume, which made it the cheapest thing to start earning its
keep — and it is now blocker 3 in the keep list.

---

## 3. The lost spec

**Neither `_research/backend-asks.md` (the ASK-### register) nor `design/03-home.md` exists in the working
tree, and neither appears anywhere in 850 commits.** Neither is gitignored — they were simply never added.
**The wire contract's source of truth is lost.** The only surviving record is code comments:

| ID | cited at | what the code says it requires | state |
|---|---|---|---|
| ASK-005 | `voice-c-composer.ts:5`, `hero.ts:22,170,220` | The **Voice-C persona** — richer LLM-composed summary and the hero `offer`. Explicitly deferred: *"There is NO LLM call in v1"*; `offer: null` hardcoded | DESIGNED-ONLY; deterministic floor shipped instead |
| ASK-006 | `entities.ts:24,102,172`, `pipeline.ts:584`, `049:57-84` | A **SELF entity** = the default-stream USER speaker. Canonical key is the `(stream_id='default', speaker_key='user')` join, with `properties->>'is_self'` as a confirmation flag. Bootstrapped implicitly on first ingest so capture works offline | BUILT |
| ASK-009 | `voice-c-composer.ts:5` | **UTF-16 annotation spans** — `{start, end, source:{type,id}}` in UTF-16 code units, `0 <= start < end`. Node's `String.length`/`indexOf` are natively UTF-16, so no conversion needed | BUILT |
| ASK-016 | `index.ts:104` | **iOS capture context** — optional `context{seed_entity_id, walk_session_id, walk_question_id, onboarding_prompt_id, shared_url}` on ingest. Only `onboarding_prompt_id` pinned as must-not-drop | PARTIAL — `onboarding_prompt_id` is folded into the `source` string; **the other four are silently discarded** |
| ASK-017 | `hero.ts:2`, `routes/hero.ts:2` | **`GET /api/hero`** — the pinned home-screen payload shape | BUILT (deterministic floor) |
| ASK-018 | `notifications.ts:2,15,85` | **`GET /api/notifications`** — four card kinds; backend owns composition/dismissal/age-out; iOS owns selection/sort/4-card cap; `kind === target.type` | PARTIAL — **1 of 4 kinds** |

An unnumbered "G4" constraint is also cited: for a contradiction card, `target.type = "contradiction"` and
`target.targetId` = the contradiction record id.

**Notification kinds:** `contradiction` **BUILT** (fixed copy, idempotent upsert on
`notification_id = "contradiction:<id>"`, age-out stamps `dismissed_at` when the backing contradiction
leaves the active set, re-detection re-activates by nulling it). `letter` / `walk` / `promise`
**DESIGNED-ONLY** — no composer, no writer; `due_at` exists and is serialized but **no code path ever
writes it**.

**Two divergent implementations of the same endpoint.** `services/notifications.ts:68`
`listActiveNotifications()` handles all four kinds and is **dead code** — no reference anywhere.
`routes/notifications.ts` re-implements the read hardcoded to `kind === 'contradiction'` with its own
duplicate DTO type. The service file is the wider contract; only the route is wired.

**Contract gap:** the schema and migration both say the *client* dismisses a card by stamping
`dismissed_at`; `services/notifications.ts:6-8` says the opposite (*"no user dismiss per design"*). There
is **no dismiss endpoint**.

**Side effect worth knowing:** `GET /api/notifications` is a **write endpoint** — it composes, upserts and
age-outs on every GET, with N+1 entity lookups inside the loop.

---

## 4. Multi-graph readiness of the product surface

**Verdict: single-graph by construction. It would not merely leak across graphs — it has no place to put
a graph identifier.**

Corpus-mention counts: `hero.ts` 0 · `notifications.ts` 0 · `routes/hero.ts` 0 ·
`routes/notifications.ts` 0 · `entity-profile.ts` 0 · `graph.ts` 0 · `topology.ts` 0 ·
`contradictions.ts` **1** (detection JOIN only) · `entities.ts` 11.

1. **No endpoint takes a graph/corpus parameter.** `/api/hero` accepts exactly `nodeId`;
   `/api/notifications` accepts `limit`. The only corpus-aware HTTP surfaces in the whole app are
   `/api/viz/corpora`, `/api/viz/unified?corpus=`, and `/api/audit`.
2. **Auth binds nothing.** A single shared static bearer token, scoped to `/api/*` only. No user identity,
   no tenant, no graph claim. And `POST /ingest` — the capture path — sits **outside `/api/*` by
   deliberate design**, so it is **unauthenticated regardless of `AUTH_REQUIRED`**.
3. **The self entity is globally unique.** `getSelfEntity()` matches `stream_participants` on
   `(stream_id='default', speaker_key='user')` with `.limit(1)`; that table has no corpus column. With
   several graphs there is exactly one resolvable self, arbitrarily chosen, and `LIMIT 1` makes the choice
   nondeterministic.
4. **AGE traversal cannot be partitioned.** `getSubgraph` issues raw Cypher against the single named graph
   `'knowledge_graph'`; AGE nodes carry `entity_id`, `name`, `type` — **no corpus property** — so hero
   traversal walks every graph's edges at once. **The hardest gap: not a missing WHERE clause but a
   missing node property**, and per CLAUDE.md AGE edge `SET` does not persist, so backfilling is not a
   one-liner.
5. **Derived tables have no corpus column.** Migration 052 scoped exactly four tables. **Not**
   `entity_topology`, `entity_meta`, `contradictions`, `notification_cards`, `capture_idempotency`, or
   `stream_participants`.
6. **The contradiction read path drops the partition the write path enforces.** Detection correctly
   requires `f1.corpus_id = f2.corpus_id`; `getContradictions` has **no corpus predicate and no corpus
   option**. So `/api/notifications` served cards for every graph indiscriminately — **the
   write-guarded / read-unguarded asymmetry visible in one file.**
7. **Idempotency keys share one namespace.** `capture_idempotency.idempotency_key` is the primary key.
   Two graphs generating the same client key collide, and the second ingest returns **the first graph's
   `memory_id`** with `202 idempotent:true` — a silent cross-graph data confusion, not an error.
8. **`/api/viz/clear` and `/api/reset` wipe everything** — unpredicated `DELETE FROM` over 19 tables.

**Rough sizing if it were ever revived:** a graph param + auth binding at the edge; `corpus_id` on ~6 more
tables; a corpus option threaded through `getContradictions`, `getEntityProfile`, `getSelfEntity`,
articulation flags; and — the real cost — either a corpus property on AGE nodes with a corpus-filtered
Cypher rewrite, or one AGE graph per corpus. Qdrant's `stream_id` partitioning is a separate axis that
does not align.

---

## 5. The MCP tool surface — KEPT

`platform/src/services/graph-mcp.ts` (83 lines) is a thin stdio MCP server, `mnemo-graph` v2.0.0, spawned
**once per actor** with `MNEMO_AGENT_ACTOR` fixed in env, so the advertised surface is constant for the
process lifetime. Two enforcement points:

- `ListTools` filters `GRAPH_TOOLS` by `allowlistFor(actor)`
- `handleToolCall` **re-checks** and throws on an off-list call — defence in depth, transport-independent

Deliberately **not** relying on Claude Code's `--allowedTools`, which is a wildcard
`mcp__mnemo-graph__*`. Errors map known SQLSTATEs (23505/23503/23514/40001/40P01) to actionable recovery
instructions. Write tools serialise through a fail-open queue. There is **no `causal-mcp.ts`** — the
causal tools were folded into the unified server; `platform/.causal-mcp-config.json` is a leftover. A
second transport exists: `pi-agent-bridge.ts:484` `POST /run`, sharing `handleToolCall` and therefore the
same allowlist.

**50 tools.** Actor surfaces: **LEG** = `graph_agent`/`reasoning_agent`/`gardener_agent`/`user`/
`system_trigger`/`cascade`/`promotion` · **PROP** = `extraction_proposer` · **ARB** =
`reconciliation_agent` · **CAU** = `causal_agent` · **AUD** = `audit_agent`. All five hold every read tool.

**27 read tools, all actors:** `query_entity_facts`, `query_entity_neighbours`,
`search_similar_entities`, `search_memories`, `recall_via_graph`, `get_memory_text`,
`get_causal_history`, `trace_causes`, `project_trajectory`, `get_causal_delta`, `get_fact_source`,
`get_entity_sources`, `search_entity_aliases`, `search_predicates`, `get_graph_topology`,
`get_neighbourhood_profile`, `get_reasoning_targets`, `get_reasoning_history`, `get_fact_history`,
`get_edge_history`, `get_contradictions`, `analyze_blast_radius`, `get_active_patterns`,
`find_causal_ghosts`, `get_pattern_instances`, `resolve_anchor`, plus `get_reconciliation_context`
(LEG/PROP/CAU/AUD — **not** ARB, subsumed by a pushed dossier).

**14 canonical writes, LEG only:** `resolve_entity`, `create_fact`, `link_entity_to_memory`,
`add_entity_alias`, `update_entity_summary`, `expire_fact`, `invalidate_fact`, `update_fact_confidence`,
`restore_fact`, `expire_causal_edge`, `revise_causal_edge`, `create_contradiction` (additionally gated at
runtime to `reasoning_agent`/`user`), `resolve_candidate`, `save_reasoning_report`.

**3 RETIRED — no actor holds them:** `execute_merge`, `create_same_as_link`, `resolve_contradiction`.
`create_causal_edge` was deleted from `GRAPH_TOOLS` entirely in E7.

**5 staging writes:** `propose_entity` (PROP, LEG), `propose_fact` (PROP, LEG),
`propose_identity_verdict` (**ARB only**), `propose_conflict_resolution` (**ARB only**),
`propose_causal_edge` (CAU, LEG), `propose_bridge_edge` (AUD, LEG).

### 5.1 Assessment: strong on capability, absent on scope

**As a read/write posture control it is genuinely strong** — better than most:

- Derived from a per-tool `mutates` flag so it cannot silently drift, with a startup assertion that every
  tool carries the flag.
- **Deny-by-default on drift:** an unknown actor falls back to `PROPOSER_SURFACE`, the most restrictive
  functioning set.
- Enforced at both transports and independent of prompt content — "the extraction proposer cannot write
  canonical" is a property of the tool set, not of a prompt.
- **The audit test is unusually well built.** It deliberately **breaks the circular oracle**:
  `CANONICAL_WRITES` is a hardcoded literal, *not* derived from `mutates`, and it pins the entire mutating
  surface as `{canonical writes} ⊎ {propose/verdict}`. A write tool mislabelled `mutates:false` would
  otherwise slip into the "reads are a safe superset" allowance undetected. **Keep this pattern.**

**But it has no scope dimension at all:**

1. **`ACTOR_TOOL_ALLOWLIST` is `Record<Actor, ReadonlySet<string>>`** — a set of **tool name strings**.
   There is no data-scope dimension in the type.
2. **Corpus scope arrives via a parallel, unenforced channel.** `ToolCallContext.corpusId` is documented
   *"INJECTED BY THE HARNESS (env `MNEMO_CORPUS_ID`), never by the agent"*. **The allowlist never consults
   it.** Two actors on the same surface with different corpora are indistinguishable to it.
3. **Exactly one tool honours the injected corpus.** `resolve_anchor` scopes to
   `context.corpusId ?? 'default'`. Its own comment explains why: without it, an agent extracting corpus B
   anchors to a same-named corpus-A entity, and promotion then writes a cross-boundary fact — rejected by
   migration 052's composite FK. **So today the corpus boundary is enforced by a Postgres FK, not by the
   access-control layer. That FK is the real guard; the allowlist contributes nothing to it.**
4. **One tool lets the AGENT choose the corpus.** `search_similar_entities` takes `corpus_id` as an
   **agent-supplied input**, and its own description tells the agent to use it. Every actor holds it. So
   **any agent can read entities from any graph by naming it** — by design for the audit pass, but not
   scoped to `audit_agent`.
5. **The other 26 read tools have no corpus dimension at all.** An `audit_agent` scoped to corpus B can
   read corpus A's entire fact graph through any of them.

**Correct framing: the allowlist is a *capability* control (which verbs) with no *scope* control (which
rows).** It successfully implements "agents propose, deterministic code disposes". It does not and cannot
implement "this agent may only touch graph X". Under single-graph that is fine. For multi-graph the second
axis must be added, and the natural place is `ToolCallContext.corpusId` becoming mandatory and enforced
inside every read handler, or a per-corpus connection/schema — **not** a wider allowlist.

---

## 6. What this survey could not determine

- **The actual ASK register contents** — absent from all 850 commits. Everything above is reconstructed
  from code comments. ASKs 001-004, 007-008, 010-015 may not exist, or may live only in whatever tool
  produced the register.
- **The iOS client itself** — no Swift source in this repo. All claims about the decoder
  (`VoiceCComposition.fromBackend`, `multiSentenceWithoutAnnotations`, the closed enum, the 4-card cap,
  "no user dismiss") come from backend comments and are **unverified against real client code**.
- **Whether any iOS client ever called these endpoints** — no deployment config, no client logs, no
  integration test. The surface may never have been exercised.
- **The intended `letter` / `walk` / `promise` composition rules** — the patrols are named
  (*"promise ripening, contradiction patrol, letter/walk landing"*) but no spec or stub exists.
- **Whether `entity_topology` is populated in the live DB.** If empty, every hero `isArticulationPoint`
  was silently `false`.
- **Whether the "AGE has no corpus property" gap is fixable via node properties.** CLAUDE.md says AGE
  *node* properties work while *edge* `SET` silently drops. Whether a corpus property could be backfilled
  and filtered efficiently needs an empirical test.
- **The `getSubgraph` limit interaction.** `limit: 20` / `50` is applied to the *node* query before the
  edge query, so on a dense seed the neighbour set is silently truncated and `threadsCount` undercounts.
