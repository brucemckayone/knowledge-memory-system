# Phase 3 — Source Reference Indexing

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Size:** S
**Depends on:** Phase 1 (audit trail — writes history on ref changes)
**Blocks:** Phase 4 (blast radius needs reverse lookup)

## Purpose

`causal_edges.source_references` is a JSONB array of `{ type, id, relevance }` tuples. Every causal edge carries its evidence trail here.

Forward traversal (given an edge, what does it cite?) is trivial — read the JSONB. **Reverse traversal (given a fact or memory, what edges cite it as evidence?) is not.** JSONB containment queries work but can't be efficiently indexed for this pattern on wide datasets.

We need reverse traversal for:
- **Cascade invalidation** (Phase 2): when fact F expires, find edges citing F
- **Blast radius** (Phase 4): "what edges would lose evidence if this fact changed?"
- **Contradiction detection** (Phase 5): "this fact is expired — are there still active edges citing it?"
- **Gardener / reasoner context**: "this memory is being deleted — what depends on it?"

Solution: a denormalised join table indexed for fast reverse lookup. JSONB stays as the authoritative forward-facing format; the join table is a derived read index.

## Data Model

```sql
-- platform/src/db/migrations/010_source_ref_index.sql

CREATE TABLE public.edge_source_refs (
  edge_id     UUID NOT NULL REFERENCES public.causal_edges(id) ON DELETE CASCADE,
  ref_type    VARCHAR(10) NOT NULL,
  ref_id      UUID NOT NULL,
  relevance   TEXT,
  PRIMARY KEY (edge_id, ref_type, ref_id),

  CONSTRAINT valid_ref_type CHECK (ref_type IN ('memory', 'fact', 'entity'))
);

CREATE INDEX idx_edge_source_refs_lookup
  ON public.edge_source_refs (ref_type, ref_id);

CREATE INDEX idx_edge_source_refs_edge
  ON public.edge_source_refs (edge_id);
```

### Design Notes

**`ON DELETE CASCADE`** — if an edge is hard-deleted (rare; usually we expire instead), its refs go with it.

**No FK to facts/entities/memories** — references can be to memories in Qdrant (not in postgres) and we don't want hard cross-table constraints. The service layer validates `ref_id` exists when it matters; stale refs are acceptable (they just don't match any lookup).

**Primary key on `(edge_id, ref_type, ref_id)`** — an edge can cite the same reference multiple times logically but only once physically. Deduplication happens at write time.

**No `created_at`** — the ref table is a read index, not a timeline. Audit of when a ref was added lives in `causal_edge_history.added_source_refs`.

## Relationship to JSONB

```d2
direction: right

edge: "causal_edges row" {
  id: "id"
  source_references: "source_references\n(JSONB, authoritative)"
  other: "strength, reasoning,\ntemporal_span, ..."
}

index: "edge_source_refs" {
  row1: "edge_id, memory, mem-uuid-1"
  row2: "edge_id, fact, fact-uuid-1"
  row3: "edge_id, fact, fact-uuid-2"
}

history: "causal_edge_history" {
  added_source_refs: "added_source_refs\n(JSONB, audit delta)"
}

facts_table: "facts" {
  fact_row: "fact uuid-1"
}

memories: "Qdrant memories" {
  mem_row: "memory uuid-1"
}

edge.source_references -> index: "service-layer sync\non INSERT / corroborate"
edge.source_references -> history.added_source_refs: "delta on each change"
index.row2 -> facts_table.fact_row: "logical\n(no FK)"
index.row1 -> memories.mem_row: "logical\n(no FK)"
```

## Service Layer Changes

### Sync Helper — `platform/src/services/audit.ts`

```typescript
export async function syncEdgeSourceRefs(
  edgeId: string,
  refs: SourceReference[],
): Promise<void> {
  if (refs.length === 0) return;
  // Upsert: ignore duplicates. Using ON CONFLICT DO NOTHING on primary key.
  await db.insert(edgeSourceRefs)
    .values(refs.map(r => ({ edgeId, refType: r.type, refId: r.id, relevance: r.relevance })))
    .onConflictDoNothing();
}
```

### Integration — `createCausalEdge`

After INSERT or corroboration, call `syncEdgeSourceRefs`:

```typescript
// INSERT path
const edgeId = await insertNewEdge(params);
await syncEdgeSourceRefs(edgeId, params.sourceReferences);
await recordEdgeChange({ ..., eventType: 'created' });

// Corroboration path
const newRefs = diffSourceReferences(existing, merged);
await syncEdgeSourceRefs(existing.id, newRefs);
await recordEdgeChange({ ..., eventType: 'corroborated', addedSourceRefs: newRefs });
```

### Reverse Lookup Function

```typescript
// platform/src/services/causal.ts

export async function findEdgesCitingReference(
  refType: 'memory' | 'fact' | 'entity',
  refId: string,
  options: { includeExpired?: boolean } = {},
): Promise<CausalEdge[]> {
  const rows = await db
    .select({ edge: causalEdges })
    .from(edgeSourceRefs)
    .innerJoin(causalEdges, eq(edgeSourceRefs.edgeId, causalEdges.id))
    .where(and(
      eq(edgeSourceRefs.refType, refType),
      eq(edgeSourceRefs.refId, refId),
      options.includeExpired ? undefined : isNull(causalEdges.expiredAt),
    ));
  return rows.map(r => r.edge);
}
```

## Migration — Backfill

Every existing causal edge has populated `source_references`. Migration 010 backfills the index:

```sql
-- Backfill edge_source_refs from existing JSONB
INSERT INTO public.edge_source_refs (edge_id, ref_type, ref_id, relevance)
SELECT
  e.id,
  (ref->>'type')::varchar,
  (ref->>'id')::uuid,
  ref->>'relevance'
FROM public.causal_edges e
CROSS JOIN LATERAL jsonb_array_elements(e.source_references) ref
WHERE ref->>'type' IN ('memory', 'fact', 'entity')
  AND ref->>'id' IS NOT NULL
ON CONFLICT (edge_id, ref_type, ref_id) DO NOTHING;
```

Run-once. If migration is re-run idempotently, `ON CONFLICT DO NOTHING` keeps it safe.

## Drift Detection

A drift between JSONB and the join table is possible if a code path forgets to sync. Add a `bd` issue or periodic check:

```sql
-- Drift query: edges whose JSONB has refs not in the index
SELECT e.id, e.source_references
FROM causal_edges e
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(e.source_references) ref
  WHERE NOT EXISTS (
    SELECT 1 FROM edge_source_refs r
    WHERE r.edge_id = e.id
      AND r.ref_type = (ref->>'type')
      AND r.ref_id = (ref->>'id')::uuid
  )
);
```

Optional: a scheduled `bd` check that runs this monthly and alerts if drift > 0.

## Schema Additions — Drizzle

```typescript
// platform/src/db/schema.ts

export const edgeSourceRefs = pgTable('edge_source_refs', {
  edgeId: uuid('edge_id').notNull().references(() => causalEdges.id, { onDelete: 'cascade' }),
  refType: varchar('ref_type', { length: 10 }).notNull(),
  refId: uuid('ref_id').notNull(),
  relevance: text('relevance'),
}, (t) => ({
  pk: primaryKey({ columns: [t.edgeId, t.refType, t.refId] }),
  lookupIdx: index('idx_edge_source_refs_lookup').on(t.refType, t.refId),
  edgeIdx: index('idx_edge_source_refs_edge').on(t.edgeId),
}));

export type EdgeSourceRef = typeof edgeSourceRefs.$inferSelect;
```

## Test Design

### Test File: `platform/src/test/harness/source-refs-index.test.ts`

```typescript
describe('Phase 3 — Source Reference Indexing', () => {
  beforeEach(async () => {
    await deleteFromTables(
      'edge_source_refs',
      'causal_edge_history', 'fact_history',
      'causal_edges', 'causal_events',
      'memory_entities', 'entity_aliases', 'facts',
      'entity_merges', 'entities',
    );
  });

  describe('sync on edge creation', () => {
    it('populates edge_source_refs when createCausalEdge inserts', async () => {
      const memoryId = randomUUID();
      const factId = await setupFact();
      const edgeId = await createCausalEdge({
        ...,
        sourceReferences: [
          { type: 'memory', id: memoryId, relevance: 'explicit mention' },
          { type: 'fact', id: factId, relevance: 'contradicts' },
        ],
        actor: 'graph_agent',
      });

      const rows = await testDb.select().from(edgeSourceRefs).where(eq(edgeSourceRefs.edgeId, edgeId));
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.refType === 'memory')!.refId).toBe(memoryId);
      expect(rows.find(r => r.refType === 'fact')!.refId).toBe(factId);
    });

    it('deduplicates identical refs within a single insert', async () => {
      const memoryId = randomUUID();
      const edgeId = await createCausalEdge({
        ...,
        sourceReferences: [
          { type: 'memory', id: memoryId, relevance: 'a' },
          { type: 'memory', id: memoryId, relevance: 'b' },  // same ref
        ],
        actor: 'graph_agent',
      });
      const rows = await testDb.select().from(edgeSourceRefs).where(eq(edgeSourceRefs.edgeId, edgeId));
      expect(rows).toHaveLength(1);
    });
  });

  describe('sync on corroboration', () => {
    it('adds new refs to the index when corroborating an existing edge', async () => {
      const mem1 = randomUUID();
      const mem2 = randomUUID();
      const edgeId = await createCausalEdge({ ..., sourceReferences: [{ type: 'memory', id: mem1, relevance: 'a' }], actor: 'graph_agent' });
      await createCausalEdge({
        /* same cause/effect */
        ...,
        sourceReferences: [{ type: 'memory', id: mem2, relevance: 'b' }],
        actor: 'reasoning_agent',
      });

      const rows = await testDb.select().from(edgeSourceRefs).where(eq(edgeSourceRefs.edgeId, edgeId));
      expect(rows).toHaveLength(2);
    });

    it('does not duplicate existing refs on corroboration with same ref', async () => {
      const mem1 = randomUUID();
      const edgeId = await createCausalEdge({ ..., sourceReferences: [{ type: 'memory', id: mem1, relevance: 'a' }], actor: 'graph_agent' });
      await createCausalEdge({ /* same pair */ ..., sourceReferences: [{ type: 'memory', id: mem1, relevance: 'b' }], actor: 'reasoning_agent' });

      const rows = await testDb.select().from(edgeSourceRefs).where(eq(edgeSourceRefs.edgeId, edgeId));
      expect(rows).toHaveLength(1);
    });
  });

  describe('reverse lookup', () => {
    it('findEdgesCitingReference returns edges citing the fact', async () => {
      const factId = await setupFact();
      const edge1 = await setupEdgeCitingFact(factId);
      const edge2 = await setupEdgeCitingFact(factId);
      const edge3 = await setupEdge();  // does not cite

      const found = await findEdgesCitingReference('fact', factId);
      expect(found.map(e => e.id).sort()).toEqual([edge1, edge2].sort());
      expect(found.map(e => e.id)).not.toContain(edge3);
    });

    it('excludes expired edges by default', async () => {
      const factId = await setupFact();
      const edge1 = await setupEdgeCitingFact(factId);
      const edge2 = await setupEdgeCitingFact(factId);
      await expireCausalEdge({ edgeId: edge2, reasoning: 'test', actor: 'user' });

      const found = await findEdgesCitingReference('fact', factId);
      expect(found.map(e => e.id)).toEqual([edge1]);
    });

    it('includes expired edges when includeExpired=true', async () => {
      const factId = await setupFact();
      const edge1 = await setupEdgeCitingFact(factId);
      const edge2 = await setupEdgeCitingFact(factId);
      await expireCausalEdge({ edgeId: edge2, reasoning: 'test', actor: 'user' });

      const found = await findEdgesCitingReference('fact', factId, { includeExpired: true });
      expect(found).toHaveLength(2);
    });

    it('returns empty array when no edges cite the reference', async () => {
      const found = await findEdgesCitingReference('fact', randomUUID());
      expect(found).toEqual([]);
    });

    it('discriminates between ref types — memory lookup does not return fact-typed refs with same ID', async () => {
      // Contrived but important: a fact and a memory might (by accident) share a UUID
      const sharedId = randomUUID();
      const factEdge = await setupEdge({ sourceReferences: [{ type: 'fact', id: sharedId, relevance: 'a' }] });
      const memEdge = await setupEdge({ sourceReferences: [{ type: 'memory', id: sharedId, relevance: 'a' }] });

      const factResults = await findEdgesCitingReference('fact', sharedId);
      expect(factResults).toHaveLength(1);
      expect(factResults[0].id).toBe(factEdge);

      const memResults = await findEdgesCitingReference('memory', sharedId);
      expect(memResults).toHaveLength(1);
      expect(memResults[0].id).toBe(memEdge);
    });
  });

  describe('cascade integration', () => {
    it('cascadeFactExpiry uses the index for fast lookup', async () => {
      // This is implicitly covered by Phase 2 cascade tests, but
      // explicitly measure that cascade runs <100ms for 100 edges.
      const factId = await setupFact();
      for (let i = 0; i < 100; i++) {
        await setupEdgeCitingFact(factId, { corroborationCount: 1 });
      }
      const t0 = Date.now();
      await expireFact({ factId, reasoning: 'test', actor: 'user' });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(500);  // loose bound
    });
  });

  describe('backfill', () => {
    it('existing causal_edges rows have entries in edge_source_refs after migration', async () => {
      const allEdges = await testDb.select().from(causalEdges);
      for (const edge of allEdges.slice(0, 5)) {
        if ((edge.sourceReferences as any[]).length === 0) continue;
        const refs = await testDb.select().from(edgeSourceRefs).where(eq(edgeSourceRefs.edgeId, edge.id));
        expect(refs.length).toBeGreaterThan(0);
      }
    });
  });

  describe('drift detection', () => {
    it('drift query returns 0 rows on a consistent DB', async () => {
      const result = await testDb.execute(sql`
        SELECT COUNT(*) AS n
        FROM causal_edges e
        WHERE EXISTS (
          SELECT 1
          FROM jsonb_array_elements(e.source_references) ref
          WHERE NOT EXISTS (
            SELECT 1 FROM edge_source_refs r
            WHERE r.edge_id = e.id
              AND r.ref_type = (ref->>'type')
              AND r.ref_id = (ref->>'id')::uuid
          )
        )
      `);
      expect(result.rows[0].n).toBe(0);
    });
  });
});
```

### Coverage Targets

- [ ] `createCausalEdge` sync populates index
- [ ] Corroboration adds new refs, skips existing
- [ ] Reverse lookup returns correct edges
- [ ] Expired edges excluded by default
- [ ] `includeExpired` flag works
- [ ] Type discrimination correct
- [ ] Cascade performance acceptable (<500ms for 100 edges)
- [ ] Backfill populated existing rows
- [ ] Drift query returns 0 on clean DB

## Test Data Requirements

See [doc 18 — Test Data Hardening Protocol](18-test-data-hardening-protocol.md).

### Fixture Inventory

```
platform/src/test/data/phase3-sourcerefs/
├── fixtures/
│   ├── single-ref.sql                     # L1 — one edge, one ref
│   ├── multi-ref.sql                      # L1 — one edge, 5 refs (mix types)
│   ├── duplicate-refs-same-type.sql       # L1 — edge cites same memory twice
│   ├── shared-ref-across-edges.sql        # L1 — 10 edges cite same fact
│   ├── reverse-lookup-at-scale.sql        # L2 — 1000 edges, 500 refs
│   ├── drift-simulated.sql                # adversarial — JSONB populated but index missing
│   └── corrupt-ref-type.sql               # adversarial — invalid ref_type in JSONB
├── expected/
└── benchmark-reports/
```

### Benchmark Metrics

| Metric | Target |
|--------|--------|
| `findEdgesCitingReference` (1000-edge graph) | <50ms |
| `syncEdgeSourceRefs` per-edge | <10ms |
| Backfill migration throughput | ≥1000 edges/sec |
| Drift query (full-scan) | <500ms on 1000 edges |
| No duplicate rows after multiple syncs | 100% |
| Reverse-lookup correctness (type discrimination) | 100% |

### Adversarial

- **Massive reverse lookup**: fact cited by 500 edges. Query response time.
- **Corrupt JSONB**: edge with malformed source_references array. Sync should skip corrupt entries gracefully.
- **FK violation**: ref_id pointing to non-existent fact (acceptable — table is derived, no FK to facts/memories).
- **Concurrent sync**: two parallel `createCausalEdge` for different edges both syncing. Assert no cross-contamination.

### Graduation

Level 1 → Level 2 when backfill is idempotent, reverse-lookup performance holds at 1000 edges, no drift detected post-migration.

## Acceptance Criteria

Phase 3 is complete when:

- [ ] Migration `010_source_ref_index.sql` applied
- [ ] Backfill populated for all existing edges with non-empty `source_references`
- [ ] `createCausalEdge` and corroboration path both sync to index
- [ ] `findEdgesCitingReference` callable, returns correct results
- [ ] Cascade invalidation (from Phase 2) now runs efficiently
- [ ] All tests pass
- [ ] Drift query returns 0 rows

## File Inventory

### New
- `platform/src/db/migrations/010_source_ref_index.sql`
- `platform/src/test/harness/source-refs-index.test.ts`

### Modified
- `platform/src/db/schema.ts` — `edgeSourceRefs` table
- `platform/src/services/audit.ts` — `syncEdgeSourceRefs` helper
- `platform/src/services/causal.ts` — call sync on create + corroborate, `findEdgesCitingReference` function

## Beads Issues

Parent: **nmemo-d1r** (Phase 3)

- **nmemo-d1r.1** — [migration] 010_source_ref_index.sql with backfill
- **nmemo-d1r.2** — [schema] Drizzle schema for edgeSourceRefs
- **nmemo-d1r.3** — [service] syncEdgeSourceRefs helper
- **nmemo-d1r.4** — [service] findEdgesCitingReference query function
- **nmemo-d1r.5** — [integration] Wire sync into createCausalEdge insert + corroborate paths
- **nmemo-d1r.6** — [test] source-refs-index.test.ts passing
- **nmemo-d1r.7** — [optional] Periodic drift detection (scheduled or CI)

Downstream consumers (blocked until Phase 3 ships): **nmemo-e2i.4** (cascade), **nmemo-437.3** (citation dependents), **nmemo-cae.4** (expired-but-cited detection).

`bd show nmemo-d1r` for full tree.

## Exit Criteria → Phase 4

Phase 4 (Blast Radius) begins when:
1. Phase 3 acceptance met
2. `findEdgesCitingReference` returns correct results
3. Phase 2 cascade tests pass using the new index
