# Isolation / corpus-partitioning bead triage — 2026-09-22

Branch `feat/single-graph-retrieval` @ `bcb95a7`. Read-only verification pass. Live
substrate `cognitive_test` (135,210 entities across 12 corpora), Qdrant on :6335.

Every claim below is labelled **[V]** verified by my own read/query, **[B]** claimed by the
bead or a doc and not independently re-derived, or **[I]** inference.

## Verdict table

| Bead | Verdict | One-line evidence |
|---|---|---|
| nmemo-4h3 | **STILL-BROKEN** (count lower than claimed) | 27 exported read functions still read a corpus-partitioned table with no corpus predicate; no RLS (0 policies), no scoped helper; `findEntitiesByName('transformer')` returns 10 rows spanning 6 corpora |
| nmemo-81k | **STILL-BROKEN** (verbatim) | `index.ts:224` handleBatch body type still has no `corpusId`; only 2 of ~60 HTTP routes accept any corpus scope, neither is an ingest route |
| nmemo-cki | **FIXED** | `entities.ts:258` now has `eq(entities.corpusId, corpusId)` plus a corpus-keyed advisory lock; landed in `029f653` |
| nmemo-mdc | **STILL-BROKEN** (verbatim) | Qdrant payloads carry `stream_id` only — scrolled 3 live points, no `corpus_id`; `memories` holds 20,395 points from all corpora, `memories_test` = 0 |
| nmemo-bju | **STILL-BROKEN** (verbatim, line numbers exact) | `causal-agent.ts:2039-2042` drops `context.corpusId`; sibling at `:2007-2012` passes it |
| nmemo-ghc | **STILL-BROKEN** (verbatim, line numbers exact) | `causal.ts:1130` options = `{entityId?}`, `causal.ts:1176` options = `{includeExpired?}` — no corpus option on either |

Two findings beyond the beads are in **Surprises** at the end.

---

## nmemo-4h3 — read-path corpus predicates — STILL-BROKEN

### The structural claim holds

[V] No Postgres row-level security exists: selecting from `pg_tables` where `rowsecurity`
returns 0 rows, and `select count(*) from pg_policies` = 0. [V] No scoped-query helper
exists either — grepping `platform/src` for `requireCorpus|scopedQuery|withCorpus|assertCorpus`
finds nothing. Neither fix option (a) nor (b) from the bead has landed.

[V] Scoping is opt-in and **fails open**. `graph.ts:128`, `:217`, `:263`, `:325` all read
`const corpusId = options.corpusId ?? null` and then build the filter as
"empty SQL when corpusId is null, else AND f.corpus_id = $1". A caller that omits the
option walks every corpus. This is the exact property the bead says needs inverting.

[V] Only **2** of ~60 HTTP routes in `index.ts` accept a corpus scope at all:
`GET /api/viz/unified` (`index.ts:320`, `?corpus=`) and `POST /api/reason/query`
(`index.ts:1497`, `body.corpusId`). Everything else is unscoped by construction.

### The count: ~39 claimed, 27 confirmed on the strict definition

I enumerated exported functions in `platform/src/services/*.ts` plus `pipeline.ts` that
perform a DB read (`.from(`, `rawQuery`, `db.execute`, `db.select`) and whose body contains
no `corpusId`/`corpus_id` token anywhere. [V]

- 137 read-touching exported functions total
- 91 with no corpus token at all
- **27** of those 91 demonstrably read a corpus-partitioned table
  (`entities` / `facts` / `causal_events` / `merge_candidates`)

The 91 -> 27 narrowing is the honest number, because [V] **only 9 of 52 public tables carry
a `corpus_id` column at all**: `causal_events, code_elements, corpus_policies,
element_embeddings, entities, facts, merge_candidates, rule_elements, source_document`.
The other 64 unscoped functions read tables with no corpus dimension to filter on
(`llm_usage`, `entity_topology`, `entity_clusters`, `causal_edges`, `contradictions`,
`reasoning_reports`, `graph_stats`, `entity_meta`, the ingest ledger, ...). That is a
**schema gap, not a missing predicate** — those readers cannot be scoped without either
adding the column or joining back to `entities`/`facts`. The bead's "~39 services carry no
corpus predicate" conflates the two; the actionable surface is 27 plus a schema decision on
the derived tables.

### The 27, concretely

```
services/bridge-promotion.ts:223        catalogHas
services/causal-pass.ts:104             runCausalPass
services/causal-patterns.ts:215         normaliseChain
services/causal-patterns.ts:963         matchEdgeToPattern
services/causal-promotion.ts:61         applyCausalPromotion
services/causal.ts:224                  createCausalEdge
services/causal.ts:1130                 getCausalDelta            <- nmemo-ghc
services/clustering.ts:134              getClusterEntities
services/contradictions.ts:167          detectExpiredButCited
services/cross-cluster-generator.ts:703 listCrossClusterCandidates
services/derived-freshness.ts:151       maybeFireFactThresholdCompute
services/entities.ts:332                findEntitiesByName        <- reproduced leak below
services/entities.ts:599                getEntityById
services/facts.ts:493                   findSupersedingFacts
services/facts.ts:798                   updateFactConfidence
services/facts.ts:846                   restoreFact
services/graph-canonical-query.ts:26    exportCanonicalGraph      <- HTTP-reachable
services/graph-canonical-query.ts:187   exportRichGraph           <- HTTP-reachable
services/graph-meta.ts:45               updateEntityMeta
services/graph-meta.ts:269              getMergeCandidates        <- HTTP-reachable
services/graph-meta.ts:378              detectAgedOrphans
services/graph-stats.ts:226             computeGraphStats
services/impact.ts:249                  maybeWarnBlastRadius
services/predicate-signature.ts:106     populatePredicateSignatures
services/predicates.ts:93               findNonCanonicalPredicates
services/topology.ts:182                getComponentEntities
pipeline.ts:148                         maybeTriggerReconciliation
```

Three of the six files the bead names by hand check out differently, and this matters:

- [V] `graph.ts` and `graph-fallback.ts` **are** corpus-capable now (`graph.ts:115/128`,
  `graph-fallback.ts:75/199/442/477`) — opt-in, default all-corpora. The bead's listing of
  them as "carry no corpus predicate" is stale in letter, accurate in spirit (fail-open).
- [V] `graph-canonical-semantic.ts` performs **no DB access at all** — it is a pure
  in-memory diff over two `CanonicalGraph` objects (`normalizeType`, `parseFactKey`,
  `semanticDiff`). Listing it was a mistake.
- [V] `graph-canonical-query.ts`, `topology.ts` and `entity-profile.ts` are confirmed
  unscoped as claimed.

A fourth category my scan does not catch: functions that call a corpus-*capable* helper and
drop the argument. [V] `entity-profile.ts:50-51` — `getEntityProfile` calls
`getEntityFacts(entityId)` and `findConnectedEntities(entityId)` with no `corpusId`, and it
is HTTP-reachable at `index.ts:1297` (`GET /api/entity/:id/profile`). Also
`causal-agent.ts:3453` (`getEntityFacts(anchor, {asSubject:true, asObject:false})` inside
the exclusive-group decision) and the `get_neighbourhood_profile` MCP tool — see Surprises.

### Reproduced leak

[V] `findEntitiesByName` (`entities.ts:332`) runs, verbatim:

```sql
SELECT *, similarity(canonical_name, $1) as sim
FROM entities
WHERE canonical_name % $1
ORDER BY sim DESC LIMIT $2
```

Run against the live substrate with `$1 = 'transformer'`:

```
 canonical_name | corpus_id | sim
 transformer    | _concepts |   1
 transformer    | dal-cv    |   1
 transformer    | arxiv-cv  |   1
 transformer    | arxiv-nlp |   1
 transformer    | dal-nlp   |   1
 transformer    | dal-cv    |   1
 transformer    | arxiv-nlp |   1
 transformer    | arxiv-cv  |   1
 transformer    | arxiv-nlp |   1
 transformer    | qbio      |   1
(10 rows)
```

Ten rows, six distinct corpora, one call. [V] 1,397 lowercased entity names exist in more
than one corpus, so this is the normal case, not a corner.

[V] `exportCanonicalGraph` (`graph-canonical-query.ts:26`) selects from `entities` with no
`WHERE` at all, served at `GET /api/graph/canonical` (`index.ts:640`). It returns all
135,210 entities across all 12 corpora in one response.

### Severity read

**Real, but narrower than the bead frames it for traversal and wider for global lookups.**
[V] There are **0** cross-corpus fact edges in the live DB — joining `facts` to `entities`
on `subject_entity_id` and counting rows where `entities.corpus_id <> facts.corpus_id`
gives 0, same for `object_entity_id`. That is because mig-052 put composite FKs on `facts`:
`facts_subject_corpus_fk (subject_entity_id, corpus_id) -> entities(id, corpus_id)` and the
object equivalent. [I] So an unscoped *traversal from a known entity id* cannot currently
leave its corpus — the write-side guard closes the read-side hole for hop-by-hop walks. The
leak is in **global list / name / vector / dump** reads: `findEntitiesByName`,
`exportCanonicalGraph`, `exportRichGraph`, `getMergeCandidates`, `getTopologySnapshot`,
`getClusterEntities`. Those are unambiguous cross-graph data exposure the moment a second
graph belongs to a second user.

### Fix size

**Multi-file, and it needs a schema decision first.** 27 functions plus their call chains,
plus a choice for the 64 readers whose tables have no `corpus_id` at all. The bead is right
that another audit pass is the wrong shape: fail-open defaults mean the next new function
reintroduces it. RLS on the 9 partitioned tables plus a corpus-carrying session variable is
the only option here that fails closed.

---

## nmemo-81k — no HTTP entry point for corpusId — STILL-BROKEN (verbatim)

[V] `platform/src/index.ts:224`, read with `grep -a`/`sed` because the file's NUL bytes make
ripgrep treat it as binary:

```ts
const body = await c.req.json<{ chunks?: string[]; source?: string; sourceId?: string;
  contentType?: string; concurrency?: number; stream_id?: string }>();
```

No `corpusId`. [V] The forward at `index.ts:234-255` passes `source`, `sourceId`,
`contentType`, `mode`, `concurrency`, `streamId` — and nothing else. All three batch routes
(`index.ts:266-268`, serial / epoch / optimistic) go through it.

[V] `POST /ingest` (`index.ts:114-123`) likewise accepts `text, source, contentType,
stream_id, idempotency_key, context` — no `corpusId`.

[V] The pipeline side is ready, at shifted line numbers: `pipeline.ts:1251` throws
"ingestBatch: corpusId='X' requires mode 'epoch'" and `:1261` passes `opts.corpusId` into
the runner. The bead cites `1204`/`1216`; the code has moved to `1251`/`1253`/`1261`. Claim
intact, line numbers stale.

[V] DB corroboration. Non-`default` corpora do exist and are large:

| corpus_id | entities | last entity write |
|---|---|---|
| _cronqa | 125,523 | 2026-09-08 |
| qbio | 3,670 | 2026-09-02 |
| arxiv-cv | 1,282 | 2026-08-25 |
| dal-cv | 1,262 | 2026-08-31 |
| arxiv-nlp | 1,230 | 2026-08-24 |
| dal-nlp | 1,133 | 2026-08-31 |
| _concepts | 668 | 2026-08-27 |
| **default** | **382** | **2026-08-31** |
| cj-code / cj-rules / cr_rules / cr_code | 29 / 27 / 3 / 1 | 2026-07 |

[I] Every non-`default` row therefore came from an in-process harness, not an HTTP call —
consistent with the bead's claim that `src/test/tools/corpus-graph-ingest.ts` is the de
facto missing route. [V] `default` is not dormant either: 382 entities / 246 facts with
writes as recent as 2026-08-31, which is what an HTTP-driven ingest produces.

[V] Also confirmed: exactly 2 HTTP routes accept a corpus scope anywhere in `index.ts`
(lines 320 and 1497), and neither is an ingest route.

### Severity read

**Not a leak — a capability gap.** Nothing leaks because production only ever writes one
corpus; that is precisely the problem. Everything built on mig-052 is unreachable from the
network surface.

### Fix size

**One-function** for the narrow fix (add `corpusId` to the body type, validate it, pass it
to `ingestBatch`) — but `pipeline.ts:1251` will reject it unless `mode === 'epoch'`, so
either the serial/optimistic arms need corpus support or the route must document the
epoch-only constraint.

---

## nmemo-cki — createEntity global dedup — FIXED

[V] `platform/src/services/entities.ts:250-262` now reads:

```ts
const corpusId = params.corpusId ?? 'default';
await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${params.name.toLowerCase() + '||' + corpusId}))`);

const existing = await db
  .select({ id: entities.id })
  .from(entities)
  .where(and(
    sql`lower(canonical_name) = ${params.name.toLowerCase()}`,
    eq(entities.corpusId, corpusId),
  ))
  .limit(1);
```

Both the advisory lock and the existence check are corpus-keyed. The in-code comment names
this bead explicitly. [V] Landed in `029f653` "feat(35): entity identity = (name, corpus);
demote entity_type to attribute (nmemo-asf.5)" — the bead was fixed as a side effect of the
identity-key change, which also removed `entity_type` from the key, so the bead's quoted
predicate `lower(canonical_name) + entity_type` no longer exists in either form.

[V] `corpusId` is threaded from the one production caller: `resolveEntity`
(`entities.ts:404`, default `'default'`) passes it at `entities.ts:479`.

Residual work the bead also asked for, **not** done: [V] `services/corpus-ingest.ts` still
exists, and its header comment at lines 8-11 still asserts that "createEntity dedups on
(lower(canonical_name), entity_type) GLOBALLY — it ignores corpus_id". That comment is now
false on both counts. [V] `corpus-ingest.ts` is imported only from `src/test/tools/*` and
`src/test/corpus-ingest.test.ts` — no production importer — so deleting it is a
harness-migration job, not a production change.

---

## nmemo-mdc — Qdrant has no graph partition — STILL-BROKEN (verbatim)

### No corpus discriminator in the payload

[V] `pipeline.ts:471-484` (parent window point) writes `content, point_type, source,
created_at, status, content_type, stream_id`, plus optional `source_id` / `chunk_index`.
[V] `pipeline.ts:496-505` (unit satellites) writes `point_type, parent_window_id,
unit_text, char_start, char_end, stream_id`. Neither includes `corpus_id` — even though
`metadata?.corpusId` is in scope and is used 30 lines later at `pipeline.ts:515` for
`recordFragments`.

[V] Live scroll of `memories` (3 points, read-only GET), one payload verbatim:

```json
{"char_end":704,"char_start":576,"parent_window_id":"e293c5bb-...",
 "point_type":"unit","stream_id":"default","unit_text":"a novel end-to-end vector-quantized ..."}
```

`stream_id` only, and its value is `default`.

### No corpus filter in any search

[V] `services/qdrant.ts` is 371 lines and contains zero occurrences of `corpus`.
`searchMemories` (`:135`) takes an opaque `filter` pass-through; `searchMemoriesByUnit`
(`:200-263`) builds its `must` array from `point_type` and, optionally, `stream_id`
(`:213`, `:258`). The MCP consumer `causal-agent.ts:1886` and `:1907` calls it with
`{limit}` / `{limit, streamId}` — never a corpus.

### The collection-name half also still holds

[V] `qdrant.ts:25` is still `return process.env.QDRANT_COLLECTION ?? 'memories'`. There is
no required-env check and no NODE_ENV=test guard — grepping for `QDRANT_COLLECTION` finds
it asserted only inside `src/test/global-setup.ts` and one MCP-env forwarding test, never in
`startup-validation.ts`.

[V] Live collection counts: `memories` 20,395 points / `memories_dal` 6,849 /
`memories_test` **0** / `memories_hybrid_search_test` / `contexts` 0. The shared `memories`
collection is where every real run landed, exactly as doc 39 §3.9 recorded. (The bead says
11,927 points; it is 20,395 now. [I] Same failure, more accumulation.)

### Severity read

**Real data-leak risk, and the largest of the six.** Postgres cannot leak cross-corpus
entity/fact rows for a known entity (composite FK, 0 cross-corpus edges), but Qdrant has no
partition at all, so any semantic search over source text returns windows from every corpus
in the collection. Raw source text is also the highest-value payload to leak.

### Fix size

**One-function each, two functions total, plus a backfill.** Add `corpus_id` to the two
payload literals in `pipeline.ts:471`/`:496` (the value is already in scope) and push a
`corpus_id` term into the `must` arrays at `qdrant.ts:210`/`:258`. The 20,395 existing
points have no `corpus_id`, so they need a backfill or they become invisible to a
corpus-filtered search — that is the part that makes this not a one-liner.

---

## nmemo-bju — project_trajectory drops corpusId — STILL-BROKEN (line numbers exact)

[V] `services/causal-agent.ts:2038-2042`, verbatim:

```ts
    case 'project_trajectory': {
      const chain = await projectTrajectory(toolInput.fact_id as string, {
        maxDepth: toolInput.max_depth as number | undefined,
        minStrength: toolInput.min_strength as number | undefined,
      });
```

[V] The sibling at `:2006-2012`:

```ts
    case 'trace_causes': {
      const chain = await traceCauses(toolInput.fact_id as string, {
        maxDepth: toolInput.max_depth as number | undefined,
        minStrength: toolInput.min_strength as number | undefined,
        // nmemo-asf.3: keep the causal walk inside the injected corpus.
        corpusId: context.corpusId,
      });
```

[V] `projectTrajectory` supports the option: `causal.ts:975-981` destructures `corpusId`
from `TraceOptions` and builds both a base filter (`AND ce.corpus_id = $1`) and a recursive
child filter (`AND child.corpus_id = $1`). The plumbing exists on both sides; only the call
site drops it.

[V] It is a live MCP tool — registered at `causal-agent.ts:314` among 52 tool definitions.
[V] `context.corpusId` is populated from `process.env.MNEMO_CORPUS_ID`
(`causal-agent.ts:1705`), set by the harness at `:3820`.

[V] The probe-coverage claim is also accurate: `src/test/tools/corpus-isolation-probe.ts`
imports `getEntityCausalHistory, traceCauses` from `causal.js` and nothing else from the
causal read surface. Its own header documents deliberately planting a **cross-corpus poison
edge** to prove that `traceCauses`' recursive parent filter refuses it — the identical
poison would walk straight through `projectTrajectory`.

### Severity read

**Real but currently latent.** [V] There are 0 cross-corpus causal edges in the live DB:
1,043 edges total, and joining both endpoints back to `causal_events` gives 0 rows where the
cause event's `corpus_id` differs from the effect event's. [V] But nothing prevents one:
`causal_edges` has **no `corpus_id` column** and only single-column FKs to
`causal_events(id)` — no composite-FK analogue of the `facts` guard. So the leak needs one
cross-corpus edge to exist, the schema permits it, and the probe fixture creates one on
purpose.

### Fix size

**One line** — add `corpusId: context.corpusId,` at `causal-agent.ts:2042`. The probe
extension the bead asks for (cover all four causal read tools) is one-function.

---

## nmemo-ghc — getCausalDelta / findEdgesCitingReference unscopable — STILL-BROKEN (line numbers exact)

[V] `services/causal.ts:1130-1136`:

```ts
export async function getCausalDelta(
  from: Date,
  to: Date,
  options: { entityId?: string } = {},
)
```

Its events query filters on `created_at` between plus an optional `subject_entity_id`
(`:1138-1150`); its edges query filters on `created_at` only (`:1152-1160`). No corpus term
in either.

[V] `services/causal.ts:1176-1182`:

```ts
export async function findEdgesCitingReference(
  refType: 'memory' | 'fact' | 'entity',
  refId: string,
  options: { includeExpired?: boolean } = {},
)
```

Filters on `edgeSourceRefs.refType`, `.refId`, and optionally `isNull(causalEdges.expiredAt)`.
No corpus term.

[V] The asymmetry the bead describes is real: `traceCauses` (`:858`), `projectTrajectory`
(`:975`) and `getEntityCausalHistory` (`:1085`) all accept `corpusId`; these two do not.
[V] `get_causal_delta` is a registered MCP tool (`causal-agent.ts:338`, handler `:2068`).
[V] `findEdgesCitingReference` is on the blast-radius path — `impact.ts:643`.

One correction to the fix framing: [V] `causal_events` has `corpus_id` (`not null default
'default'`, indexed `idx_causal_events_corpus`) but **`causal_edges`, `edge_source_refs`,
`causal_edge_history` and `causal_edge_corroborations` do not**. So `getCausalDelta`'s
*events* half can be scoped with a plain predicate, while its *edges* half and all of
`findEdgesCitingReference` require a join back through `causal_events` (or a new column).
The bead implies "accept a corpus option" is sufficient; for the edge side it is not.

### Severity read

**Theoretical today, same latency as bju.** Zero cross-corpus causal edges exist, and both
functions are off the main read path (`get_causal_delta` scopes an agent pass; blast-radius
is an analysis query). Under multi-graph it becomes a real cross-graph read.

### Fix size

**One-function for the events half, multi-file for the edges half** — the edges half needs
either a `corpus_id` column on `causal_edges` (plus backfill from its cause event and a
mig-052-style composite guard) or a join through `causal_events` in both functions.

---

## Surprises

**1. A seventh unscoped path, on the MCP read surface — not filed.** [V]
`causal-agent.ts:2918` `case 'get_neighbourhood_profile'` (tool registered at `:859`) runs
seven reads in one `Promise.all` and passes `context.corpusId` to **none** of them:
`getEntityFacts(entityId)` (`:2924`), a raw select from `facts` where
`object_entity_id = $1` (`:2925-2931`), `findConnectedEntities(entityId, {maxDepth:1})`
(`:2933`), and `getEntityCausalHistory(entityId)` (`:2934`). Its siblings at `:1773`,
`:1823`, `:1849`, `:1863`, `:1913`, `:1921`, `:1947`, `:1977`, `:2011` all do pass it. Same
class as nmemo-bju, same one-line-per-call fix; nmemo-bju's "extend the isolation probe to
cover all four causal read tools" would not have caught it either, since this one is a graph
tool, not a causal tool.

**2. `resolveEntity`'s ML-outage fallback is a corpus-blind write-path decision.** [V]
`entities.ts:404` `resolveEntity(mention, context, type, position, corpusId='default')`
computes an embedding; on ML failure (`embedForQuery` returns `[]`) it falls through at
`entities.ts:489` to `findEntitiesByName(mention, {limit: 5, type})` — the globally-unscoped
function reproduced above — and, above threshold 0.92, **returns that entity id as the
resolution**. [I] So during an ML outage the default ingest path can resolve a mention to an
entity in a different corpus and then try to write a fact in `corpusId` against it. The
composite FK (`facts_subject_corpus_fk`) turns that into a loud 23503 rather than a silent
fusion — which is [I] most likely why `default` holds only 246 facts and why 0 cross-corpus
edges exist — but it is a corpus-blind read feeding a write decision, i.e. exactly the
"sixth unscoped path" nmemo-4h3 predicted. Note the happy path is scoped *and fails closed*
the other way: `findSimilarEntities` (`entities.ts:373`) defaults `corpusId = 'default'`, so
it under-returns for a non-default caller rather than over-returning.

**3. `corpus-ingest.ts`'s justification comment is now false.** [V] Lines 8-11 still say
`createEntity` dedups globally and ignores `corpus_id`; `029f653` made that untrue. A
reader auditing isolation from comments would conclude the opposite of the code.
