# 38 — Graph-Anchored Fallback Retrieval (query-failure recall booster)

**Epic:** `nmemo-0wq` — Graph-anchored fallback retrieval
**This doc satisfies:** `nmemo-0wq.1` — the design spec, written before any code (project norm: design-before-code for P1+)
**Status:** Design draft (2026-06-02) — under review
**Depends on:** `nmemo-yxj` (embedding-granularity epic) and specifically `nmemo-yxj.6` (fact->unit evidentiary links)

---

## 1. Purpose

Flat vector retrieval answers a question by embedding it and pulling the top-k nearest source texts. It works when the answer sits in a passage that is *textually* close to the question. It misses when the answer is one reasoning hop away — the question names entity A, the answer lives in a passage about entity B, and the only thing connecting A and B is a fact in Graph S. LongMemEval's multi-session questions are full of this shape: a preference stated in session 2, a constraint stated in session 9, and a question that only resolves if you bridge the two.

This epic adds a **fallback retrieval path** that fires when flat retrieval fails. Instead of searching text again, it anchors on a node the system already knows about, walks the entity/fact graph to its neighbours, fetches the **unit-grained** evidence behind the neighbours' facts, and re-ranks that evidence against the query. It recovers recall that a flat search structurally cannot reach.

Two honest limits frame the whole design and are not negotiable:

- **It is a booster, not a guarantee.** The fallback needs the query to anchor to *some* node before it can expand. If nothing anchors, there is nothing to walk and the fallback returns empty. We do not invent anchors.
- **It must stay unit-grained.** The expansion fetches the specific embedding *units* behind a neighbour's facts (via `nmemo-yxj.6`), never the whole parent window. Pulling the whole window would re-introduce exactly the dilution the granularity epic (`nmemo-yxj`) removed. Unit grain is the load-bearing constraint of this epic.

This doc fixes the five decisions `nmemo-0wq.1` calls out — traversal policy, anchor/no-anchor handling, re-rank model, the query-failure trigger, and the deferred `fact->unit` persistence choice from `nmemo-yxj.6` — and defines the interface the implementation beads (`.2` expansion, `.3` trigger+integration, `.4` eval) build against.

## 2. Where this sits in the existing retrieval path

The current retrieval surface is the reasoning agent's MCP toolset (`src/services/causal-agent.ts`, served via `src/services/graph-mcp.ts`). The agent is a Claude Code subprocess invoked from `POST /api/reason/query` (`src/index.ts:1005`). The relevant read tools today:

| Tool | Handler | What it does now |
|---|---|---|
| `search_memories` | `causal-agent.ts:1344` | Embeds the query, calls `searchMemories()` (`qdrant.ts:121`) filtered to `point_type='window'`. Flat window-grained vector search. |
| `search_similar_entities` | `causal-agent.ts:1329` | pgvector similarity over entity name/description embeddings. |
| `query_entity_facts` | `causal-agent.ts:1277` | `getEntityFacts()` (`facts.ts:773`) — active facts where the entity is subject, plus summary and aliases. |
| `query_entity_neighbours` | `causal-agent.ts:1318` | `findConnectedEntities()` (`graph.ts:226`) — AGE Cypher walk `(a:Entity)-[*1..depth]-(b:Entity)`, returns id/name/type only. |
| `get_memory_text` | `causal-agent.ts:1366` | Full text of one window point. |

The pieces of the fallback already exist as separate tools; what is missing is (a) a *failure signal* that says flat retrieval came up empty, and (b) a *composed traversal* that chains anchor → neighbours → neighbour-facts → evidence-units → re-rank into one retrieval, returning unit-grained evidence rather than whole windows. This doc specifies that composition. It deliberately stays a **new capability** and does not change `search_memories`' existing window-only behaviour (the comment at `causal-agent.ts:1349` already reserves the unit-grained read path for `nmemo-yxj.3`).

```d2
direction: right

q: "query" { shape: oval }

flat: "flat retrieval\n(search_memories,\nwindow-grained)" {
  style.fill: "#cfe8ff"
}

trigger: "failure trigger\n(§6)" { shape: diamond; style.fill: "#fff3cd" }

anchor: "anchor seeds\n(§4)" { style.fill: "#d4edda" }
expand: "neighbour expansion\n(§3) → fact rows" { style.fill: "#d4edda" }
units: "fetch evidence UNITS\n(yxj.6 links → Qdrant)" { style.fill: "#d4edda" }
rerank: "re-rank vs query\n(§5)" { style.fill: "#d4edda" }

answer: "ranked evidence\n(unit-grained)" { shape: oval }

q -> flat
flat -> trigger: "candidates + scores"
trigger -> answer: "PASS\n(flat sufficed)"
trigger -> anchor: "FAIL\n(invoke fallback)"
anchor -> expand -> units -> rerank -> answer
```

## 3. Traversal policy

The walk starts from one or more **anchor entities** (§4) and produces a ranked set of evidence units. Policy decisions:

### 3.1 What we traverse

The graph is Graph S: `entities` joined by `facts` (`subject_entity_id` / `object_entity_id`, schema `schema.ts:118`). The AGE `Entity` graph is the traversal index; canonical fact rows live in Postgres. Two traversal primitives already exist and are reused, not rebuilt:

- **Neighbour discovery** uses `findConnectedEntities()` (`graph.ts:226`) — the AGE Cypher walk that `query_entity_neighbours` wraps. It returns neighbour entity ids/names/types.
- **Fact retrieval** per neighbour uses `getEntityFacts()` (`facts.ts:773`) — active facts where the entity is subject.

The expander walks **fact edges**, not arbitrary AGE relationships: a neighbour is interesting because a *fact* connects it to the anchor, and that fact's evidence is what we ultimately want. Causal edges (Graph C) are out of scope for the first cut — Graph C answers "why", Graph S answers "what", and recall recovery is a "what" problem.

### 3.2 Hop depth

**Default `max_depth = 1`, hard cap `2`.** One hop recovers the dominant LongMemEval shape (question anchors on A, answer is a direct fact-neighbour of A). Depth 2 is available behind a knob for cases where the bridge entity itself carries no evidence and only its neighbour does. Depth is capped at 2 because:

- Fan-out is roughly `(avg_degree)^depth`; at depth 3 the candidate-unit set balloons past what re-ranking can usefully separate and past the agent's token budget.
- `findConnectedEntities()` already clamps depth to `[1,5]` (`graph.ts:237`); the fallback applies its own tighter clamp of 2 on top.

The depth knob is `FALLBACK_MAX_HOPS` (default 1).

### 3.3 Which neighbours, and ranking expansion candidates

Not every neighbour is worth expanding. At depth 1 a popular anchor (e.g. the user, "I") can have hundreds of fact-neighbours. We rank expansion candidates and cap them **before** fetching their evidence units, so the cost of the fetch is bounded:

Candidate neighbours are ordered by a cheap composite score computed from data already on hand:

1. **Predicate relevance** — does the fact's predicate semantically relate to the query? Reuses the canonical predicate vocabulary (`src/services/predicates.ts`); a query embedding compared against predicate embeddings gives a per-predicate weight. Cheap, no extra Qdrant round-trip.
2. **Anchor proximity** — depth-1 neighbours rank above depth-2.
3. **Topology salience (tie-break)** — neighbour `pagerank` from `entity_topology` (`topology.ts`), so a central, well-attested neighbour beats a periphery leaf when other signals tie. This is a tie-break only; it must not dominate, or the fallback would always surface the graph's protagonists regardless of the query.

Keep the top `FALLBACK_MAX_NEIGHBOURS` (default 20) expansion candidates per anchor. This cap is the primary cost governor on the fetch step.

### 3.4 What the expander returns

For each surviving neighbour fact, the expander returns the fact row plus its **evidence units** (§7), shaped for the re-ranker:

```
ExpandedEvidence {
  anchorEntityId: string
  neighbourEntityId: string
  factId: string
  predicate: string
  hop: 1 | 2
  units: Array<{
    qdrantPointId: string     // the unit satellite point id
    parentWindowId: string    // facts.source_memory_id — provenance unchanged
    unitText: string          // unit-grained text, NOT the whole window
    charStart: number
    charEnd: number
  }>
}
```

`units` is unit-grained by construction. When `nmemo-yxj.6`'s offset mapping could not attribute a fact to specific units (non-verbatim or repeated source_text), the fallback degrades to the window point as a *single* unit-shaped entry flagged `windowFallback: true` — so the re-ranker still sees the evidence, but the implementation can measure how often it had to coarsen. This mirrors yxj.6's own window-fallback rule and keeps the "no whole-window re-dilution" acceptance honest: window fallback is the exception, instrumented and counted, not the default path.

This is the deliverable boundary for `nmemo-0wq.2`: given an anchor entity, return `ExpandedEvidence[]` honouring §3.1–§3.4. No trigger, no re-rank — just the traversal and unit fetch.

## 4. Anchor-seed handling and the no-anchor case

The fallback expands *from* nodes; it needs at least one seed.

### 4.1 Seeding

Anchors are gathered, in priority order, from signals the failed flat query already produced or can cheaply produce:

1. **Entities named in surviving flat hits.** Even a "failed" flat query usually returns *something* below threshold. Resolve those low-confidence window hits to their entities (via `memory_entities` linkage / `source_memory_id`) and use them as anchors. This is the strongest seed: the flat search got *near* the right region, just not into the answer passage.
2. **Direct entity match on the query.** `search_similar_entities` (`causal-agent.ts:1329`) over the query text. If the query names an entity by something close to its canonical name or an alias, anchor on it.
3. **Entities mentioned in the query via extraction (optional, depth-budget permitting).** Run the lightweight entity-mention path over the query string. Deferred behind a knob — the first two seeds cover the LongMemEval cases and avoid an extra LLM call on every fallback.

Anchors are deduplicated and capped at `FALLBACK_MAX_ANCHORS` (default 5). Multiple anchors are expanded independently and their evidence pooled for a single re-rank.

### 4.2 Explicit no-anchor behaviour

If none of the seed strategies yields an entity, **the fallback returns empty and the caller surfaces the original flat result unchanged.** This is the booster-not-guarantee limit made concrete: no anchor, no expansion, no error. The integration path (`nmemo-0wq.3`) logs `fallback_skipped_no_anchor` so `nmemo-0wq.4` can measure how often the recall ceiling is anchor-bound versus traversal-bound. We do not fabricate anchors, broaden to the whole graph, or fall back to a second flat search — any of those would turn a precise booster into an expensive guess.

## 5. Re-rank model over fetched evidence

Expansion produces a pool of evidence units gathered by *graph* proximity, not *semantic* proximity to the query. The pool must be re-ranked so the agent sees the unit most likely to answer the question first.

### 5.1 The ranking signal

Re-rank by **cosine similarity of each unit's stored embedding against the query embedding.** Units are already embedded points in the `memories` collection (768-dim Cosine, `qdrant.ts:18`); the query is embedded once for the flat search and reused. No new embedding calls for the units — fetch their vectors with `getMemoryVectors()` (`qdrant.ts:175`) or read the score back from a filtered Qdrant search over the candidate point ids.

This is the crux of why unit grain matters: a window's centroid embedding is blurred across everything in the window, so a window-grained re-rank would score the *right window* highly for the *wrong reason* and bury the actual answer unit. Re-ranking at unit grain restores the sharp signal.

### 5.2 Composite re-rank score

```
rerank_score(unit) =
    w_sim  * cosine(query_vec, unit_vec)        // primary: semantic match
  + w_pred * predicate_relevance(fact)          // §3.3, carried through
  + w_hop  * (1 / hop)                           // closer anchors slightly favoured
```

Initial weights `w_sim=0.7, w_pred=0.2, w_hop=0.1` (sum 1.0), tunable via env (`FALLBACK_RERANK_W_SIM` etc.), tuned against `nmemo-0wq.4`'s LongMemEval set per the ship-and-tune convention used by the cross-cluster generator (doc 25 §7.4). Similarity dominates; predicate and hop break ties and nudge.

### 5.3 Output

Return the top `FALLBACK_RERANK_LIMIT` (default 5) units as ranked evidence, each carrying `unitText`, `factId`, `parentWindowId`, and `rerank_score`. The integration path hands these to the reasoning agent as additional retrieved evidence, clearly labelled as fallback-sourced so the agent can weigh provenance.

**No LLM re-ranker in the first cut.** Cosine + cheap structural signals are deterministic, fast, and free. A cross-encoder or LLM re-ranker is a documented future option (§9) if eval shows the cosine ordering is insufficient; we do not pay that cost speculatively.

## 6. The query-failure trigger (cost control)

The fallback is more expensive than flat retrieval (graph walk + per-neighbour fact reads + unit-vector fetch + re-rank). It must fire **only on failure**, never on a query the flat path already answered. This is the acceptance constraint on `nmemo-0wq.3`: no regression to successful flat queries.

### 6.1 What counts as failure

Flat retrieval has failed when **no flat hit clears the confidence bar.** Concretely, the trigger fires when:

- the top flat-hit score is below `FALLBACK_TRIGGER_MIN_SCORE` (default 0.5, the cosine floor below which a window is "not really about this"), **OR**
- the gap between the top score and `FALLBACK_TRIGGER_MIN_SCORE` is positive but the result set is empty after the existing `point_type='window'` filter.

Both are read off the flat search result the agent *already has* — the trigger costs nothing extra to evaluate. We deliberately do **not** trigger on "the agent's answer was wrong", because at retrieval time there is no ground truth; the only honest, cheap signal is retrieval confidence.

### 6.2 When it is invoked

The trigger is evaluated at the retrieval boundary, in two places, so both the synchronous query API and the agent's own tool use are covered:

1. **`POST /api/reason/query` path** (`src/index.ts:1005`). When the query path performs its initial flat retrieval and the result is weak per §6.1, invoke the fallback and merge its ranked evidence into the context handed to the reasoning agent. The agent then reasons over flat + fallback evidence together.
2. **Agent tool path.** `search_memories` keeps its current window-only behaviour (no surprise change). A *new* tool — `recall_via_graph` — exposes the fallback explicitly so the agent can invoke it when its own flat `search_memories` came back thin. The agent is prompted (one added principle) to reach for `recall_via_graph` when `search_memories` returns nothing above the score floor. This keeps the agent in control and makes the fallback observable in the tool-call log.

Exposing it as both an automatic boundary check *and* an explicit tool is intentional: the boundary check guarantees coverage for the plain query API; the tool gives the agent agency and gives `nmemo-0wq.4` a clean call to count.

### 6.3 Cost guards

- **Single fire per query.** The fallback runs at most once per `/api/reason/query` invocation; it does not recurse (a fallback hit is not itself re-anchored). Enforced by the `invocationId` already minted at `src/index.ts:1012`.
- **Hard caps** on anchors (§4.1), neighbours (§3.3), hops (§3.2), and returned units (§5.3) bound the work regardless of graph shape.
- **Skip when anchorless** (§4.2) — the cheapest possible failure.

## 7. The `fact->unit` persistence decision (resolving `nmemo-yxj.6`)

`nmemo-yxj.6` deferred whether fact->unit links are **persisted at write** (a `fact_units` link table, or a `unit_ids[]` column on `facts`) or **computed on demand** at query time. The fallback is the consumer that forces the decision, so it is made here.

**Decision: persist at write, in a dedicated `fact_units` link table.** Rationale, weighing the three options the bead named:

| Option | Verdict |
|---|---|
| **`fact_units` link table (chosen)** | A row per (fact, unit) pair: `fact_id` (FK `public.facts`), `unit_point_id` (TEXT — the Qdrant unit point id, *not* an FK; units live in Qdrant, see below), `char_start`, `char_end`, `match_kind` (`offset_overlap` \| `window_fallback`). Indexed on `fact_id`. The fallback's hottest read — "given these neighbour facts, get their evidence units" — becomes one indexed join, not N per-fact offset recomputations. Additive: it does not touch `facts.source_memory_id`, which stays the canonical window (load-bearing for centroids and extract, per the yxj.6 lock). Many-to-many is natural (a fact can span several units, a unit can evidence several facts). |
| `unit_ids[]` array column on `facts` | Rejected. Mutates the `facts` row shape, complicates the additive guarantee, awkward for the per-unit `char_start`/`char_end`/`match_kind` metadata, and arrays don't index for the reverse lookup ("which facts does this unit evidence?") that future work (e.g. blast-radius at unit grain) will want. |
| Compute on demand at query time | Rejected as the default. Re-running offset overlap on every fallback adds per-query CPU and re-reads window content from Qdrant inside the latency-sensitive query path. The mapping is deterministic given (window content, units, fact source_text) and changes only when those change — so it belongs at write time. We keep compute-on-demand only as the **backfill / repair** mechanism (recompute links for facts written before the table existed, or after a unit re-split). |

**Why `unit_point_id` is a stored reference, not an FK.** Units are Qdrant points (`storeMemoryWithUnits`, `qdrant.ts:90`), not Postgres rows. The link table stores the Qdrant point id as TEXT and the fallback joins `fact_units → unit_point_id → Qdrant retrieve`. This is exactly the join the bead's "WRINKLE" note anticipated, now made the canonical access path.

**Write site.** Links are written post-hoc inside the same `store()`/`extract()` transaction that writes the units (yxj.2) and the facts — after extraction has produced fact `source_text` spans, map each span to covering unit offsets and insert `fact_units` rows. Falls back to a single `window_fallback` row when the span is not verbatim or repeats. This keeps the link write co-located with the data it links and inside the serial pipeline (no race).

**Schema sketch** (a Phase-appropriate migration, `0NN_fact_units.sql`, with the `public.` qualifier discipline from CLAUDE.md's AGE/search_path note):

```sql
CREATE TABLE IF NOT EXISTS public.fact_units (
  fact_id        UUID NOT NULL REFERENCES public.facts(id) ON DELETE CASCADE,
  unit_point_id  TEXT NOT NULL,                 -- Qdrant unit satellite point id (not an FK)
  char_start     INTEGER,
  char_end       INTEGER,
  match_kind     VARCHAR(20) NOT NULL DEFAULT 'offset_overlap',  -- offset_overlap | window_fallback
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_id, unit_point_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_units_fact ON public.fact_units (fact_id);
-- reverse lookup (unit -> facts) for future unit-grained analyses
CREATE INDEX IF NOT EXISTS idx_fact_units_unit ON public.fact_units (unit_point_id);
```

`match_kind` keeps the `window_fallback` accounting explicit so §3.4's instrumentation has a column to count.

This decision is the one piece of this doc that reaches back into `nmemo-yxj.6`: yxj.6 *produces* the mapping; this doc fixes *where it lives*. `nmemo-yxj.6` should adopt `fact_units` as its persistence target.

## 8. Interfaces for the implementation beads

The three downstream beads build against these contracts.

### 8.1 `nmemo-0wq.2` — neighbour expansion + evidence-unit fetch

New module `src/services/graph-fallback.ts`:

```typescript
export interface ExpandedEvidence { /* §3.4 shape */ }

// Given anchor entities, return unit-grained neighbour evidence per §3.
export async function expandFromAnchors(
  anchorEntityIds: string[],
  opts?: { maxHops?: number; maxNeighbours?: number },
): Promise<ExpandedEvidence[]>;
```

Reuses `findConnectedEntities` (`graph.ts:226`), `getEntityFacts` (`facts.ts:773`), the new `fact_units` table (§7), and Qdrant `retrieve` for unit text/vectors. Acceptance: given an anchor, returns neighbour facts with their evidence **units** (never whole windows), honouring the §3 caps.

### 8.2 `nmemo-0wq.3` — failure trigger + re-rank, integrated

```typescript
// Decide whether flat retrieval failed (§6.1) from the flat result the caller already has.
export function flatRetrievalFailed(flatHits: FlatHit[]): boolean;

// Anchor (§4) → expand (§3) → re-rank (§5). Returns ranked unit evidence, or [] when anchorless.
export async function recallViaGraph(query: string, flatHits: FlatHit[]): Promise<RankedUnit[]>;
```

Wires into `POST /api/reason/query` (`src/index.ts:1005`) as the boundary check (§6.2.1) and adds the `recall_via_graph` MCP tool to `GRAPH_TOOLS` (`causal-agent.ts:83`) plus one reasoning-agent prompt principle (§6.2.2). Acceptance: a failing flat query with a reachable neighbour answer is recovered; successful flat queries are untouched (trigger fires only on §6.1 failure).

### 8.3 `nmemo-0wq.4` — eval on LongMemEval multi-session

Measures recall uplift on multi-session/reasoning questions where flat retrieval misses, and records trigger cost (extra Qdrant reads + graph walk latency per fired query, plus `fallback_skipped_no_anchor` rate from §4.2). Acceptance: recall uplift demonstrated on ≥1 (ideally a set of) LongMemEval multi-session questions versus flat retrieval, with trigger cost recorded.

## 9. Out of scope (explicit)

- **Graph C traversal in the fallback.** Causal edges answer "why"; recall recovery is a "what" problem. Folding Graph C into the walk is future work.
- **LLM / cross-encoder re-ranker.** Cosine + structural signals first (§5.3); upgrade only if eval shows the ordering is insufficient.
- **Anchor fabrication / whole-graph broadening.** The no-anchor case returns empty (§4.2). Recovering recall when nothing anchors is a different problem (entity-mention extraction quality, alias coverage) tracked elsewhere.
- **Re-anchoring fallback hits.** Single fire per query (§6.3); no recursive expansion.
- **Moving canonical provenance.** `facts.source_memory_id` stays the window. This epic only *reads* the additive `fact_units` links (§7).

## 10. Open questions resolved here / flagged

- **Resolved — fact->unit persistence:** `fact_units` link table, persist-at-write, compute-on-demand kept only for backfill (§7). This is the decision `nmemo-yxj.6` deferred to this epic.
- **Resolved — trigger signal:** retrieval confidence (top flat score vs floor), not answer correctness, because correctness is not observable at retrieval time (§6.1).
- **Resolved — re-rank grain:** unit-grained cosine, because window centroids blur the signal (§5.1).
- **Flagged for `nmemo-0wq.4` to settle empirically:** the default thresholds (`FALLBACK_TRIGGER_MIN_SCORE=0.5`, `FALLBACK_MAX_HOPS=1`, `FALLBACK_MAX_NEIGHBOURS=20`) and re-rank weights are ship-and-tune starting points, not fixed constants; the eval bead reports the values it lands on.

## 11. References

### Existing code anchored
- `src/services/causal-agent.ts:83` — `GRAPH_TOOLS`; `:1277` `query_entity_facts`, `:1318` `query_entity_neighbours`, `:1329` `search_similar_entities`, `:1344` `search_memories`, `:1366` `get_memory_text`
- `src/services/graph.ts:226` — `findConnectedEntities()` (AGE Cypher neighbour walk)
- `src/services/facts.ts:773` — `getEntityFacts()`
- `src/services/qdrant.ts` — `:90` `storeMemoryWithUnits` (window + unit satellites), `:121` `searchMemories`, `:175` `getMemoryVectors`
- `src/services/topology.ts` — `entity_topology` reads (pagerank for §3.3 tie-break)
- `src/services/predicates.ts` — canonical predicate vocabulary (§3.3, §5.2)
- `src/db/schema.ts:118` — `facts` (subject/object/source_memory_id/source_text); `:171` `fact_sources`
- `src/index.ts:1005` — `POST /api/reason/query` (integration point, §6.2.1)

### Existing docs
- `01-dual-graph-architecture.md` — Graph S / Graph C split this epic respects (Graph S only)
- `10-reasoning-layer-overview.md` — reasoning agent + query/patrol surface this extends
- `25-cross-cluster-generator.md` §7.4 — the ship-and-tune weight protocol mirrored in §5.2

### Beads
- Epic `nmemo-0wq`; this doc closes `nmemo-0wq.1`
- Depends on `nmemo-yxj.6` (fact->unit links — §7 fixes its persistence target)
- Implemented by `nmemo-0wq.2` (§8.1), `nmemo-0wq.3` (§8.2), `nmemo-0wq.4` (§8.3)

---

*Design-only bead. No code, schema, or migration ships with `nmemo-0wq.1` — the `0NN_fact_units.sql` sketch and `graph-fallback.ts` signatures are contracts for the implementation beads, not deliverables of this one.*
