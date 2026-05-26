# Phase 5 — Contradiction Detection

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Size:** M
**Depends on:** Phase 1 (audit trail — resolutions write history)
**Blocks:** None (ships capability)

## Purpose

When reasoning chains reach opposing conclusions about the same fact or relationship, the system should flag the conflict rather than silently holding both. Two rules:

- **Detection is cheap and side-effect-free.** SQL heuristics + agent noticing during patrol.
- **Resolution is thoughtful and auditable.** Reasoning agent weighs evidence, picks a side, expires the weaker claim, writes the resolution to audit.

Contradictions surface as first-class records in the system — viewable, filterable, resolvable. The viz shows a count badge. The agent prioritises them on patrol.

## Types of Contradictions

```d2
direction: right

types: "Contradiction Types" {
  opposing: "opposing_object\n(same subject+predicate,\ndifferent object, both active)" {
    style.fill: "#f8d7da"
  }
  expired_cited: "expired_but_cited\n(expired fact still\nin active edge refs)" {
    style.fill: "#fff3cd"
  }
  cyclic: "cyclic_causal\n(A→B and B→A with\nno temporal separation)" {
    style.fill: "#fff3cd"
  }
  temporal: "temporal_impossible\n(cause occurred_at >\neffect occurred_at)" {
    style.fill: "#f8d7da"
  }
  chain_conflict: "chain_conflict\n(two chains reach\nopposing conclusions)" {
    style.fill: "#cfe8ff"
  }
}

detection: "Detection Method" {
  sql: "SQL Heuristic\n(periodic)" {
    style.fill: "#d4edda"
  }
  agent: "Reasoning Agent\n(patrol)" {
    style.fill: "#cfe8ff"
  }
}

types.opposing -> detection.sql
types.expired_cited -> detection.sql
types.cyclic -> detection.sql
types.temporal -> detection.sql
types.chain_conflict -> detection.agent
```

Types explained:

1. **opposing_object** — `(subject_entity_id, predicate)` has two or more distinct active facts with different objects. Example: `(John, works_at, Acme)` and `(John, works_at, Globex)` both active, both undated. One (or both) is wrong, or they need temporal windowing.
2. **expired_but_cited** — An expired fact is still listed in `source_references` of an active causal edge. The edge's grounding is compromised.
3. **cyclic_causal** — Edge A→B and edge B→A are both active, and neither has `temporal_span` set. True causality requires temporal ordering; a cycle without temporal separation is a modelling error.
4. **temporal_impossible** — An edge asserts cause → effect, but the cause event's `occurred_at` is after the effect event's `occurred_at`. Effect can't precede cause.
5. **chain_conflict** — Two reasoning chains reach opposing conclusions about the same fact. Requires semantic understanding; detected by the reasoning agent during patrol.

## Data Model

### Migration `011_contradictions.sql`

```sql
CREATE TABLE public.contradictions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contradiction_type       VARCHAR(32) NOT NULL,

  -- Polymorphic node references (at least one non-null)
  fact_a_id                UUID REFERENCES public.facts(id),
  fact_b_id                UUID REFERENCES public.facts(id),
  edge_a_id                UUID REFERENCES public.causal_edges(id),
  edge_b_id                UUID REFERENCES public.causal_edges(id),
  entity_id                UUID REFERENCES public.entities(id),

  -- Detection metadata
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by              VARCHAR(32) NOT NULL,
  detection_reasoning      TEXT NOT NULL,
  detection_context        JSONB,                   -- supporting evidence
  severity                 VARCHAR(10) NOT NULL DEFAULT 'medium',

  -- Resolution
  resolved_at              TIMESTAMPTZ,
  resolved_by              VARCHAR(32),
  resolution_type          VARCHAR(20),
  resolution_reasoning     TEXT,
  resolution_report_id     UUID REFERENCES public.reasoning_reports(id),

  -- Dismissal / lifecycle
  dismissed_reason         TEXT,

  CONSTRAINT valid_contradiction_type CHECK (
    contradiction_type IN ('opposing_object', 'expired_but_cited',
                           'cyclic_causal', 'chain_conflict', 'temporal_impossible')
  ),
  CONSTRAINT valid_detected_by CHECK (
    detected_by IN ('sql_heuristic', 'reasoning_agent', 'user')
  ),
  CONSTRAINT valid_resolution_type CHECK (
    resolution_type IS NULL OR resolution_type IN (
      'expire_a', 'expire_b', 'expire_both',
      'invalidate_a', 'invalidate_b',
      'expire_edge_a', 'expire_edge_b', 'expire_both_edges',
      'reconcile', 'both_valid', 'dismissed'
    )
  ),
  CONSTRAINT valid_severity CHECK (severity IN ('critical', 'high', 'medium', 'low')),

  -- At least one node reference required
  CONSTRAINT at_least_one_node CHECK (
    fact_a_id IS NOT NULL OR fact_b_id IS NOT NULL OR
    edge_a_id IS NOT NULL OR edge_b_id IS NOT NULL OR
    entity_id IS NOT NULL
  )
);

CREATE INDEX idx_contradictions_unresolved ON public.contradictions (detected_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX idx_contradictions_type ON public.contradictions (contradiction_type);
CREATE INDEX idx_contradictions_entity ON public.contradictions (entity_id)
  WHERE entity_id IS NOT NULL;

-- Prevent duplicate detection of the same pair
CREATE UNIQUE INDEX idx_contradictions_unique_pair
  ON public.contradictions (contradiction_type, COALESCE(fact_a_id, '00000000-0000-0000-0000-000000000000'::uuid),
                           COALESCE(fact_b_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE resolved_at IS NULL AND contradiction_type IN ('opposing_object', 'expired_but_cited');
```

## Detection — SQL Heuristics

### `platform/src/services/contradictions.ts`

```typescript
export async function detectContradictions(): Promise<{
  detected: number;
  byType: Record<string, number>;
}> {
  const results = await Promise.all([
    detectOpposingObjects(),
    detectExpiredButCited(),
    detectCyclicCausal(),
    detectTemporalImpossible(),
  ]);
  return summarise(results);
}

async function detectOpposingObjects(): Promise<number> {
  return await db.execute(sql`
    INSERT INTO contradictions (
      contradiction_type, fact_a_id, fact_b_id, entity_id,
      detected_by, detection_reasoning, detection_context, severity
    )
    SELECT
      'opposing_object',
      LEAST(f1.id, f2.id),
      GREATEST(f1.id, f2.id),
      f1.subject_entity_id,
      'sql_heuristic',
      format('Same subject %s and predicate %s with different objects: %s vs %s',
        f1.subject_entity_id, f1.predicate,
        COALESCE(f1.object_entity_id::text, f1.object_value),
        COALESCE(f2.object_entity_id::text, f2.object_value)
      ),
      jsonb_build_object(
        'fact_a_confidence', f1.confidence,
        'fact_b_confidence', f2.confidence
      ),
      CASE
        WHEN GREATEST(f1.confidence, f2.confidence) >= 0.8 THEN 'high'
        ELSE 'medium'
      END
    FROM facts f1
    JOIN facts f2 ON
      f1.subject_entity_id = f2.subject_entity_id
      AND f1.predicate = f2.predicate
      AND f1.id < f2.id
      AND (
        COALESCE(f1.object_entity_id::text, f1.object_value) <>
        COALESCE(f2.object_entity_id::text, f2.object_value)
      )
    WHERE f1.expired_at IS NULL AND f1.invalid_at IS NULL
      AND f2.expired_at IS NULL AND f2.invalid_at IS NULL
      -- Exclude exclusive predicates that naturally have only one truth
      AND NOT EXISTS (
        SELECT 1 FROM fact_predicates p
        WHERE p.name = f1.predicate AND p.is_exclusive = true
      )
    ON CONFLICT (contradiction_type, COALESCE(fact_a_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 COALESCE(fact_b_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE resolved_at IS NULL AND contradiction_type IN ('opposing_object', 'expired_but_cited')
    DO NOTHING
  `);
}

async function detectExpiredButCited(): Promise<number> {
  return await db.execute(sql`
    INSERT INTO contradictions (
      contradiction_type, edge_a_id, fact_a_id,
      detected_by, detection_reasoning, severity
    )
    SELECT DISTINCT
      'expired_but_cited',
      e.id,
      f.id,
      'sql_heuristic',
      format('Edge %s cites expired fact %s (expired %s)', e.id, f.id, f.expired_at),
      CASE
        WHEN e.corroboration_count = 1 THEN 'high'   -- sole source
        WHEN e.strength >= 0.7 THEN 'medium'
        ELSE 'low'
      END
    FROM causal_edges e
    JOIN edge_source_refs r ON r.edge_id = e.id AND r.ref_type = 'fact'
    JOIN facts f ON f.id = r.ref_id
    WHERE e.expired_at IS NULL
      AND f.expired_at IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
}

async function detectCyclicCausal(): Promise<number> { /* similar pattern */ }
async function detectTemporalImpossible(): Promise<number> { /* similar pattern */ }
```

## Detection — Reasoning Agent

The four SQL heuristics above catch lexical / structural conflicts: same
subject + predicate with different objects, edges citing expired facts,
unwindowed causal cycles, and edges with cause occurring after effect. They
cannot surface contradictions that require semantic understanding —
specifically:

1. **chain_conflict** — two reasoning chains the agent investigated reach
   opposing conclusions about the same predicate-subject. Detecting this
   requires the agent to remember conclusions across chains it produced
   during the same patrol pass. The SQL heuristic has no view of reasoning
   chains; only the agent does.
2. **Aliased-predicate opposing facts** — two facts whose objects disagree
   but whose predicates differ lexically while meaning the same thing (e.g.
   `lives_at` vs `resides_at`). `detectOpposingObjects` joins on exact
   predicate equality, so it cannot catch these.

The `create_contradiction` MCP tool is the write path for both. It mirrors
the insertion shape of the SQL heuristics:

| Concern | Behaviour |
|---|---|
| `at_least_one_node` | Enforced at the service boundary (defence-in-depth against the DB CHECK) — at least one of `fact_a_id`, `fact_b_id`, `edge_a_id`, `edge_b_id`, `entity_id` must be supplied. |
| `detection_reasoning` | Required, must be at least 20 characters. Must cite the specific facts/edges/chains and explain why the SQL heuristics could not catch the case. |
| `detected_by` | Set automatically from the tool-call context — `reasoning_agent` during patrol, `user` via support tooling. Other actors are rejected at the dispatcher. |
| Dedup | The partial unique index `idx_contradictions_unique_active` covers all five types. `ON CONFLICT DO NOTHING` + a follow-up `SELECT` returns the existing row's id when the same (type + node-refs) tuple is already unresolved — so an agent re-flagging a SQL-detected conflict is a no-op. |

### `create_contradiction` MCP tool

```typescript
{
  name: 'create_contradiction',
  inputSchema: {
    type: 'object',
    properties: {
      contradiction_type: { enum: ['opposing_object', 'expired_but_cited',
                                    'cyclic_causal', 'temporal_impossible',
                                    'chain_conflict'] },
      fact_a_id: { type: 'string' },
      fact_b_id: { type: 'string' },
      edge_a_id: { type: 'string' },
      edge_b_id: { type: 'string' },
      entity_id: { type: 'string' },
      detection_reasoning: { type: 'string', minLength: 20 },
      detection_context: { type: 'object' },
      severity: { enum: ['critical', 'high', 'medium', 'low'] },
    },
    required: ['contradiction_type', 'detection_reasoning'],
  },
}
```

### chain_conflict workflow

```d2
direction: down

investigate: "Phase 2 — investigate\nneighbourhoods" { shape: step }
chains: "Build reasoning\nchains" { shape: rectangle }
notice: "Notice two chains\nreach opposing\nconclusions" { shape: diamond; style.fill: "#fff3cd" }
create: "create_contradiction(\n  type=chain_conflict,\n  entity_id=...,\n  detection_reasoning=cite both chains\n)" { shape: rectangle; style.fill: "#fff3cd" }
report: "Phase 4 — REPORT\nincludes the\nnewly-flagged conflict" { shape: step }

investigate -> chains -> notice
notice -> create -> report
notice -> investigate: "no — continue"
```

### Aliased-predicate workflow

Aliased predicates are equally an agent-detection problem because lexical
equality is the only thing the SQL heuristic can do. The agent surfaces
these by calling `create_contradiction` with `contradiction_type='opposing_object'`
plus the two fact ids and the shared entity, naming both predicate strings
in `detection_reasoning`. The same partial unique index protects against
duplicate rows, but the agent should still check
`get_contradictions({ entity_id, contradiction_type: 'opposing_object' })`
first to avoid wasting an MCP call on something already flagged.

## Resolution Flow

### Reasoning Agent Patrol Addition

```d2
direction: down

survey: "PHASE 1: SURVEY\nget_reasoning_targets()" {
  shape: step
}

contradictions_check: "PHASE 1.5: CONTRADICTIONS\nget_contradictions(unresolved=true)" {
  shape: step
  style.fill: "#fff3cd"
}

investigate: "PHASE 2: INVESTIGATE\nper neighbourhood" {
  shape: step
}

reason: "PHASE 3: REASON & ACT\n+ resolve contradictions" {
  shape: step
  style.fill: "#fff3cd"
}

report: "PHASE 4: REPORT" {
  shape: step
}

survey -> contradictions_check -> investigate -> reason -> report
```

Reasoning agent system prompt gets a new phase block:

> **PHASE 1.5 — CONTRADICTIONS (3-5 calls)**
>
> After selecting target neighbourhoods, call `get_contradictions(limit=5, unresolved=true)`.
> For each returned contradiction:
> 1. Read the detection_reasoning and detection_context
> 2. Pull the full history of the involved facts/edges via `get_fact_history` / `get_edge_history`
> 3. Decide resolution: `expire_a`, `expire_b`, `both_valid`, `reconcile`, or `dismissed`
> 4. Apply the decision via the appropriate write tool (`expire_fact`, `invalidate_fact`, etc.)
> 5. Call `resolve_contradiction(id, resolution_type, reasoning)` — this closes the record and links to your reasoning report
>
> Rules:
> - Prefer `both_valid` only when temporal windowing could legitimately allow both (e.g. "works_at Acme (2020-2022)" and "works_at Globex (2022-present)")
> - Use `dismissed` only for false positives with clear explanation
> - When `resolution_type='dismissed'`, `dismissed_reason` is **required**: a short kebab-case categorical tag (e.g. `aliased-predicate`, `predicate-semantics-permits-multi`) distinct from the narrative `resolution_reasoning`. The service rejects dismissed resolutions that omit it. The tag enables audit queries like "how many false positives by category?".
> - Every resolution MUST cite evidence — the history rows of the facts/edges involved

### MCP Tools

```typescript
{
  name: 'get_contradictions',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', default: 10 },
      unresolved_only: { type: 'boolean', default: true },
      contradiction_type: { type: 'string' },
      severity: { enum: ['critical', 'high', 'medium', 'low'] },
    },
  },
}

{
  name: 'resolve_contradiction',
  inputSchema: {
    type: 'object',
    properties: {
      contradiction_id: { type: 'string', format: 'uuid' },
      resolution_type: {
        enum: ['expire_a', 'expire_b', 'expire_both', 'invalidate_a', 'invalidate_b',
               'expire_edge_a', 'expire_edge_b', 'expire_both_edges',
               'reconcile', 'both_valid', 'dismissed'],
      },
      resolution_reasoning: { type: 'string', minLength: 20 },
      // Conditional: required when resolution_type === 'dismissed'. Not in
      // the static `required` array because JSON Schema conditional-required
      // is awkward; the service-layer throw is the authority.
      dismissed_reason: { type: 'string' },
    },
    required: ['contradiction_id', 'resolution_type', 'resolution_reasoning'],
  },
}
```

### Resolution Handler

The handler wraps the claim + side effects + closing UPDATE in a single
transaction so two concurrent callers serialise on the row lock — without
the `SELECT ... FOR UPDATE`, both callers can pass the `resolvedAt === null`
check and double-mutate (bead nmemo-2yv.38). The graph-mutation primitives
(`expireFact`, `invalidateFact`, `expireCausalEdge`, `reviseCausalEdge`)
accept an optional `tx` parameter so the side effects run inside the same
outer transaction.

```typescript
export async function resolveContradiction(params: {
  contradictionId: string;
  resolutionType: ResolutionType;
  resolutionReasoning: string;
  actor: Actor;
  reasoningReportId?: string;
  dismissedReason?: string;  // required when resolutionType === 'dismissed'
}): Promise<void> {
  // Reasoning length gate (existing).
  if (!params.resolutionReasoning || params.resolutionReasoning.trim().length < 20) {
    throw new Error('reasoning must be at least 20 characters');
  }
  // Dismissed-reason gate (bead nmemo-2yv.40): dismissed must carry a
  // categorical tag, distinct from the narrative reasoning. Without it,
  // audit queries that group false positives by category can't run.
  if (params.resolutionType === 'dismissed' && (!params.dismissedReason || !params.dismissedReason.trim())) {
    throw new Error("dismissed_reason is required when resolution_type is 'dismissed'");
  }
  await db.transaction(async (tx) => {
    // Row-lock — concurrent callers block here until this tx commits.
    const [contradiction] = await tx.execute(sql`
      SELECT id, fact_a_id, fact_b_id, edge_a_id, edge_b_id, resolved_at
      FROM public.contradictions WHERE id = ${params.contradictionId}::uuid FOR UPDATE
    `);
    if (!contradiction) throw new Error('not found');
    if (contradiction.resolvedAt) throw new Error('Already resolved');

    // Apply side effects on the locked tx.
    switch (params.resolutionType) {
      case 'expire_a':
        if (!contradiction.factAId) throw new Error('expire_a requires fact_a_id');
        await expireFact({ factId: contradiction.factAId, reasoning: params.resolutionReasoning, actor: params.actor, tx });
        break;
      case 'expire_b': /* similar */; break;
      case 'invalidate_a': /* similar, calls invalidateFact({..., tx}) */; break;
      case 'expire_edge_a':
        if (!contradiction.edgeAId) throw new Error('expire_edge_a requires edge_a_id');
        await expireCausalEdge({ edgeId: contradiction.edgeAId, reasoning: params.resolutionReasoning, actor: params.actor, tx });
        break;
      case 'expire_edge_b': /* similar on edgeBId */; break;
      case 'expire_both_edges': /* both edges */; break;
      case 'both_valid':
      case 'dismissed':
        // No mutation — just mark resolved
        break;
      // ...
    }

    // Mark contradiction resolved — inside the same tx so the claim,
    // mutations, and close commit atomically.
    await tx.update(contradictions)
      .set({
        resolvedAt: new Date(),
        resolvedBy: params.actor,
        resolutionType: params.resolutionType,
        resolutionReasoning: params.resolutionReasoning,
        resolutionReportId: params.reasoningReportId ?? null,
      })
      .where(eq(contradictions.id, params.contradictionId));
  });
}
```

## Pipeline Integration

```typescript
// platform/src/pipeline.ts

// Piggyback on the decay counter — both are lightweight periodic SQL
if (decayRunCount >= DECAY_RUN_INTERVAL) {
  decayRunCount = 0;
  await applyConfidenceDecay();
  await detectContradictions();  // <-- add this
}
```

## HTTP API

```typescript
// platform/src/index.ts

app.get('/api/contradictions', async (c) => {
  const unresolved = c.req.query('unresolved') !== 'false';
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const rows = await getContradictions({ unresolvedOnly: unresolved, limit });
  return c.json(rows);
});

app.post('/api/contradictions/detect', async (c) => {
  const result = await detectContradictions();
  return c.json(result);
});

app.post('/api/contradictions/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ resolution_type: string; resolution_reasoning: string }>();
  await resolveContradiction({
    contradictionId: id,
    resolutionType: body.resolution_type as any,
    resolutionReasoning: body.resolution_reasoning,
    actor: 'user',
  });
  return c.json({ ok: true });
});
```

## Viz Integration

- **Header badge**: count of unresolved contradictions. Clickable.
- **Contradictions panel**: list view with type, detection reasoning, involved nodes (clickable → detail), "Resolve" button (user path).
- **In-graph indicators**: facts and edges involved in open contradictions get a red dot overlay.

## Test Design

### Test File: `platform/src/test/harness/contradictions.test.ts`

```typescript
describe('Phase 5 — Contradiction Detection', () => {
  beforeEach(async () => {
    await deleteFromTables(
      'contradictions', 'causal_edge_history', 'fact_history',
      'edge_source_refs', 'causal_edges', 'causal_events',
      'memory_entities', 'entity_aliases', 'facts',
      'entity_merges', 'entities',
    );
  });

  describe('opposing_object detection', () => {
    it('flags same subject+predicate with different objects', async () => {
      const subject = await createTestEntity();
      const objectA = await createTestEntity();
      const objectB = await createTestEntity();
      await createFact({ subjectEntityId: subject.id, predicate: 'knows', objectEntityId: objectA.id, ..., actor: 'graph_agent' });
      await createFact({ subjectEntityId: subject.id, predicate: 'knows', objectEntityId: objectB.id, ..., actor: 'graph_agent' });

      await detectContradictions();
      const rows = await getContradictions({ unresolvedOnly: true });
      const opposing = rows.find(r => r.contradictionType === 'opposing_object');
      expect(opposing).toBeDefined();
      expect(opposing?.entityId).toBe(subject.id);
    });

    it('does not flag exclusive predicates (they have supersession)', async () => {
      // works_at is exclusive — we already have supersession logic
      const subject = await createTestEntity();
      const acme = await createTestEntity();
      const globex = await createTestEntity();
      await createFact({ subjectEntityId: subject.id, predicate: 'works_at', objectEntityId: acme.id, ..., actor: 'graph_agent' });
      await createFact({ subjectEntityId: subject.id, predicate: 'works_at', objectEntityId: globex.id, ..., actor: 'graph_agent' });
      // Second should have superseded first — no contradiction
      await detectContradictions();
      const rows = await getContradictions({ unresolvedOnly: true });
      expect(rows.filter(r => r.contradictionType === 'opposing_object')).toHaveLength(0);
    });

    it('does not duplicate detection on second run', async () => {
      // Setup conflict
      await setupOpposingObjects();
      await detectContradictions();
      const countAfterFirst = (await getContradictions({ unresolvedOnly: true })).length;
      await detectContradictions();
      const countAfterSecond = (await getContradictions({ unresolvedOnly: true })).length;
      expect(countAfterSecond).toBe(countAfterFirst);
    });
  });

  describe('expired_but_cited detection', () => {
    it('flags active edge citing an expired fact', async () => {
      const factId = await setupFact();
      const edgeId = await setupEdgeCitingFact(factId);
      await expireFact({ factId, reasoning: 'test', actor: 'user' });
      // Note: cascade would handle this in Phase 2, but detection catches any that slip through
      // or edges added after the cascade's time window

      // Simulate a case where cascade missed it
      await testDb.update(causalEdges).set({ expiredAt: null }).where(eq(causalEdges.id, edgeId));

      await detectContradictions();
      const rows = await getContradictions();
      const found = rows.find(r => r.contradictionType === 'expired_but_cited' && r.edgeAId === edgeId);
      expect(found).toBeDefined();
    });

    it('severity is high when edge corroboration = 1', async () => {
      // ... setup with corroboration 1 ...
      await detectContradictions();
      const row = await getContradictionByEdge(edgeId);
      expect(row.severity).toBe('high');
    });
  });

  describe('cyclic_causal detection', () => {
    it('flags A→B and B→A with no temporal span', async () => {
      const { eventA, eventB } = await setupTwoEvents();
      await setupEdge({ causeEventId: eventA, effectEventId: eventB, temporalSpan: null });
      await setupEdge({ causeEventId: eventB, effectEventId: eventA, temporalSpan: null });
      await detectContradictions();
      const rows = await getContradictions();
      expect(rows.some(r => r.contradictionType === 'cyclic_causal')).toBe(true);
    });

    it('does not flag when edges have temporal separation', async () => {
      const { eventA, eventB } = await setupTwoEvents();
      await setupEdge({ causeEventId: eventA, effectEventId: eventB, temporalSpan: 'P1D' });
      await setupEdge({ causeEventId: eventB, effectEventId: eventA, temporalSpan: 'P1D' });
      await detectContradictions();
      const rows = await getContradictions();
      expect(rows.some(r => r.contradictionType === 'cyclic_causal')).toBe(false);
    });
  });

  describe('temporal_impossible detection', () => {
    it('flags edge where cause occurred after effect', async () => {
      const causeEvent = await setupEvent({ occurredAt: new Date('2026-04-20') });
      const effectEvent = await setupEvent({ occurredAt: new Date('2026-04-10') });
      await setupEdge({ causeEventId: causeEvent, effectEventId: effectEvent });
      await detectContradictions();
      const rows = await getContradictions();
      expect(rows.some(r => r.contradictionType === 'temporal_impossible')).toBe(true);
    });
  });

  describe('resolution', () => {
    it('expire_a resolution expires fact A and closes record', async () => {
      const { contradictionId, factAId } = await setupOpposingContradiction();
      await resolveContradiction({
        contradictionId,
        resolutionType: 'expire_a',
        resolutionReasoning: 'Fact A had lower confidence and older source',
        actor: 'reasoning_agent',
      });

      const factA = await getFact(factAId);
      expect(factA.expiredAt).not.toBeNull();

      const contradiction = await getContradiction(contradictionId);
      expect(contradiction.resolvedAt).not.toBeNull();
      expect(contradiction.resolutionType).toBe('expire_a');
    });

    it('both_valid resolution closes record without mutations', async () => {
      const { contradictionId, factAId, factBId } = await setupOpposingContradiction();
      await resolveContradiction({
        contradictionId,
        resolutionType: 'both_valid',
        resolutionReasoning: 'These represent different time periods',
        actor: 'reasoning_agent',
      });

      const factA = await getFact(factAId);
      const factB = await getFact(factBId);
      expect(factA.expiredAt).toBeNull();
      expect(factB.expiredAt).toBeNull();

      const contradiction = await getContradiction(contradictionId);
      expect(contradiction.resolvedAt).not.toBeNull();
    });

    it('resolution requires non-trivial reasoning (min length 20)', async () => {
      const { contradictionId } = await setupOpposingContradiction();
      await expect(
        resolveContradiction({
          contradictionId,
          resolutionType: 'expire_a',
          resolutionReasoning: 'short',
          actor: 'reasoning_agent',
        })
      ).rejects.toThrow(/reasoning/);
    });

    it('links resolution to reasoning_report when provided', async () => {
      const { contradictionId } = await setupOpposingContradiction();
      const reportId = await createTestReasoningReport();
      await resolveContradiction({
        contradictionId,
        resolutionType: 'expire_a',
        resolutionReasoning: 'with proper justification text here',
        actor: 'reasoning_agent',
        reasoningReportId: reportId,
      });
      const contradiction = await getContradiction(contradictionId);
      expect(contradiction.resolutionReportId).toBe(reportId);
    });

    it('cannot resolve already-resolved contradiction', async () => {
      const { contradictionId } = await setupOpposingContradiction();
      await resolveContradiction({ contradictionId, ... });
      await expect(
        resolveContradiction({ contradictionId, ... })
      ).rejects.toThrow(/already resolved/i);
    });
  });

  describe('MCP tools', () => {
    it('get_contradictions returns unresolved by default', async () => {
      const result = await handleToolCall('get_contradictions', {}, { agent: 'reasoning_agent' });
      expect(Array.isArray(result)).toBe(true);
    });

    it('resolve_contradiction via MCP applies resolution', async () => {
      const { contradictionId } = await setupOpposingContradiction();
      await handleToolCall('resolve_contradiction', {
        contradiction_id: contradictionId,
        resolution_type: 'both_valid',
        resolution_reasoning: 'These represent separate temporal periods.',
      }, { agent: 'reasoning_agent' });
      const c = await getContradiction(contradictionId);
      expect(c.resolvedAt).not.toBeNull();
    });
  });

  describe('HTTP endpoints', () => {
    it('GET /api/contradictions returns unresolved list', async () => {
      await setupOpposingContradiction();
      const response = await fetch('http://localhost:3001/api/contradictions');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.length).toBeGreaterThan(0);
    });

    it('POST /api/contradictions/detect triggers detection', async () => {
      await setupOpposingObjects();
      const response = await fetch('http://localhost:3001/api/contradictions/detect', { method: 'POST' });
      const body = await response.json();
      expect(body.detected).toBeGreaterThan(0);
    });
  });
});
```

### Coverage Targets

- [ ] opposing_object detection with exclusions for exclusive predicates
- [ ] expired_but_cited detection correct
- [ ] cyclic_causal respects temporal_span
- [ ] temporal_impossible comparison correct
- [ ] No duplicate detection on second run
- [ ] Resolution types apply correct side effects
- [ ] Reasoning length validation
- [ ] Already-resolved rejection
- [ ] Link to reasoning report
- [ ] MCP tools callable
- [ ] HTTP endpoints work

## Test Data Requirements

See [doc 18 — Test Data Hardening Protocol](18-test-data-hardening-protocol.md).

### Fixture Inventory

```
platform/src/test/data/phase5-contradictions/
├── fixtures/
│   ├── opposing-object-simple.sql          # L1 — two facts, same subject+predicate, different object
│   ├── opposing-object-exclusive.sql       # L1 — exclusive predicate should NOT flag (supersession)
│   ├── expired-but-cited.sql               # L1 — expired fact with active edge citing it
│   ├── cyclic-no-span.sql                  # L1 — A→B + B→A with null temporal_span
│   ├── cyclic-with-span.sql                # L1 — A→B + B→A with temporal_span=P1D (valid, not contradiction)
│   ├── temporal-impossible.sql             # L1 — cause.occurred_at > effect.occurred_at
│   ├── near-contradiction-temporal.sql     # L1 edge — opposing but with valid_at windowing
│   ├── double-detection.sql                # L1 edge — same contradiction detected twice (dedup test)
│   ├── resolution-all-types.sql            # L2 — pre-seeded contradictions for each resolution_type
│   ├── chain-conflict-agent.sql            # L2 — subtle conflict requiring agent to detect
│   └── adversarial-flood.sql               # adversarial — 100 opposing pairs
├── expected/
└── benchmark-reports/
```

### Benchmark Metrics

| Metric | Target |
|--------|--------|
| `detectContradictions` full-scan | <2s on 1000 facts |
| Heuristic precision (all types) | ≥ 95% | no false positives on clean data |
| Heuristic recall (each type) | ≥ 90% | versus hand-labelled set |
| Resolution → side-effect applied | 100% | |
| No re-detection of resolved contradictions | 100% | |
| Exclusive predicate suppression | 100% | works_at etc. never flagged |

### Adversarial

- **Noisy near-contradictions**: temporally-windowed facts that look opposing but are valid — should NOT flag.
- **Exclusive-predicate edge case**: multiple works_at facts where supersession didn't fire — correct behaviour debatable.
- **Chain-conflict without surface markers**: two causal chains reaching opposing conclusions via reasoning, no syntactic markers. Requires agent to detect.
- **Resolution race**: two agents try to resolve same contradiction concurrently. One should succeed, other error cleanly.

### Graduation

Level 1 → Level 2 when all 4 heuristic types hit precision/recall targets on curated sets.
Level 2 → Level 3 when reasoning-agent-driven resolution quality (via end-to-end query scoring) meets threshold.

## Acceptance Criteria

Phase 5 is complete when:

- [ ] Migration `011_contradictions.sql` applied
- [ ] All 4 SQL heuristics detect correctly without false positives on MISRA data
- [ ] Reasoning agent prompt includes Phase 1.5 contradiction check
- [ ] Resolution flow writes audit (via the underlying expire/invalidate calls)
- [ ] MCP tools `get_contradictions`, `resolve_contradiction` registered
- [ ] Viz badge reflects unresolved count
- [ ] Pipeline auto-detect runs on interval
- [ ] All tests pass

## File Inventory

### New
- `platform/src/db/migrations/011_contradictions.sql`
- `platform/src/services/contradictions.ts`
- `platform/src/test/harness/contradictions.test.ts`

### Modified
- `platform/src/db/schema.ts` — `contradictions` table
- `platform/src/services/causal-agent.ts` — `get_contradictions`, `resolve_contradiction` MCP tools
- `platform/src/pipeline.ts` — auto-detect trigger
- `platform/src/index.ts` — `/api/contradictions*` endpoints
- `platform/viz/js/app.js`, `index.html` — badge + panel
- `ml-services/app/reasoning_agent.py` — Phase 1.5 block in prompt

## Beads Issues

Parent: **nmemo-cae** (Phase 5)

- **nmemo-cae.1** — [migration] 011_contradictions.sql
- **nmemo-cae.2** — [schema] Drizzle schema for contradictions
- **nmemo-cae.3** — [service] detectOpposingObjects heuristic
- **nmemo-cae.4** — [service] detectExpiredButCited heuristic (depends on nmemo-d1r.4)
- **nmemo-cae.5** — [service] detectCyclicCausal heuristic
- **nmemo-cae.6** — [service] detectTemporalImpossible heuristic
- **nmemo-cae.7** — [service] resolveContradiction dispatcher
- **nmemo-cae.8** — [mcp] get_contradictions + resolve_contradiction tools
- **nmemo-cae.9** — [prompt] Reasoning agent Phase 1.5 block
- **nmemo-cae.10** — [api] HTTP endpoints for contradictions
- **nmemo-cae.11** — [viz] Badge + panel UI
- **nmemo-cae.12** — [pipeline] Auto-detect trigger
- **nmemo-cae.13** — [test] contradictions.test.ts passing

`bd show nmemo-cae` for full tree.
