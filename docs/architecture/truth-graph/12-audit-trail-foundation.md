# Phase 1 — Audit Trail Foundation

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Size:** M
**Depends on:** Phase 0 (smoke test)
**Blocks:** Phases 2, 3, 5 (all mutate state and must audit through this layer)

## Purpose

Every mutation to a fact or causal edge must write a history row with full reasoning context. This is the bedrock for every reasoning-layer capability that follows:

- **Corroboration** (Phase 2) is an UPDATE. Without audit, the "before" state is lost.
- **Blast radius** (Phase 4) needs to trace how an edge was formed and reinforced to score severity.
- **Contradictions** (Phase 5) need to show evolution — "this was true last week; new evidence changes that".
- **Pattern promotion** (Phase 6) needs to see edge mutation history to tell a stable pattern from a flapping one.

Nothing downstream works correctly without this layer.

## Data Model

### `fact_history`

Append-only log of every mutation to a fact.

```sql
CREATE TABLE public.fact_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id               UUID NOT NULL REFERENCES public.facts(id),
  event_type            VARCHAR(20) NOT NULL,
  previous_confidence   FLOAT,
  new_confidence        FLOAT,
  previous_valid_at     TIMESTAMPTZ,
  new_valid_at          TIMESTAMPTZ,
  previous_invalid_at   TIMESTAMPTZ,
  new_invalid_at        TIMESTAMPTZ,
  reasoning             TEXT NOT NULL,
  source_references     JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasoning_report_id   UUID REFERENCES public.reasoning_reports(id),
  causal_event_id       UUID REFERENCES public.causal_events(id),
  actor                 VARCHAR(32) NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_fact_event_type CHECK (
    event_type IN ('created', 'confidence_raised', 'confidence_lowered',
                   'revised', 'superseded', 'expired', 'invalidated', 'restored')
  ),
  CONSTRAINT valid_fact_actor CHECK (
    actor IN ('graph_agent', 'reasoning_agent', 'gardener_agent',
              'reconciliation_agent', 'user', 'system_trigger', 'cascade')
  )
);

CREATE INDEX idx_fact_history_fact ON public.fact_history (fact_id, occurred_at DESC);
CREATE INDEX idx_fact_history_report ON public.fact_history (reasoning_report_id)
  WHERE reasoning_report_id IS NOT NULL;
CREATE INDEX idx_fact_history_actor ON public.fact_history (actor);
CREATE INDEX idx_fact_history_occurred ON public.fact_history (occurred_at DESC);
```

### `causal_edge_history`

Append-only log of every mutation to a causal edge.

```sql
CREATE TABLE public.causal_edge_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_id               UUID NOT NULL REFERENCES public.causal_edges(id),
  event_type            VARCHAR(20) NOT NULL,
  previous_strength     FLOAT,
  new_strength          FLOAT,
  previous_reasoning    TEXT,
  new_reasoning         TEXT,
  added_source_refs     JSONB,
  reasoning             TEXT NOT NULL,
  reasoning_report_id   UUID REFERENCES public.reasoning_reports(id),
  actor                 VARCHAR(32) NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_edge_event_type CHECK (
    event_type IN ('created', 'corroborated', 'strengthened', 'weakened',
                   'revised', 'expired', 'decayed')
  ),
  CONSTRAINT valid_edge_actor CHECK (
    actor IN ('graph_agent', 'reasoning_agent', 'gardener_agent',
              'reconciliation_agent', 'user', 'system_trigger', 'cascade')
  )
);

CREATE INDEX idx_edge_history_edge ON public.causal_edge_history (edge_id, occurred_at DESC);
CREATE INDEX idx_edge_history_report ON public.causal_edge_history (reasoning_report_id)
  WHERE reasoning_report_id IS NOT NULL;
CREATE INDEX idx_edge_history_actor ON public.causal_edge_history (actor);
CREATE INDEX idx_edge_history_occurred ON public.causal_edge_history (occurred_at DESC);
```

### Event Type Semantics

```d2
direction: right

fact_lifecycle: "Fact Lifecycle" {
  created: "created" {
    style.fill: "#d4edda"
  }
  confidence_up: "confidence_raised" {
    style.fill: "#cfe8ff"
  }
  confidence_down: "confidence_lowered" {
    style.fill: "#cfe8ff"
  }
  revised: "revised" {
    style.fill: "#cfe8ff"
  }
  superseded: "superseded" {
    style.fill: "#fff3cd"
  }
  expired: "expired" {
    style.fill: "#f8d7da"
  }
  invalidated: "invalidated" {
    style.fill: "#f8d7da"
  }
  restored: "restored" {
    style.fill: "#d4edda"
  }

  created -> confidence_up: "new evidence"
  created -> confidence_down: "contradicting evidence"
  confidence_up -> revised: "reasoning update"
  confidence_down -> revised: "reasoning update"
  revised -> superseded: "replaced by\nnew fact"
  revised -> expired: "wrong /\nredundant"
  revised -> invalidated: "world changed"
  expired -> restored: "re-validated"
  invalidated -> restored: "re-validated"
}

edge_lifecycle: "Edge Lifecycle" {
  e_created: "created" {
    style.fill: "#d4edda"
  }
  corroborated: "corroborated" {
    style.fill: "#cfe8ff"
  }
  strengthened: "strengthened" {
    style.fill: "#cfe8ff"
  }
  weakened: "weakened" {
    style.fill: "#fff3cd"
  }
  e_revised: "revised" {
    style.fill: "#cfe8ff"
  }
  decayed: "decayed" {
    style.fill: "#fff3cd"
  }
  e_expired: "expired" {
    style.fill: "#f8d7da"
  }

  e_created -> corroborated: "same edge\nre-asserted"
  e_created -> strengthened: "new evidence"
  e_created -> weakened: "contradicting\nevidence"
  corroborated -> strengthened: "confidence\nthreshold"
  weakened -> e_revised: "reasoning update"
  strengthened -> e_revised: "reasoning update"
  e_revised -> decayed: "no corroboration\n30+ days"
  decayed -> e_expired: "strength ≤ 0.1"
  weakened -> e_expired: "cascade from\nexpired fact"
}
```

### Fact vs Edge Event Types — Why They Differ

Facts can be *superseded* (replaced by a newer, more specific fact about the same subject+predicate). Edges don't supersede — they corroborate instead, because an edge always refers to the same two causal events.

Edges *decay* explicitly as a lifecycle state. Facts don't decay; they either hold their confidence or get revised/expired by an agent with clear evidence.

## Service Layer

### New File: `platform/src/services/audit.ts`

```typescript
import { db } from '../db/index.js';
import { factHistory, causalEdgeHistory } from '../db/schema.js';

export type FactEventType =
  | 'created'
  | 'confidence_raised'
  | 'confidence_lowered'
  | 'revised'
  | 'superseded'
  | 'expired'
  | 'invalidated'
  | 'restored';

export type EdgeEventType =
  | 'created'
  | 'corroborated'
  | 'strengthened'
  | 'weakened'
  | 'revised'
  | 'expired'
  | 'decayed';

export type Actor =
  | 'graph_agent'
  | 'reasoning_agent'
  | 'gardener_agent'
  | 'reconciliation_agent'
  | 'user'
  | 'system_trigger'
  | 'cascade';

export interface SourceReference {
  type: 'memory' | 'fact' | 'entity';
  id: string;
  relevance: string;
}

export interface RecordFactChangeParams {
  factId: string;
  eventType: FactEventType;
  previousConfidence?: number;
  newConfidence?: number;
  previousValidAt?: Date;
  newValidAt?: Date;
  previousInvalidAt?: Date;
  newInvalidAt?: Date;
  reasoning: string;
  sourceReferences?: SourceReference[];
  reasoningReportId?: string;
  causalEventId?: string;
  actor: Actor;
}

export async function recordFactChange(params: RecordFactChangeParams): Promise<string> {
  if (!params.reasoning || params.reasoning.trim().length === 0) {
    throw new Error('reasoning must be a non-empty string');
  }
  const [row] = await db.insert(factHistory).values({
    factId: params.factId,
    eventType: params.eventType,
    previousConfidence: params.previousConfidence ?? null,
    newConfidence: params.newConfidence ?? null,
    previousValidAt: params.previousValidAt ?? null,
    newValidAt: params.newValidAt ?? null,
    previousInvalidAt: params.previousInvalidAt ?? null,
    newInvalidAt: params.newInvalidAt ?? null,
    reasoning: params.reasoning,
    sourceReferences: params.sourceReferences ?? [],
    reasoningReportId: params.reasoningReportId ?? null,
    causalEventId: params.causalEventId ?? null,
    actor: params.actor,
  }).returning({ id: factHistory.id });
  return row.id;
}

export interface RecordEdgeChangeParams {
  edgeId: string;
  eventType: EdgeEventType;
  previousStrength?: number;
  newStrength?: number;
  previousReasoning?: string;
  newReasoning?: string;
  addedSourceRefs?: SourceReference[];
  reasoning: string;
  reasoningReportId?: string;
  actor: Actor;
}

export async function recordEdgeChange(params: RecordEdgeChangeParams): Promise<string> {
  if (!params.reasoning || params.reasoning.trim().length === 0) {
    throw new Error('reasoning must be a non-empty string');
  }
  const [row] = await db.insert(causalEdgeHistory).values({
    edgeId: params.edgeId,
    eventType: params.eventType,
    previousStrength: params.previousStrength ?? null,
    newStrength: params.newStrength ?? null,
    previousReasoning: params.previousReasoning ?? null,
    newReasoning: params.newReasoning ?? null,
    addedSourceRefs: params.addedSourceRefs ?? null,
    reasoning: params.reasoning,
    reasoningReportId: params.reasoningReportId ?? null,
    actor: params.actor,
  }).returning({ id: causalEdgeHistory.id });
  return row.id;
}

export interface FactHistoryRow {
  id: string;
  factId: string;
  eventType: FactEventType;
  previousConfidence: number | null;
  newConfidence: number | null;
  previousValidAt: Date | null;
  newValidAt: Date | null;
  reasoning: string;
  sourceReferences: SourceReference[];
  reasoningReportId: string | null;
  causalEventId: string | null;
  actor: Actor;
  occurredAt: Date;
}

export async function getFactHistory(factId: string, limit = 100): Promise<FactHistoryRow[]>;
export async function getEdgeHistory(edgeId: string, limit = 100): Promise<EdgeHistoryRow[]>;
```

### Integration Points

```d2
direction: down

services: "Service Layer" {
  facts: "facts.ts" {
    createFact
    expireFact
    invalidateFact
    updateFactConfidence: "updateFactConfidence (new)"
    restoreFact: "restoreFact (new)"
  }
  causal: "causal.ts" {
    createCausalEdge
    expireCausalEdge: "expireCausalEdge (new)"
    reviseCausalEdge: "reviseCausalEdge (new)"
  }
  audit: "audit.ts (new)" {
    recordFactChange
    recordEdgeChange
    getFactHistory
    getEdgeHistory
  }
}

agents: "Agent Code Paths" {
  graph_agent: "graph_agent.py\n(MCP calls)"
  reasoning_agent: "reasoning_agent.py\n(MCP calls)"
  gardener: "gardener_agent.py\n(MCP calls)"
  reconcile: "reconciliation_agent.py\n(MCP calls)"
}

mcp: "MCP Tool Handlers\ncausal-agent.ts" {
  create_fact
  expire_fact
  invalidate_fact
  update_fact_confidence: "update_fact_confidence (new)"
  restore_fact: "restore_fact (new)"
  create_causal_edge
  expire_edge: "expire_causal_edge (new)"
  revise_edge: "revise_causal_edge (new)"
  get_fact_history: "get_fact_history (new)"
  get_edge_history: "get_edge_history (new)"
}

agents.graph_agent -> mcp
agents.reasoning_agent -> mcp
agents.gardener -> mcp
agents.reconcile -> mcp

mcp.create_fact -> services.facts.createFact
mcp.expire_fact -> services.facts.expireFact
mcp.invalidate_fact -> services.facts.invalidateFact
mcp.update_fact_confidence -> services.facts.updateFactConfidence
mcp.restore_fact -> services.facts.restoreFact
mcp.create_causal_edge -> services.causal.createCausalEdge
mcp.expire_edge -> services.causal.expireCausalEdge
mcp.revise_edge -> services.causal.reviseCausalEdge
mcp.get_fact_history -> services.audit.getFactHistory
mcp.get_edge_history -> services.audit.getEdgeHistory

services.facts.createFact -> services.audit.recordFactChange: "after INSERT"
services.facts.expireFact -> services.audit.recordFactChange: "after UPDATE"
services.facts.invalidateFact -> services.audit.recordFactChange: "after UPDATE"
services.facts.updateFactConfidence -> services.audit.recordFactChange: "after UPDATE"
services.facts.restoreFact -> services.audit.recordFactChange: "after UPDATE"
services.causal.createCausalEdge -> services.audit.recordEdgeChange: "after INSERT"
services.causal.expireCausalEdge -> services.audit.recordEdgeChange: "after UPDATE"
services.causal.reviseCausalEdge -> services.audit.recordEdgeChange: "after UPDATE"
```

### Actor Threading — The Invasive Change

Every mutation path must pass `actor` all the way from the MCP tool handler down to the audit helper. This changes function signatures.

**Before:**
```typescript
export async function createFact(params: CreateFactParams): Promise<string>;
export async function expireFact(factId: string, reason: string): Promise<void>;
```

**After:**
```typescript
export async function createFact(params: CreateFactParams & { actor: Actor; reasoningReportId?: string }): Promise<string>;
export async function expireFact(params: { factId: string; reasoning: string; actor: Actor; reasoningReportId?: string }): Promise<void>;
```

TypeScript makes missing `actor` a compile error. That's the point — it forces every caller to decide who is making this change.

### MCP Tool Handlers — Where Actor Is Set

MCP tool handlers are called by exactly one agent at a time. The handler knows which agent by inspecting the invocation context.

```typescript
// platform/src/services/causal-agent.ts
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  context: { agent: Actor; reasoningReportId?: string },
): Promise<unknown> {
  switch (name) {
    case 'create_fact':
      return createFact({
        ...parseCreateFactArgs(args),
        actor: context.agent,
        reasoningReportId: context.reasoningReportId,
      });
    // ...
  }
}
```

Each invocation function (`invokeGraphAgent`, `invokeReasoningAgent`, etc.) passes its own `actor` value:

- `invokeGraphAgent` → `context.agent = 'graph_agent'`
- `invokeReasoningAgent` → `context.agent = 'reasoning_agent'`
- `invokeGardenerAgent` → `context.agent = 'gardener_agent'`
- `invokeReconciliationAgent` → `context.agent = 'reconciliation_agent'`
- Platform REST endpoints that mutate state directly → `context.agent = 'user'`
- Periodic triggers (decay, pattern detection) → `context.agent = 'system_trigger'`
- Cascade paths → `context.agent = 'cascade'`

## Drizzle Schema Additions

```typescript
// platform/src/db/schema.ts

export const factHistory = pgTable('fact_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  factId: uuid('fact_id').notNull().references(() => facts.id),
  eventType: varchar('event_type', { length: 20 }).notNull(),
  previousConfidence: real('previous_confidence'),
  newConfidence: real('new_confidence'),
  previousValidAt: timestamp('previous_valid_at', { withTimezone: true }),
  newValidAt: timestamp('new_valid_at', { withTimezone: true }),
  previousInvalidAt: timestamp('previous_invalid_at', { withTimezone: true }),
  newInvalidAt: timestamp('new_invalid_at', { withTimezone: true }),
  reasoning: text('reasoning').notNull(),
  sourceReferences: jsonb('source_references').notNull().default(sql`'[]'::jsonb`),
  reasoningReportId: uuid('reasoning_report_id').references(() => reasoningReports.id),
  causalEventId: uuid('causal_event_id').references(() => causalEvents.id),
  actor: varchar('actor', { length: 32 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const causalEdgeHistory = pgTable('causal_edge_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  edgeId: uuid('edge_id').notNull().references(() => causalEdges.id),
  eventType: varchar('event_type', { length: 20 }).notNull(),
  previousStrength: real('previous_strength'),
  newStrength: real('new_strength'),
  previousReasoning: text('previous_reasoning'),
  newReasoning: text('new_reasoning'),
  addedSourceRefs: jsonb('added_source_refs'),
  reasoning: text('reasoning').notNull(),
  reasoningReportId: uuid('reasoning_report_id').references(() => reasoningReports.id),
  actor: varchar('actor', { length: 32 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export type FactHistory = typeof factHistory.$inferSelect;
export type NewFactHistory = typeof factHistory.$inferInsert;
export type CausalEdgeHistory = typeof causalEdgeHistory.$inferSelect;
export type NewCausalEdgeHistory = typeof causalEdgeHistory.$inferInsert;
```

## MCP Tools — New Surface

Two new read tools exposed to reasoning agent, gardener, and reconciliation agent:

```typescript
{
  name: 'get_fact_history',
  description: 'Get the full mutation history for a fact. Returns events in reverse chronological order. Use to understand how a fact evolved before making changes.',
  inputSchema: {
    type: 'object',
    properties: {
      fact_id: { type: 'string', format: 'uuid' },
      limit: { type: 'number', minimum: 1, maximum: 500, default: 100 },
    },
    required: ['fact_id'],
  },
}

{
  name: 'get_edge_history',
  description: 'Get the full mutation history for a causal edge. Returns events in reverse chronological order. Use to understand how an edge was formed, corroborated, and revised.',
  inputSchema: {
    type: 'object',
    properties: {
      edge_id: { type: 'string', format: 'uuid' },
      limit: { type: 'number', minimum: 1, maximum: 500, default: 100 },
    },
    required: ['edge_id'],
  },
}
```

Additionally, update existing write tools to accept a `reasoning` field where they don't already, and document that the caller should pass justification for the change.

### Reasoning Agent System Prompt — Additions

Add to `ml-services/app/reasoning_agent.py` under "REASONING PRINCIPLES":

> **9. READ HISTORY BEFORE YOU ACT.** Before modifying or expiring a fact or edge, call `get_fact_history` or `get_edge_history`. Understanding how something became what it is prevents unwinding recent, justified changes. Every mutation you make will also appear in history — your reasoning should stand up to being read by a future patrol.

## Migration

```
platform/src/db/migrations/009_audit_trail.sql
```

Migration content:
1. `CREATE TABLE public.fact_history` (schema above)
2. `CREATE TABLE public.causal_edge_history` (schema above)
3. All indexes
4. **Backfill** — insert synthetic `created` rows for all existing facts and causal_edges so the tables are internally consistent:

```sql
INSERT INTO public.fact_history (
  fact_id, event_type, new_confidence, new_valid_at, new_invalid_at,
  reasoning, actor, occurred_at
)
SELECT
  id, 'created', confidence, valid_at, invalid_at,
  'Backfill: created before audit trail existed',
  'system_trigger', created_at
FROM public.facts;

INSERT INTO public.causal_edge_history (
  edge_id, event_type, new_strength, new_reasoning,
  reasoning, actor, occurred_at
)
SELECT
  id, 'created', strength, reasoning,
  'Backfill: created before audit trail existed',
  'system_trigger', created_at
FROM public.causal_edges;
```

## Test Design

### Test File: `platform/src/test/harness/audit-trail.test.ts`

Uses existing test infrastructure from `src/test/setup.ts`: `testDb`, `createTestEntity`, `createTestFact`, `deleteFromTables`.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, createTestEntity, deleteFromTables } from '../setup';
import { createFact, expireFact, invalidateFact, updateFactConfidence } from '../../services/facts';
import { createCausalEdge, expireCausalEdge, reviseCausalEdge } from '../../services/causal';
import { recordFactChange, recordEdgeChange, getFactHistory, getEdgeHistory } from '../../services/audit';
import { causalEvents, facts, causalEdges, factHistory, causalEdgeHistory } from '../../db/schema';
import { eq } from 'drizzle-orm';

describe('Phase 1 — Audit Trail Foundation', () => {
  beforeEach(async () => {
    await deleteFromTables(
      'causal_edge_history', 'fact_history',
      'causal_edges', 'causal_events',
      'memory_entities', 'entity_aliases', 'facts',
      'entity_merges', 'entities',
    );
  });

  describe('fact_history — creation path', () => {
    it('writes history row when createFact inserts a new fact', async () => {
      const [subj, obj] = await Promise.all([createTestEntity(), createTestEntity()]);
      const factId = await createFact({
        subjectEntityId: subj.id,
        predicate: 'works_at',
        objectEntityId: obj.id,
        confidence: 0.8,
        sourceText: 'test',
        actor: 'graph_agent',
      });

      const hist = await getFactHistory(factId);
      expect(hist).toHaveLength(1);
      expect(hist[0].eventType).toBe('created');
      expect(hist[0].actor).toBe('graph_agent');
      expect(hist[0].newConfidence).toBe(0.8);
      expect(hist[0].previousConfidence).toBeNull();
      expect(hist[0].reasoning).toBeTruthy();
    });

    it('links history row to the emitted causal_event', async () => {
      const [subj, obj] = await Promise.all([createTestEntity(), createTestEntity()]);
      const factId = await createFact({
        subjectEntityId: subj.id,
        predicate: 'works_at',
        objectEntityId: obj.id,
        confidence: 0.8,
        sourceText: 'test',
        actor: 'graph_agent',
      });

      const events = await testDb.select().from(causalEvents).where(eq(causalEvents.factId, factId));
      expect(events).toHaveLength(1);

      const hist = await getFactHistory(factId);
      expect(hist[0].causalEventId).toBe(events[0].id);
    });
  });

  describe('fact_history — mutation paths', () => {
    it('writes previous and new confidence on updateFactConfidence', async () => {
      const factId = await setupFact({ confidence: 0.5 });
      await updateFactConfidence({
        factId,
        newConfidence: 0.85,
        reasoning: 'two corroborating memories found',
        actor: 'reasoning_agent',
      });
      const hist = await getFactHistory(factId);
      expect(hist).toHaveLength(2);
      const [change, create] = hist; // reverse chron order
      expect(change.eventType).toBe('confidence_raised');
      expect(change.previousConfidence).toBe(0.5);
      expect(change.newConfidence).toBe(0.85);
    });

    it('writes expired event with actor=reasoning_agent and reasoning', async () => {
      const factId = await setupFact();
      await expireFact({
        factId,
        reasoning: 'superseded by newer extraction',
        actor: 'reasoning_agent',
      });
      const hist = await getFactHistory(factId);
      expect(hist[0].eventType).toBe('expired');
      expect(hist[0].actor).toBe('reasoning_agent');
      expect(hist[0].reasoning).toContain('superseded');
    });

    it('writes invalidated event with new_invalid_at timestamp', async () => {
      const factId = await setupFact();
      const invalidAt = new Date('2026-04-20');
      await invalidateFact({
        factId,
        invalidAt,
        reasoning: 'role ended',
        actor: 'reasoning_agent',
      });
      const hist = await getFactHistory(factId);
      expect(hist[0].eventType).toBe('invalidated');
      expect(hist[0].newInvalidAt).toEqual(invalidAt);
    });
  });

  describe('causal_edge_history', () => {
    it('writes created event when createCausalEdge inserts', async () => {
      const { causeId, effectId } = await setupEvents();
      const edgeId = await createCausalEdge({
        causeEventId: causeId,
        effectEventId: effectId,
        strength: 0.7,
        reasoning: 'explicit causal language in source',
        sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'explicit' }],
        actor: 'graph_agent',
      });

      const hist = await getEdgeHistory(edgeId);
      expect(hist).toHaveLength(1);
      expect(hist[0].eventType).toBe('created');
      expect(hist[0].newStrength).toBe(0.7);
      expect(hist[0].previousStrength).toBeNull();
    });

    it('preserves previous reasoning when edge is revised', async () => {
      const edgeId = await setupEdge({ reasoning: 'initial reasoning' });
      await reviseCausalEdge({
        edgeId,
        newReasoning: 'revised based on contradictory evidence',
        newStrength: 0.5,
        reasoning: 'patrol found conflicting source memories',
        actor: 'reasoning_agent',
      });
      const hist = await getEdgeHistory(edgeId);
      expect(hist[0].eventType).toBe('revised');
      expect(hist[0].previousReasoning).toBe('initial reasoning');
      expect(hist[0].newReasoning).toContain('contradictory');
    });
  });

  describe('constraints and validation', () => {
    it('rejects invalid actor values at the DB level', async () => {
      await expect(
        testDb.insert(factHistory).values({
          factId: randomUUID(),
          eventType: 'created',
          reasoning: 'test',
          actor: 'malicious_script' as any,
        })
      ).rejects.toThrow(/valid_fact_actor/);
    });

    it('rejects invalid event_type values at the DB level', async () => {
      await expect(
        testDb.insert(factHistory).values({
          factId: randomUUID(),
          eventType: 'made_up_event' as any,
          reasoning: 'test',
          actor: 'user',
        })
      ).rejects.toThrow(/valid_fact_event_type/);
    });

    it('recordFactChange rejects empty reasoning', async () => {
      await expect(
        recordFactChange({
          factId: randomUUID(),
          eventType: 'created',
          reasoning: '',
          actor: 'user',
        })
      ).rejects.toThrow(/reasoning/);
    });
  });

  describe('query ordering', () => {
    it('getFactHistory returns rows in reverse chronological order', async () => {
      const factId = await setupFact({ confidence: 0.5 });
      await updateFactConfidence({ factId, newConfidence: 0.7, reasoning: 'a', actor: 'reasoning_agent' });
      await updateFactConfidence({ factId, newConfidence: 0.9, reasoning: 'b', actor: 'reasoning_agent' });
      const hist = await getFactHistory(factId);
      expect(hist).toHaveLength(3);
      expect(hist[0].occurredAt.getTime()).toBeGreaterThanOrEqual(hist[1].occurredAt.getTime());
      expect(hist[1].occurredAt.getTime()).toBeGreaterThanOrEqual(hist[2].occurredAt.getTime());
    });

    it('respects limit param', async () => {
      const factId = await setupFact();
      for (let i = 0; i < 10; i++) {
        await updateFactConfidence({ factId, newConfidence: 0.5 + i * 0.01, reasoning: `update ${i}`, actor: 'reasoning_agent' });
      }
      const hist = await getFactHistory(factId, 5);
      expect(hist).toHaveLength(5);
    });
  });

  describe('MCP tool: get_fact_history', () => {
    it('returns structured history via the MCP handler', async () => {
      const factId = await setupFact();
      const result = await handleToolCall('get_fact_history', { fact_id: factId, limit: 10 }, { agent: 'reasoning_agent' });
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty('eventType');
      expect(result[0]).toHaveProperty('actor');
    });
  });

  describe('backfill', () => {
    it('existing facts have synthetic created rows after migration', async () => {
      // This test validates the migration backfill ran correctly on the seeded DB.
      // In test environments, the backfill is part of migration setup.
      const allFacts = await testDb.select().from(facts);
      for (const f of allFacts.slice(0, 5)) {
        const hist = await getFactHistory(f.id);
        expect(hist.length).toBeGreaterThanOrEqual(1);
        const created = hist.find(h => h.eventType === 'created');
        expect(created).toBeDefined();
      }
    });
  });
});
```

### Coverage Targets

- [ ] `createFact` → fact_history row with `event_type='created'`, actor passed through
- [ ] `expireFact` → fact_history row with `event_type='expired'`
- [ ] `invalidateFact` → fact_history row with `event_type='invalidated'` + `new_invalid_at`
- [ ] `updateFactConfidence` → `confidence_raised` or `confidence_lowered` based on direction
- [ ] `restoreFact` → `restored` (if implemented; otherwise defer to Phase 5)
- [ ] `createCausalEdge` → edge_history row with `event_type='created'`
- [ ] `expireCausalEdge` → edge_history row with `event_type='expired'`
- [ ] `reviseCausalEdge` → edge_history row with `event_type='revised'`, preserves previous reasoning
- [ ] DB constraints reject invalid `event_type` / `actor`
- [ ] Empty `reasoning` rejected at service layer
- [ ] `get_fact_history` / `get_edge_history` MCP tools return structured data
- [ ] History queries return reverse chronological order
- [ ] Limit param respected
- [ ] Backfill produced `created` rows for all existing facts/edges
- [ ] FK constraints: `reasoning_report_id` and `causal_event_id` reference real rows when non-null

## Test Data Requirements

Per the [Test Data Hardening Protocol](18-test-data-hardening-protocol.md), Phase 1 must ship data sets at Level 1 and Level 2, with benchmarks, before it is considered complete.

### Fixture Inventory

```
platform/src/test/data/phase1-audit/
├── fixtures/
│   ├── simple-mutations.sql         # L1 — one fact, CRUD lifecycle
│   ├── multi-actor.sql              # L1 — same fact touched by 3 actors
│   ├── concurrent-races.sql         # L1 edge — 100 concurrent creates on same subject
│   ├── actor-escalation.sql         # L2 — graph_agent creates, reasoning_agent revises, user expires
│   ├── cascade-writes.sql           # L2 — fact expiry cascades to edge audit
│   └── invalid-actors.sql           # adversarial — reject unknown actor values
├── expected/
│   ├── simple-mutations.expected.json
│   ├── multi-actor.expected.json
│   ├── concurrent-races.expected.json
│   └── actor-escalation.expected.json
└── benchmark-reports/
    └── YYYY-MM-DD-<scenario>.md
```

### Benchmark Metrics

| Metric | Target | Notes |
|--------|--------|-------|
| `recordFactChange` latency (p50) | <5ms | single row |
| `recordFactChange` latency (p99) | <15ms | under load |
| `recordEdgeChange` latency (p50) | <5ms | same |
| `getFactHistory` (100 rows) latency | <50ms | index scan |
| `getEdgeHistory` (100 rows) latency | <50ms | same |
| Mutation → audit-row-written atomicity | 100% | same transaction |
| Actor attribution correctness | 100% | verified across all scenarios |
| No lost audit rows under concurrent load | 100% | `concurrent-races.sql` asserts this |

### Adversarial Scenarios

- **Mutation flood**: 1000 rapid updates to a single fact. Assert no audit rows lost, correct ordering preserved.
- **Actor spoofing**: attempt to insert history row with unknown actor value. Assert DB constraint rejects.
- **Timing manipulation**: insert history with `occurred_at` in the future or far past. Assert no index corruption, query ordering respects chronology.
- **Orphan cleanup**: delete fact, verify fact_history rows remain (historical record) and FK doesn't cascade-delete audit.

### Graduation Criteria (Level 1 → Level 2)

Level 1 is stable and ready to graduate when:
- All assertions in L1 fixtures pass on 3 consecutive runs with different seeds
- All benchmark metrics meet targets
- At least one adversarial fixture added and passing
- Last 2 weeks had no regression commits affecting audit code

Level 2 adds:
- Cross-component scenarios (e.g., mutation sequences that exercise the MCP tool path)
- Integration with `reasoning_reports` FK — assert audit rows link to reports when agent-driven

### Test-Harden Skill Integration

This phase is a candidate for the first skill-driven iteration (`bd show nmemo-klv.8`). The skill should:
1. Load `simple-mutations.sql`, run tests, report baseline
2. Generate `mutation-flood-v1.sql` with higher concurrency, run tests
3. If new scenarios fail → log `bd create` issue under `nmemo-w4j`
4. If all pass → commit the harder scenario, update benchmark report, graduate L1

## Acceptance Criteria

Phase 1 is complete when:

- [ ] Migration `009_audit_trail.sql` applied to dev DB without errors
- [ ] All existing facts have synthetic `created` rows in `fact_history`
- [ ] All existing causal_edges have synthetic `created` rows in `causal_edge_history`
- [ ] Every mutation path through `facts.ts` and `causal.ts` writes an audit row
- [ ] `actor` is a required parameter on all mutation functions (TypeScript enforces)
- [ ] `get_fact_history` and `get_edge_history` MCP tools registered and callable
- [ ] Reasoning agent system prompt updated with "read history before you act"
- [ ] All tests in `audit-trail.test.ts` pass
- [ ] No regressions — existing test suites still pass

## File Inventory

### New
- `platform/src/db/migrations/009_audit_trail.sql`
- `platform/src/services/audit.ts`
- `platform/src/test/harness/audit-trail.test.ts`

### Modified
- `platform/src/db/schema.ts` — add `factHistory`, `causalEdgeHistory` tables + types
- `platform/src/services/facts.ts` — threaded `actor`, call `recordFactChange` from every mutation
- `platform/src/services/causal.ts` — threaded `actor`, call `recordEdgeChange` from every mutation
- `platform/src/services/causal-agent.ts` — pass `actor` context, add `get_fact_history` + `get_edge_history` tools + handlers
- `platform/src/index.ts` — pass `actor: 'user'` in direct API mutation paths
- `platform/src/pipeline.ts` — graph agent passes `actor: 'graph_agent'`
- `ml-services/app/reasoning_agent.py` — add "read history" principle to system prompt
- `platform/src/test/setup.ts` — update `deleteFromTables` ordering to include new tables

## Beads Issues

Epic: **nmemo-8vq** — Reasoning Layer Hardening (Phases 0-6)
Parent: **nmemo-w4j** (Phase 1)

- **nmemo-w4j.1** — [migration] Create `009_audit_trail.sql` with fact_history + causal_edge_history + backfill
- **nmemo-w4j.2** — [schema] Add Drizzle schema + types for history tables
- **nmemo-w4j.3** — [service] Create `audit.ts` with recordFactChange, recordEdgeChange, getFactHistory, getEdgeHistory
- **nmemo-w4j.4** — [refactor] Thread `actor` param through facts.ts mutation paths
- **nmemo-w4j.5** — [refactor] Thread `actor` param through causal.ts mutation paths
- **nmemo-w4j.6** — [mcp] Add `get_fact_history` and `get_edge_history` MCP tools
- **nmemo-w4j.7** — [mcp] Pass `actor` context through all MCP tool handlers
- **nmemo-w4j.8** — [prompt] Update reasoning agent system prompt with history-read principle
- **nmemo-w4j.9** — [test] Audit trail test harness passing (audit-trail.test.ts)
- **nmemo-w4j.10** — [verify] Regression sweep — existing tests still pass

Dependencies wired in beads:
- .2 depends on .1 (need migration applied)
- .3 depends on .2 (needs schema)
- .4, .5, .6 depend on .3 (use audit helpers)
- .7 depends on .4, .5 (handlers thread actor)
- .9 depends on .4, .5, .6, .7 (tests cover all)
- .10 depends on .9

`bd show nmemo-w4j` for full tree. `bd ready` for unblocked items.

## Exit Criteria → Phases 2, 3, 5

Phases 2 (Edge Lifecycle), 3 (Source Ref Index), and 5 (Contradiction Detection) can all start when:
1. Phase 1 acceptance met
2. Audit helpers callable and tested
3. Actor threading landed in all mutation paths
