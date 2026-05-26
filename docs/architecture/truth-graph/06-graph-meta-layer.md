# Graph Meta Layer — Entity Resolution via Source Analysis

**Status:** Phase 1 implementation
**Branch:** `feat/sparse-truth-graph`
**Date:** 2026-04-14

## Purpose

The knowledge graph has an entity resolution problem that can't be solved by embedding entity names. "R. Walton" and "Robert Walton" are the same person. "Margaret" and "Mrs. Saville" are the same person. But "the stranger" and "Victor Frankenstein" are the same person with *different narrative meaning* — merging them loses information.

The current approach (embed bare entity names into pgvector, compare cosine similarity) is fundamentally broken: 109 out of 325 entity pairs have similarity=1.0 because short proper nouns through nomic-embed-text produce nearly identical vectors. The embedding column on the entities table encodes "this is a short English word" not "this is London vs Shakespeare."

**The key insight: entities don't need their own embeddings.** They inherit semantic meaning from the source material they're linked to. Every entity is already linked to source memories in Qdrant via `memory_entities`. Those source vectors carry the real signal.

**Graph Meta** is a lightweight analysis layer that sits alongside Graph S (knowledge) and Graph C (causality). It computes per-entity statistics from source vectors and graph structure, stages merge candidates through a confidence lifecycle, and provides data for reconciliation decisions.

```
Graph S  = what we know      (entities, facts, bi-temporal)
Graph C  = why things changed (causal events, causal edges)
Graph M  = what the graph looks like (entity stats, merge candidates, cluster structure)
```

## Three Resolution Signals

### Signal 1: Source Vector Centroid Similarity

Each entity is mentioned in N source memories. Each memory has a 768-dim vector in Qdrant. The entity's **centroid** is the mean of those vectors — its position in semantic space based on the contexts where it's actually discussed.

Compare centroids between entity pairs. If two entities' source contexts land in the same region of embedding space, they're likely the same entity.

**Why this works:** "R. Walton" appears in letters about Arctic exploration. "Robert Walton" appears in the same letters. Their centroids converge. "The stranger" appears in rescue/Arctic context. "Victor Frankenstein" appears in Geneva/family context. Their centroids diverge.

**Computed incrementally:** When a new mention is added, update the running centroid (weighted average). No full recomputation needed.

### Signal 2: Source Memory Overlap

Do two entities appear in the same documents? Margaret and Mrs. Saville share 3 out of 7 source memories (Jaccard=0.43). That's direct co-occurrence — the strongest evidence of co-reference.

R. Walton and Robert Walton share 0 memories (different letter signatures in different chunks) but this is expected for abbreviation variants. Overlap catches co-reference patterns where the same text uses both names for the same referent.

**Computed cheaply:** JOIN on `memory_entities` grouped by `memory_id`.

### Signal 3: Graph Structural Similarity

Two entities that share fact targets play the same role in the graph. R. Walton and Robert Walton both have:
- `sibling_of → Margaret`
- `writes_to → Mrs. Saville`
- `visited → Archangel`

Three shared outgoing facts is overwhelming structural evidence of identity. The stranger and Victor Frankenstein share zero facts — correctly distinct.

**Computed from:** Active `facts` table — compare outgoing `(predicate, object_entity_id)` sets with Jaccard similarity.

## Combined Score

```
merge_score = w1 * centroid_similarity + w2 * memory_overlap + w3 * structural_similarity
```

Initial weights (tune via benchmarking):
- **w1 = 0.3** — centroid: useful but noisy for low-mention entities
- **w2 = 0.4** — memory overlap: strongest direct evidence
- **w3 = 0.3** — structural: strong but can false-positive on generic relationships like `lives_in → England`

Threshold tiers:
- **score > 0.8**: Auto-merge candidate → stage as `candidate`
- **score 0.5-0.8**: Review candidate → stage as `staging`
- **score < 0.5**: Not a merge candidate

**Minimum data requirement:** At least one entity in the pair must have 3+ source mentions. Below that, centroid and overlap are noise — don't compute.

## Resolution Types

Not all identity matches should be merges:

- **merge**: Same entity, same meaning. Collapse into one node. *R. Walton → Robert Walton*
- **alias**: Same entity, different surface form. Add alias, keep canonical name. *Margaret ← Mrs. Saville*
- **link**: Same real-world referent, different narrative meaning. Create `same_as` edge but keep both nodes. *the stranger ↔ Victor Frankenstein*
- **distinct**: Confirmed different entities. Don't recompute.

The distinction between merge/alias and link is critical. "The stranger" carries narrative meaning — mystery, outsider, the unnamed. Merging it into "Victor Frankenstein" destroys that meaning. A `same_as` link preserves both nodes while recording that they refer to the same person.

## Schema

### `entity_meta` — per-entity statistics

```sql
CREATE TABLE public.entity_meta (
  entity_id         UUID PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,
  mention_count     INTEGER NOT NULL DEFAULT 0,
  source_memory_count INTEGER NOT NULL DEFAULT 0,
  fact_count        INTEGER NOT NULL DEFAULT 0,
  centroid          VECTOR(768),
  spread            FLOAT,
  first_mentioned_at TIMESTAMPTZ,
  last_mentioned_at TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Living Summary (see [doc 37](37-entity-living-summary.md)):** `entity_meta` also carries an agent-authored `summary TEXT` column added in migration 004 (and a paired `summary_updated_at TIMESTAMPTZ` post-bead `nmemo-2yv.51`). That feature is documented in 37 — owner of the writers (causal agent's `update_entity_summary` tool), the readers (`entity-profile.ts` assembler + agent-loop tool results), the T8 prompt-safety contract, and the optimistic-locking semantics. `entity_meta` is multi-feature territory: this doc owns the statistical columns (mention_count, centroid, spread, fact_count); doc 37 owns the summary column.

### `merge_candidates` — pairwise analysis

```sql
CREATE TABLE public.merge_candidates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_a_id       UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  entity_b_id       UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  centroid_similarity FLOAT,
  memory_overlap    FLOAT,
  structural_similarity FLOAT,
  combined_score    FLOAT NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'staging',
  detection_count   INTEGER NOT NULL DEFAULT 1,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution        VARCHAR(20),
  resolution_reasoning TEXT,
  resolved_at       TIMESTAMPTZ,
  resolved_by       VARCHAR(50),
  UNIQUE(entity_a_id, entity_b_id),
  CHECK(entity_a_id < entity_b_id),
  CONSTRAINT valid_status CHECK (status IN ('staging', 'candidate', 'provisional', 'resolved'))
);
```

## When It Triggers

After extraction completes, if newly created/updated entities meet the minimum data threshold (3+ mentions OR 2+ shared facts with any existing entity). The pipeline calls `updateEntityMeta()` for touched entities, then `detectMergeCandidates()` for new high-scoring pairs.

Not after every extraction. Only when enough data has accumulated. The check is cheap: count mentions, bail out early if below threshold.

## Reconciliation Agent

A specialized LLM agent that reads merge candidates, inspects entities via MCP tools (facts, source texts, graph neighbors), and decides merge/alias/link/distinct. Uses the existing `merge_entities()` SQL function for merges. Records reasoning in `merge_candidates.resolution_reasoning`.

**Canonical design:** [doc 35](35-reconciliation-agent.md). The agent shipped post-`005_reconciliation.sql` and has been auto-triggered from the pipeline since bead `nmemo-2yv.61`.

## Graph-Level Statistics (Phase 2+)

Entity meta covers each node. Merge candidates cover pairs. But nothing describes the **graph itself** — its shape, its cultures, its statistical properties. The merge candidate scoring needs this context to interpret pair-level signals correctly.

### The adaptive weighting problem

In a single-source graph (all Frankenstein), centroid similarities cluster at 0.95-1.0. The signal is saturated — it doesn't discriminate between entities. But in a multi-source graph (Frankenstein + work emails + research papers), centroids spread across distinct clusters and the signal becomes highly discriminative.

A fixed weight on centroid similarity is wrong in both cases. The weight should adapt based on the graph's source diversity. But adapting on raw stdev assumes a normal distribution and collapses the interesting structure into one number. The real structure is **cultures** — clusters of entities sharing source context.

### What a `graph_stats` table tracks

A single row (or one per snapshot for history) describing the graph as a whole:

```sql
CREATE TABLE public.graph_stats (
  id                    INTEGER PRIMARY KEY DEFAULT 1,  -- singleton row

  -- Scale
  total_entities        INTEGER,
  total_facts           INTEGER,
  total_memories        INTEGER,

  -- Source cultures (embedding space clusters)
  culture_count         INTEGER,            -- number of distinct source clusters
  mean_intra_distance   FLOAT,              -- avg distance within clusters (tightness)
  mean_inter_distance   FLOAT,              -- avg distance between clusters (separation)
  
  -- Centroid distribution (inputs to adaptive weighting)
  centroid_sim_mean     FLOAT,              -- mean pairwise centroid similarity
  centroid_sim_median   FLOAT,
  centroid_sim_p10      FLOAT,              -- 10th percentile (where the outliers live)
  centroid_sim_p90      FLOAT,              -- 90th percentile

  -- Graph health
  fact_density          FLOAT,              -- facts per entity
  orphan_rate           FLOAT,              -- fraction of entities with zero facts
  predicate_diversity   INTEGER,            -- distinct predicates in use
  merge_candidates_pending INTEGER,

  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### How it feeds adaptive weighting

The merge candidate scorer reads graph stats before scoring. Instead of fixed weights:

```
effective_centroid_weight = f(
  culture_count,          -- more cultures → centroid more discriminative
  centroid_sim_p90 - centroid_sim_p10,  -- wider spread → more signal
  total_entities,         -- more data → more stable stats
  intra/inter distance ratio  -- well-separated clusters → centroid matters more
)
```

When the graph has one culture (single source, tight cluster), the function reduces centroid weight and redistributes to structural and memory overlap signals. When the graph has multiple well-separated cultures, centroid weight increases because it carries real information.

A pair of entities within the same tight cluster: centroid similarity is high but unremarkable — everyone in that cluster scores similarly. A pair that bridges two clusters or has surprisingly low centroid similarity within a cluster: that's genuinely informative.

### What this enables beyond merge scoring

- **Viz dashboard**: "1 source culture, 11% orphan rate, 2 merge candidates pending"
- **Ingestion monitoring**: culture_count increases when a new source type is added
- **Quality alerts**: orphan_rate spikes when extraction quality degrades
- **Scaling signals**: when total_entities crosses thresholds, reconciliation strategy may need to change (pairwise comparison doesn't scale past ~1000 entities without candidate pre-filtering)

## Future: Extended Graph Meta (Phase 3+)

The meta layer could expand to track:
- **Cluster membership per entity** — which culture does each entity belong to? Enables "show me all entities from source cluster X"
- **Anomaly detection** — orphan entities, contradictory facts, temporal inconsistencies
- **Embedding drift** — how an entity's source context changes over time (signals identity transitions like "the stranger" → "Victor Frankenstein")
- **Predicate evolution** — which predicates are emerging, which are stabilizing, which are being superseded
