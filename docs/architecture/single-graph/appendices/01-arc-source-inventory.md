# Appendix 1 — Arc source inventory (86 files + migrations 051–057)

Survey of `git diff 4d3c0b8..HEAD`, read-only. Reachability computed by BFS over real
`import … from` / `await import(` edges from `index.ts` / `pipeline.ts` / `scheduler.ts` / `routes/*`,
then hand-rechecked — the BFS counts type-only imports, which produced two false WIRED results that were
corrected (`audit-pass` reached `causal-agent` only via `import type`; the real edge is the dynamic
import at `index.ts:957`).

## Headline

**Corpus partitioning is built end-to-end in the service layer and has no production entry point.**
`index.ts:226` (`handleBatch`) never reads `corpusId` from the request body and never passes it to
`ingestBatch`, so every HTTP ingest lands in `corpus_id='default'`. `corpusId` is settable only by
in-process callers — the harnesses in `src/test/tools/`. Everything downstream (the audit pass, the
bridge family, element catalogs, concept layer, `corpus_policies`) is therefore reachable in production
only against a single `default` corpus, which is the one configuration in which it has nothing to do.

## Table 1 — Services

| FILE | what it does | WIRED / TEST-ONLY / INERT | K/P/D | why |
|---|---|---|---|---|
| `services/embed.ts` | `embedForWrite` (throws) vs `embedForQuery` (returns `[]`) — the PC8-1 fix | WIRED — `entities.ts:280`, `facts.ts:242`, `promotion.ts:238` | KEEP | Correct, general, one-purpose |
| `services/embed-text.ts` | Pure `entityEmbedTextFor` / `factEmbedTextFor` / `entityEmbedModeFromFlag` | WIRED — same three callers | KEEP | Pure + tested; both consumers neutered (Table 3) |
| `services/corpus-policy.ts` | `getCorpusPolicy` / `setCorpusPolicy` | **half-WIRED** — `getCorpusPolicy` at `promotion.ts:169`; `setCorpusPolicy` has **no non-test caller**, no HTTP route | PARK | `'comparative'` unreachable in production, so the D5 branch at `promotion-plan.ts:437` is dead. Adds a hard table dependency to `promote()` |
| `services/promotion.ts` | Deterministic epoch writer; arc added `corpusId` threading, corpus-scoped prior load + reuse-by-name, fact embeddings | WIRED — `pipeline.ts:1060` | KEEP | `:313-319` corpus-scoped; `loadPromotionInputs` word-prefix candidate set scoped at `:160` |
| `services/promotion-plan.ts` | Pure planner; arc added `mode: CorpusMode` (D5 escalation) | WIRED via `promotion.ts:37` | KEEP | `:534` hardcodes `summary: null` |
| `services/entities.ts` | `createEntity` / `findSimilarEntities` / `resolveEntity` / `mergeEntities`; arc added `corpusId` params, `embedForWrite`, pre-repoint fact dedup, bridge_edges re-point | WIRED | KEEP | `createEntity` dedup still global (`:250-257`) |
| `services/facts.ts` | `createFact` etc.; arc added `corpusId`, `factEmbedTextFor`, embed split | WIRED — `pipeline.ts` | KEEP | `searchFacts` is dead (Table 3) |
| `services/causal.ts` | `createCausalEdge` + `corroborationKey` ledger claim (mig 051) | WIRED | KEEP | The 051 idempotency fix is the correct pattern — a ledger, not a single slot |
| `services/causal-promotion.ts` | Passes `corroborationKey: p.stagedEdgeId` | WIRED — `causal-pass.ts:18` ← `pipeline.ts:1070` | KEEP | 6-line change closing a real count-drift bug |
| `services/causal-agent.ts` | MCP tool surface + agent invokers; arc added `propose_bridge_edge`, `audit_agent` actor + `AUDIT_SURFACE`, `corpus_id` on `search_similar_entities`, corpus-scoped `resolve_anchor`, `MNEMO_INVOCATION_ID`/`MNEMO_CORPUS_ID`, `invokeAuditAgent` | WIRED | KEEP | `resolve_anchor` (`:3189-3247`) is the one corpus-correct MCP tool; `resolve_entity`/`create_fact` are not (Table 4) |
| `services/audit.ts` | Adds `'audit_agent'` to the `Actor` union | WIRED (union member only) | KEEP | Deliberately absent from mig 009's actor CHECK — documented, no write path reaches it |
| `services/contradictions.ts` | Adds `f1.corpus_id = f2.corpus_id` to `detectOpposingObjects` | WIRED — `index.ts:1088` | KEEP | Only 1 of 4 detectors got it (Table 4) |
| `services/graph-meta.ts` | `detectMergeCandidates(entityIds, corpusId='default')` + eligibility join | WIRED but new param **INERT** — sole caller `pipeline.ts:700` passes no `corpusId` | KEEP (fix caller) | Epoch arm never calls it at all |
| `services/merge-scorer.ts` | `upsertScoredCandidates` stamps `merge_candidates.corpus_id` from entity A | WIRED via `graph-meta.ts:26` | KEEP | Small, correct; composite FK is the backstop |
| `services/ml-client.ts` | `firstBalancedJson` fallback in `generateJson` | WIRED | KEEP | Model-output robustness, no corpus coupling |
| `services/audit-pass.ts` | `runAuditPass`: cosine ∪ concept recall → seed coverage → per-cell LLM adjudication → `applyBridgePromotion` → stamp | WIRED — `index.ts:957` dynamic import | PARK | Cross-corpus audit product. `recallConceptCandidates` structurally inert (Table 3) |
| `services/audit-ledger.ts` | `audit_runs` / `audit_coverage` with `to_regclass`-guarded self-CREATE; resume-by-name | WIRED via `audit-pass.ts:39` | PARK | Self-ensuring DDL is deliberate and sound. `checker_unavailable` never written |
| `services/bridge-promotion.ts` | Pure `planBridgePromotion` + `applyBridgePromotion` | WIRED via `audit-pass.ts:50`, `catalogHas` at `causal-agent.ts:35` | KEEP | The "relate without fusing" primitive; needs Table 3/4 fixes first |
| `services/corpus-ingest.ts` | Corpus-scoped entity upsert on `(corpus_id, entity_type, properties->>'element_key')` + Haiku description + always `name_description` embed; `reembedCorpusDescriptions` | **TEST-ONLY** — importers: 1 test + 5 harnesses; zero service/route callers | PARK → fold into `createEntity` | The **only** code that writes a description-bearing corpus-scoped entity vector. Exists because `createEntity` dedups globally |
| `services/element-authoring.ts` | Blind facet/rule-description prompts | TEST-ONLY | PARK | Prompt assets. Silent-empty failure mode (Table 3) |
| `services/element-description.ts` | Pure `composeFacetedDescription` / `composeRuleDescription` / `detectRuleReferences` | TEST-ONLY | PARK | `detectRuleReferences` regexes (`:132-134`) match bare `1.5` / `5-1` — high false-positive rate |
| `services/element-catalogs.ts` | `uuidV5` element-ref resolvers, catalog upserts, `recallAcrossCorpus`, `recallByConcept` | **TEST-ONLY** — no service importer at all | DROP | Superseded by its own successor (mig 056 widened bridge endpoints to `'entity'`). All three tables empty in production |
| `services/concept-extraction.ts` | `findOrCreateConcept` into `_concepts` + stages `exhibits`/`addresses` bridges | **TEST-ONLY** | DROP (retrieval) / PARK (structure) | `_concepts` is a globally shared corpus. Inserts entities with NULL embedding, violating `embedForWrite` |
| `services/concept-resolution.ts` | Trigram candidates in `_concepts` + Haiku judge + `mergeEntities` | TEST-ONLY | DROP | — |
| `services/concept-multihop.ts` | Recursive-CTE multi-hop concept-mediated recall with IDF/decay | TEST-ONLY | DROP the mediation, **KEEP the CTE traversal** | Fact adjacency is genuinely corpus-scoped (`:110`, `:125`) — the one durable thing here |
| `db/schema.ts` | Drizzle decls for the arc tables + `corpusId` columns | WIRED | KEEP (prune) | Drop the element-catalog trio with `element-catalogs.ts` |
| `ml-services/app/audit_agent.py` | `POST /audit-agent` per-cell adjudication | WIRED — `main.py:104` | PARK | Emits **no `usage` echo** (unlike `gardener_agent.py:285`), so audit spend is invisible |
| `ml-services/app/main.py` | Registers the audit router | WIRED | KEEP | 3 lines |

## Table 2 — Migrations 051–057

| MIGRATION | schema | invariants | used by production? | K/P/D |
|---|---|---|---|---|
| `051_causal_corroboration_idempotency` | `causal_edge_corroborations(edge_id, corroboration_key)` PK, FK CASCADE | PK is the idempotency claim; nullable key preserves the legacy path | **YES** — `causal.ts:96-107` + `:353-361`, key from `causal-promotion.ts:135`, reached from `pipeline.ts:1070` | KEEP — the only fully-live arc migration |
| `052_corpus_scoping` | `corpus_id` on entities/facts/causal_events/merge_candidates + 3 indexes; `entities_id_corpus_uq`; composite FKs; `reject_corpus_id_change()` BEFORE-UPDATE trigger on 3 tables | Fact endpoints must live in the fact's corpus (MATCH SIMPLE skips NULL object); `corpus_id` immutable | **Partly.** Written by `promotion.ts:331/368`, `entities.ts:290`, `facts.ts:278` — but only ever `'default'`. **`causal_events.corpus_id` is written by nothing** — `mintCausalEvent` omits it | KEEP; the trigger + index guard a column no code sets |
| `053_element_catalogs` | `code_elements`, `rule_elements`, `element_embeddings` + HNSW | `UNIQUE(corpus_id, scheme, canonical_symbol)` — **`scheme` nullable, so NULL-scheme rows do not dedup** | **NO.** Written only by `element-catalogs.ts` (test-only). `bridge-promotion.ts:228-234` reads them for kinds production never produces (`audit_agent.py:50` pins `aKind="entity"`) | DROP |
| `054_bridge_edges` | `bridge_edges`, `staging_bridge_edges`, `bridge_source_refs` + 4 indexes | `reasoning` NOT NULL + non-blank; `source_references` must be a JSONB array with ≥1 element (both tables); partial-unique `(a_ref,b_ref,relation) WHERE expired_at IS NULL` | **YES** for the two bridge tables. **`bridge_source_refs` is write-only.** `code_location`, `source_commit`, `source_ast_hash`, `rule_set_hash`, `model_version` never written by any producer | KEEP `bridge_edges`; DROP the 5 anchor columns + `bridge_source_refs` until something reads it |
| `055_corpus_policies` | `corpus_policies(corpus_id PK, mode)`, seeds `default`=assimilating | `mode IN ('assimilating','comparative')` | **Read-only.** On the hot promote path (`promotion.ts:169`); no production writer | PARK — right shape, currently a constant |
| `056_bridge_entity_endpoints` | Widens `valid_bridge_kinds` + `valid_bridge_ref_type` to admit `'entity'` | wider CHECKs | **Kinds half superseded one migration later** — 057 drops and re-adds the identical vocabulary. The `ref_type` half survives and *is* needed (`bridge-promotion.ts:129`) | DROP the kinds half; fold `ref_type` into 054 |
| `057_concept_layer` | Seeds `_concepts` policy; widens kinds + both relation CHECKs (+`exhibits`,`addresses`) | 5-value relation vocabulary on canonical and staging | **Unreachable in production** — `propose_bridge_edge` hard-rejects anything but `violates|satisfies|not_applicable` at `causal-agent.ts:3466` | DROP with the concept layer |

## Table 3 — Dead or inert code

| FILE:LINE | what is inert | why | severity |
|---|---|---|---|
| `index.ts:226-251` | `handleBatch` never parses or forwards `corpusId` | `pipeline.ts:1204` accepts it and `:1216` even throws if set on a non-epoch arm — but the body type has no such field and the call omits it. **The mig-052 partition has no HTTP entry point.** | **CRITICAL** |
| `facts.ts:896-925` (`searchFacts`) | The only reader of `facts.fact_embedding` has **zero callers** | `grep -rn "searchFacts"` returns exactly one hit: its own definition. Two writers, one reader, no callers → the fact-vector layer is write-only, and `EMBED_DESCRIPTIONS`'s stated purpose (b) feeds a column nothing reads | **CRITICAL** |
| `promotion-plan.ts:534` + `promotion.ts:238` | `EMBED_DESCRIPTIONS` is a no-op for entity vectors | `summary: null` is the **only** push in the file. `entityEmbedTextFor` returns the bare name on a blank description. `promotion.ts:329` writes `description: e.summary ?? undefined`, so `entities.description` is never populated either — despite `staging_proposed_entities.summary` being staged and mapped at `promotion.ts:125` | **CRITICAL** |
| `audit-pass.ts:143-165` (`recallConceptCandidates`) | Always returns `[]` in production | Joins `bridge_edges` on `relation='exhibits'/'addresses'`; the only MCP producer rejects those values, and the only writer that can emit them is test-only. The concept leg of the union at `:307-319` contributes nothing, silently | HIGH |
| `causal.ts:192-208` (`mintCausalEvent`) | `causal_events.corpus_id` never set | The `.values({…})` block omits it; `MintCausalEventParams` has no such field; all three call sites pass that type. Mig 052 gave the table a column, an index and an immutability trigger | HIGH |
| `graph-meta.ts:163` + `pipeline.ts:700` | `detectMergeCandidates`' corpus guard never sees a non-default corpus, and the epoch arm never calls it | Sole non-test caller passes no second argument. For any non-default corpus the eligibility join filters out every candidate and the function returns 0 having "succeeded" | HIGH |
| `bridge-promotion.ts:443-459` | `code_location`, `source_commit`, `source_ast_hash`, `rule_set_hash`, `model_version` permanently NULL | The INSERT omits the four anchor columns; `code_location`'s value comes from staging, and `propose_bridge_edge` has no `codeLocation` property and its staging INSERT omits the column. **An audit bridge can never say which file/line it is about** | HIGH |
| `bridge-promotion.ts:317` | `bridge_source_refs` write-only | Producer here; every other hit is a test DELETE/assert. Its stated purpose is a reverse-lookup index; nothing looks up | MEDIUM |
| `audit-ledger.ts:44,101,285` | `'checker_unavailable'` bin | Declared in type, CHECK and aggregate; no writer. Documented as dormant until Phase C | LOW (honestly labelled) |
| `corpus-policy.ts:41` (`setCorpusPolicy`) | No production writer; `'comparative'` unreachable | Only caller is a test. No HTTP route. So `promotion-plan.ts:437`'s comparative path and `:474-476`'s escalation reason are dead | MEDIUM |
| `config.ts:35` | `EMBED_DESCRIPTIONS=false` turns the flag **ON** | `z.coerce.boolean()` applies `Boolean(value)`; `Boolean("false") === true`. Off only when unset/empty — which it is (absent from `.env` and `.env.example`) | MEDIUM |
| `db/migrate.ts:43-49` | Migration failures swallowed; always exits 0 | `try { … } catch (e) { console.error(…) }` — no rethrow, no counter, then "🏁 All migrations processed" + `exit(0)`. `startup-validation.ts` checks no arc table. A DB can be missing 052's FKs or 054/055's tables while the step reports success | **HIGH** |
| `promotion.ts:169` ← `corpus_policies` | `promote()` throws entirely if mig 055 is absent | `getCorpusPolicy` inside a `Promise.all` with no try/catch → `42P01` on a lagging DB kills the epoch arm. `audit-ledger.ts:76` self-ensures precisely to avoid this | **HIGH** [I] |
| `index.ts:1329-1342` (`CLEARABLE_TABLES`) | `/api/reset` clears no arc table | Omits both bridge tables, `bridge_source_refs`, all three catalogs, `audit_runs`, `audit_coverage`, `corpus_policies`, all `staging_*`. Because bridge endpoints carry no FK and `audit_coverage.element_ref` is TEXT, both survive `DELETE FROM entities` with dangling refs. Worst case: after a reset, `POST /api/audit` with a reused name resumes the surviving run, finds every cell stamped, and returns `seeded=0, swept=0` **plus the old run's progress** — a populated success response describing a graph that no longer exists | **HIGH** |
| `bridge-promotion.ts:477-487` | D4 replay-idempotency is a single slot, not a ledger | Guard is `AND invocation_id IS DISTINCT FROM …` and it **overwrites** `invocation_id`. A-bumps, B-bumps, A-replays → double bump. Mig 051 solved exactly this for causal edges with a two-column ledger, and this file's header cites 051 as precedent | MEDIUM |
| `audit-pass.ts:268-283` (`liveBridgeFor`) | Verdict stamping can crash the pass, and can read another run's verdict | No relation filter, no corpus filter: takes the newest live bridge on `(a_ref,b_ref)`, then `:374` casts `bridge.relation` into a `CoverageVerdict`. Post-057 that can be `exhibits`/`addresses`, which the `audit_coverage.verdict` CHECK rejects → `23514` aborts the pass. Separately, with no rule-set discriminator in the dedup index, a second run under a new `ruleSetHash` finds run 1's bridge, drops its own as duplicate, and stamps run 2's coverage from **run 1's** bridge — reported as a clean sweep | **HIGH** (crash [I], stale-verdict [C]) |
| `element-authoring.ts:83-94,131-132` | Authoring failure is a silent empty description | `coerceFacets` never throws and maps missing keys to `''`; the renderer returns `''` when nothing has content; `corpus-ingest.ts:74` then embeds the bare name. A malformed model response degrades the path to exactly the behaviour it exists to replace, with no warning | MEDIUM |
| `concept-extraction.ts:200-206` | Concept entities minted with NULL embedding | The raw INSERT omits `embedding`; the comment says ".22 backfills it" and no backfill exists. Every corpus-scoped vector query filters `embedding IS NOT NULL`, so `_concepts` is vector-blind. Direct violation of the `embedForWrite` contract this same arc introduced | MEDIUM |
| `causal-agent.ts:1527-1531` (`LEGACY_SURFACE`) | `propose_bridge_edge` advertised to three actors, always throws for them | It is in neither exclusion list, so legacy actors can call it; the handler's first statement requires `context.invocationId`, which only `getMcpConfigPath('audit_agent', …)` sets | LOW |
| `causal-agent.ts:3974-3992` (`invokeAuditAgent`) | Audit LLM calls have no timeout and no usage accounting | Bare `fetch`, not `agentFetch` — no `AbortController`, no `insertUsageRows`. `index.ts:42` sets a global dispatcher with `headersTimeout: 0`. `audit_agent.py` returns no `usage` echo. One invocation per cell up to `maxCells=2000`. Unbounded, untimed, unmetered spend behind one POST | MEDIUM |
| `bridge-promotion.ts:156-214` | No self-loop drop | `planCausalPromotion` explicitly drops self-loops; the bridge planner has no `aRef === bRef` check. Reachable: `runAuditPass` never rejects `sourceCorpusId === targetCorpusId`, and the recall query would then return each entity as its own nearest neighbour at similarity 1.0 | LOW |
| `test/harness/audit-endpoint.test.ts:29-31` | The only route-level test of `/api/audit` runs over deliberately empty corpora | Header: "over EMPTY corpora so recall yields 0 cells and the agent never spawns". `invokeAuditAgent` has **no** test caller. The assertion that the route works is an assertion about the zero-work path | MEDIUM (test-integrity) |
| `migrations/056:21-26` | Kinds widening dead on arrival | 057 drops and re-adds the identical three-value vocabulary, and the filename sort guarantees 057 runs after | LOW |

## Table 4 — Isolation gaps

| FILE:LINE | write/read | how it could cross graphs | severity |
|---|---|---|---|
| `services/qdrant.ts` (whole file) + `pipeline.ts:437-450` | both | Zero corpus awareness — `grep -ci corpus` → **0**; `store()`'s metadata type has no `corpusId`. One global collection, no corpus in the payload. `search_memories` / `get_memory_text` return any graph's text to any agent. The largest un-partitioned layer | **CRITICAL** |
| `causal-agent.ts:1971-1976` (`resolve_entity`) | write | Calls `resolveEntity(mention, context, type)` with no 5th argument → `corpusId='default'`, and it mints via `createEntity`. **An agent working in corpus X mints canonical entities into `default`.** The corpus is on `context.corpusId` and is used correctly by `resolve_anchor` 1200 lines later | **CRITICAL** |
| `causal-agent.ts:1986-2000` (`create_fact`) | write | No `corpusId` → defaults `'default'`. If the subject lives elsewhere, mig 052's FK rejects with `23503`. The guard converts silent fusion into a hard failure, so `create_fact` is **unusable against any non-default graph** | HIGH |
| `entities.ts:366` (`findSimilarEntities`) | read | `corpusId='default'` is a **hard default**, not "unfiltered". A caller that forgets the option silently searches only `default` — a failure that looks like "no similar entities". `search_similar_entities` passes **agent-supplied** `corpus_id`; if the model omits it, the search silently retargets to `default` | HIGH |
| `entities.ts:333-356` (`findEntitiesByName`) | read | No corpus predicate on the trigram or either ILIKE branch. It is the fallback inside `resolveEntity` when the query embedding fails, so **an ML outage silently converts identity resolution from corpus-scoped to global** | HIGH |
| `entities.ts:247` | write | Advisory lock key is `hashtext(lower(name) + '||' + type)` — no corpus. Same-named elements in two graphs serialise against each other. `corpus-ingest.ts:80` shows the corrected form | MEDIUM |
| `facts.ts:909-919` (`searchFacts`) | read | No corpus predicate. Harmless only because it has no caller — but turning `EMBED_DESCRIPTIONS` on populates `fact_embedding` for every graph into one unpartitioned index, so wiring it up later leaks by default | MEDIUM (latent) |
| `bridge-promotion.ts:223-235`, `:268-274` | write-validation | `'entity'` endpoints resolved by **id alone** — no corpus. The staged `source_corpus_id`/`target_corpus_id` are never checked against where endpoints actually live, so a bridge can assert false provenance. The comment at `:219-221` acknowledges this and defers it to "the linker's responsibility" — while `recallConceptCandidates` and `concept-multihop.ts` filter on those unvalidated columns | HIGH |
| `causal-agent.ts:3452-3453` | write | `sourceCorpusId`/`targetCorpusId` taken verbatim from agent tool input and inserted into staging with no validation. The run's own corpora are known server-side (`AuditCellScope`) and could be stamped instead of trusted | HIGH |
| `concept-extraction.ts:34` (`CONCEPT_CORPUS='_concepts'`) | both | A single globally-shared corpus by design. `recallConceptCandidates` joins **any two corpora** sharing a concept node with no tenancy predicate, and `resolveConcepts` merges nodes across all tenants' concepts | **CRITICAL** (if kept) |
| `element-catalogs.ts:184-201` | write | `corpusId` is a free parameter independent of `elementRef`, and `ON CONFLICT DO UPDATE SET corpus_id = EXCLUDED.corpus_id` lets a later call **relabel an existing row's corpus**. The three catalogs have no `reject_corpus_id_change` trigger | MEDIUM (test-only today) |
| `element-catalogs.ts:267-295` (`recallByConcept`) | read | `ruleCorpusId` optional; when omitted the filter is empty and the query returns rule elements from **every** corpus. Default-open | MEDIUM (test-only today) |
| `entities.ts:903-909` (`mergeEntities` step 6.7) | write | Re-points `bridge_edges` with no corpus predicate and no `expired_at` filter; `mergeEntities` never checks that source and target share a corpus | MEDIUM |
| `entities.ts:903-909` (omission) | write | Re-points `bridge_edges` but **not** `bridge_source_refs.ref_id` nor `audit_coverage.element_ref`/`rule_id` (both TEXT). After a merge, bridge provenance cites a deleted entity, and a pending coverage cell hands a dead id to `loadEntities`, so the pass builds a scope with `name: ''` and the agent adjudicates an empty pair | MEDIUM |
| `contradictions.ts:167,214,253` | read | Only `detectOpposingObjects` got the corpus fix. `detectExpiredButCited`, `detectCyclicCausal`, `detectTemporalImpossible` — all invoked by `detectContradictions` from `POST /api/contradictions/detect` — remain corpus-blind and will raise contradictions between facts in different graphs | HIGH |
| `graph-canonical-query.ts` (4 queries, 0 corpus refs) | read | Backs `GET /api/graph/canonical` and `/api/graph/full` and blends every graph into one export. `/api/viz/unified` *does* accept `?corpus=`, so the capability exists — these two just don't use it | HIGH |
| `graph-stats.ts` (6/0), `impact.ts` (6/0), `cross-cluster-generator.ts` (1/0), `entity-profile.ts` (1/0), `predicate-signature.ts` (2/0), `predicates.ts` (1/0) | read | Systematic sweep. All corpus-blind, all reachable from HTTP routes. Derived statistics, blast-radius and cross-cluster candidates are computed over the union of all graphs | HIGH (aggregate) |
| `index.ts:1329-1342` | write (destructive) | `/api/reset` and `/api/viz/clear` are global `DELETE FROM` with no corpus scope | HIGH |
| `audit-pass.ts:96-107` | read (perf) | The `CROSS JOIN LATERAL` filters the inner kNN by `t2.corpus_id`, which the HNSW index cannot satisfy — filtered kNN degrades to post-filter/scan per source entity. With `maxCells=2000` this is the pass's cost driver | LOW [I] |

## Table 5 — Harnesses worth keeping (7 of ~33)

Rule applied: **reusable** = parameterised over its input, calls production code paths, answers a
recurring question. **One-shot** = hardcoded artifact filenames, frozen corpus, an already-adjudicated
bar, or a doc number in its own name.

| harness | why it survives |
|---|---|
| `recall-service.ts` | Exercises the built path end-to-end through **production** services rather than a bespoke rig. Closest thing to a regression harness for the description-embed lever |
| `audit-recall-smoke.ts` | Explicitly "plumbing + sanity smoke, NOT a measurement gate" over the real ingest + recall stage. Exactly what detects the Table-3 inert paths |
| `audit-adjudicate-smoke.ts` | The **only** end-to-end exercise of the real `invokeAuditAgent` → `/audit-agent` → MCP → `applyBridgePromotion` chain ("NO injected invoker"). `invokeAuditAgent` has zero unit coverage, so this is load-bearing |
| `corpus-graph-ingest.ts` | The only caller anywhere that drives `ingestBatch({mode:'epoch', corpusId})` — the only way to create a non-default graph until `handleBatch` is fixed. Effectively the missing HTTP route |
| `multihop-identity-check.ts` | 49 lines asserting a **reduction** (`hops=0, decay=1` must equal the single-hop primitive), not a measurement. A real invariant test in the wrong directory — **add the `S.size > 0` guard**, the vacuous `0 pairs / 0 pairs / PASS` trap is still live |
| `extractor-probe.ts` | Read-only inspection of what the production extractor actually produces from an input class. Generic, no bar, no writes. Cheap gate before ingesting a new domain |
| `sweep-coverage.ts` | Scores the **shipped** `runAuditPass` configuration rather than an offline arm. Right shape for a cost/coverage regression check, though it currently measures a union whose concept leg is inert |

**One-shot (archive with the docs, do not maintain):** `analyze-armB-reuse`, `attribution-merge`,
`concept-convergence`, `concept-convergence-v2`, `concept-embed-sensitivity`, `concept-hybrid-recall`,
`concept-join-analysis`, `concept-join-dump`, `concept-join-recall`, `concept-reconcile-recall`,
`concept-resolution`, `concept-stage2-lexbaseline`, `cross-corpus-agent-recall`,
`cross-corpus-citation-score`, `cross-corpus-dense-extract`, `cross-corpus-density-score`,
`cross-corpus-freenav`, `cross-corpus-lowcos`, `cross-corpus-recall`, `fetch-citations`,
`fetch-cociters`, `fetch-cross-corpus`, `floor-adjudicate`, `floor-ingest-recall`, `floor-rawcode`,
`link-corpus-concepts`, `multihop-score`, `rebuild-doc20-bridges`, `recall-bakeoff`, `recall-gate`,
`recall-hybrid`, `redundancy-corrected`, `redundancy-gate`.

Two special cases: **`doc-attribution.ts` is self-declared dead** — its own first line reads
"SUPERSEDED — do not use this", because `runEpochBatch` calls `cleanupAbandonedStaging()` on every batch
and GCs the staging rows it reads. **`rebuild-doc20-bridges.ts` exists only to repair damage a test
caused** (an unscoped `_concepts` cleanup that wiped 97+51 shared bridges) — evidence for the `_concepts`
isolation finding, not tooling.

## What this survey could not determine

1. **Whether the live DB actually has migrations 051–057.** `migrate.ts` has no journal, swallows
   failures, and is not run on boot; `startup-validation.ts` checks none of these tables. Every
   "the constraint enforces X" claim is conditional on the migration having applied.
2. **Whether `POST /api/audit` has ever completed a non-trivial run in production.** All DB-level tests
   inject a fake invoker; the one route test uses empty corpora.
3. The `audit_coverage` verdict crash is reachable in principle but the trigger was not confirmed —
   it needs `/api/audit` invoked with `targetCorpusId='_concepts'`. Tagged [I].
4. The composite-FK / CASCADE interaction on `merge_candidates` (mig 003 CASCADE vs mig 052 NO ACTION).
   Should be safe by Postgres ordering; not executed. Tagged [U].
5. `z.coerce.boolean()` runtime behaviour read off Zod semantics, not observed *in this survey* —
   subsequently verified by hand (`Boolean("false") === true`).
6. **Whether the epoch arm is the production arm.** `handleBatch` exposes all three; `/ingest` uses the
   serial `extract()` path. Several findings' blast radius depends on which arm real traffic uses.
7. Per-file test-pass state — no tests or typecheck run; the branch carries ~56 pre-existing `tsc`
   errors unrelated to this work.
