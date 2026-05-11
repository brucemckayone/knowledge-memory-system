# Phase 2 — Edge Lifecycle (Corroboration + Decay + Cascade)

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Size:** M
**Depends on:** Phase 1 (audit trail)
**Blocks:** Phase 6 (pattern lifecycle uses corroboration signals)

## Purpose

Today `createCausalEdge()` is INSERT-only. Every assertion creates a new row. The schema has `corroboration_count`, `last_corroborated`, `decay_applied`, and `initial_strength` — all populated once at creation and never touched again. The lifecycle fields are dead.

This phase brings the edge lifecycle alive:

- **Corroboration** — a second assertion of the same causal link strengthens the existing edge instead of duplicating it
- **Decay** — uncorroborated edges fade over time until expired
- **Cascade** — expiring a fact weakens or expires the edges it supported

Every lifecycle transition writes an audit row. The reasoning agent reads that audit trail to calibrate confidence, detect flapping, and identify stable causal claims.

## Lifecycle Model

```d2
direction: right

created: "created\nstrength: 0.5-0.9\ncorroboration: 1" {
  shape: circle
  style.fill: "#d4edda"
}

corroborated: "corroborated\nstrength ↑ 0.05\ncorroboration +1\nlast_corroborated = NOW()" {
  shape: rectangle
  style.fill: "#cfe8ff"
}

strengthened: "strengthened\nstrength ↑\nreasoning unchanged" {
  shape: rectangle
  style.fill: "#cfe8ff"
}

weakened: "weakened\nstrength ↓\ncascade from fact" {
  shape: rectangle
  style.fill: "#fff3cd"
}

revised: "revised\nreasoning changed\nstrength updated" {
  shape: rectangle
  style.fill: "#cfe8ff"
}

decayed: "decayed\nstrength *= 0.95\nonce per cycle" {
  shape: rectangle
  style.fill: "#fff3cd"
}

expired: "expired\nstrength ≤ 0.1 OR\nupstream fact gone" {
  shape: circle
  style.fill: "#f8d7da"
}

created -> corroborated: "same (cause,effect)\nasserted again"
corroborated -> corroborated: "further evidence"
created -> strengthened: "new supporting\nfact cites this"
corroborated -> strengthened
strengthened -> revised: "reasoning\nupdate"
corroborated -> revised
created -> weakened: "fact cited as\nsource expired"
weakened -> expired: "strength ≤ 0.1"
strengthened -> decayed: "no activity\n30 days"
revised -> decayed
created -> decayed: "no corroboration\n30 days"
decayed -> decayed: "continued\ninactivity"
decayed -> expired: "strength ≤ 0.1"
```

Every arrow writes a `causal_edge_history` row with the relevant `event_type`, `actor`, `previous_strength`, `new_strength`, and `reasoning`.

## Part A — Corroboration

### Behaviour

When `createCausalEdge({ causeEventId, effectEventId, ... })` is called and an active edge already exists for that `(cause_event_id, effect_event_id)` pair:

1. **Do not INSERT.** Update the existing edge.
2. `corroboration_count` += 1
3. `last_corroborated` = NOW()
4. `strength` = `min(1.0, strength + 0.05)` — diminishing returns, capped
5. `source_references` |= new refs (append, deduplicate by `id`)
6. Record `causal_edge_history` row with `event_type = 'corroborated'`
7. Return the existing edge ID

### Semantic Corroboration

Two different causal events can describe the same causal claim. For example, two chunks of text mention "Rule 5.0 caused strict aliasing checks" — each chunk produces its own `created` causal event for `Rule 5.0`, but they're semantically the same assertion. A naive match on `(cause_event_id, effect_event_id)` misses this.

Semantic match rule: if there's an existing active edge `E` such that:
- `E.cause_event.subject_entity_id == new.cause_event.subject_entity_id`
- `E.cause_event.predicate == new.cause_event.predicate`
- `E.effect_event.subject_entity_id == new.effect_event.subject_entity_id`
- `E.effect_event.predicate == new.effect_event.predicate`
- `E.expired_at IS NULL`

Then corroborate `E` instead of creating a parallel edge. Only the strongest match corroborates if multiple candidates exist.

### Implementation — `platform/src/services/causal.ts`

```typescript
export async function createCausalEdge(params: CreateCausalEdgeParams): Promise<string> {
  // ... existing validation ...

  // Step 1: exact match on (cause_event_id, effect_event_id)
  const exact = await findActiveEdge(params.causeEventId, params.effectEventId);
  if (exact) return corroborateEdge(exact, params);

  // Step 2: semantic match via event metadata
  const semantic = await findSemanticallyEquivalentEdge(
    params.causeEventId,
    params.effectEventId,
  );
  if (semantic) return corroborateEdge(semantic, params);

  // Step 3: INSERT (existing path, now wrapped with audit)
  const edgeId = await insertNewEdge(params);
  await recordEdgeChange({
    edgeId,
    eventType: 'created',
    newStrength: params.strength,
    newReasoning: params.reasoning,
    reasoning: 'Edge created from new assertion',
    actor: params.actor,
    reasoningReportId: params.reasoningReportId,
  });
  return edgeId;
}

async function corroborateEdge(
  existing: CausalEdge,
  params: CreateCausalEdgeParams,
): Promise<string> {
  const newStrength = Math.min(1.0, existing.strength + 0.05);
  const mergedRefs = mergeSourceReferences(existing.sourceReferences, params.sourceReferences);

  await db.update(causalEdges)
    .set({
      strength: newStrength,
      corroborationCount: existing.corroborationCount + 1,
      lastCorroborated: new Date(),
      sourceReferences: mergedRefs,
    })
    .where(eq(causalEdges.id, existing.id));

  await recordEdgeChange({
    edgeId: existing.id,
    eventType: 'corroborated',
    previousStrength: existing.strength,
    newStrength,
    addedSourceRefs: diffSourceReferences(existing.sourceReferences, mergedRefs),
    reasoning: params.reasoning,
    actor: params.actor,
    reasoningReportId: params.reasoningReportId,
  });

  return existing.id;
}

function mergeSourceReferences(existing: SourceReference[], added: SourceReference[]): SourceReference[] {
  const keyOf = (r: SourceReference) => `${r.type}:${r.id}`;
  const map = new Map(existing.map(r => [keyOf(r), r]));
  for (const r of added) {
    if (!map.has(keyOf(r))) map.set(keyOf(r), r);
  }
  return [...map.values()];
}
```

### MCP Tool Response Enrichment

`get_causal_history` and related tools must surface corroboration so the reasoning agent knows an edge's strength basis:

```typescript
// Before
{ id, strength, reasoning, sourceReferences, extractionMethod }

// After
{
  id, strength, reasoning, sourceReferences, extractionMethod,
  corroborationCount,     // NEW
  lastCorroborated,       // NEW
  initialStrength,        // NEW (useful for decay calculation visibility)
  decayApplied,           // NEW
}
```

Viz endpoints follow the same pattern — `GET /api/viz/graph-c` and `GET /api/viz/unified` include the corroboration fields so UI can render line weight by `corroboration_count`.

## Part B — Confidence Decay

### Rationale

An edge asserted once, never corroborated, never cited by downstream evidence, represents a speculative claim. As the graph grows, these speculative claims accumulate and drown out stable ones. Decay is the counterweight — let them fade until they die.

### Decay Formula

```
Every DECAY_AGE_DAYS (default: 30) since last_corroborated:
  new_strength = max(DECAY_FLOOR, strength * DECAY_RATE)
  
Where:
  DECAY_AGE_DAYS = 30
  DECAY_RATE = 0.95       # 5% decay per cycle
  DECAY_FLOOR = 0.1       # floor before expiry
```

Once `strength <= DECAY_FLOOR`, expire the edge with `expire_reason = 'confidence decay'`.

### Qualification — Who Decays?

Only edges that meet ALL of:
- `expired_at IS NULL`
- `corroboration_count <= 1` — never reinforced
- `last_corroborated < NOW() - INTERVAL '30 days'` — stale
- `strength > DECAY_FLOOR` — above floor (otherwise ready to expire)
- `extraction_method = 'llm'` OR NULL — don't decay user-asserted edges

### Implementation — `applyConfidenceDecay()`

```typescript
export interface DecayResult {
  decayed: number;
  expired: number;
  decayedEdgeIds: string[];
  expiredEdgeIds: string[];
}

export async function applyConfidenceDecay(options: {
  rate?: number;        // default 0.95
  floor?: number;       // default 0.1
  ageDays?: number;     // default 30
  actor?: Actor;        // default 'system_trigger'
} = {}): Promise<DecayResult> {
  const rate = options.rate ?? 0.95;
  const floor = options.floor ?? 0.1;
  const ageDays = options.ageDays ?? 30;
  const actor = options.actor ?? 'system_trigger';

  // Step 1: identify candidates (in transaction for consistency)
  const candidates = await db.select()
    .from(causalEdges)
    .where(and(
      isNull(causalEdges.expiredAt),
      lte(causalEdges.corroborationCount, 1),
      lt(causalEdges.lastCorroborated, sql`NOW() - INTERVAL '${sql.raw(String(ageDays))} days'`),
      gt(causalEdges.strength, floor),
      or(isNull(causalEdges.extractionMethod), eq(causalEdges.extractionMethod, 'llm')),
    ));

  const decayed: string[] = [];
  const expired: string[] = [];

  for (const edge of candidates) {
    const newStrength = Math.max(floor, edge.strength * rate);
    const willExpire = newStrength <= floor;

    if (willExpire) {
      await db.update(causalEdges)
        .set({ strength: newStrength, expiredAt: new Date(), expireReason: 'confidence decay' })
        .where(eq(causalEdges.id, edge.id));
      await recordEdgeChange({
        edgeId: edge.id,
        eventType: 'expired',
        previousStrength: edge.strength,
        newStrength,
        reasoning: `Confidence decayed to floor (${floor}) without corroboration for ${ageDays}+ days`,
        actor,
      });
      expired.push(edge.id);
    } else {
      await db.update(causalEdges)
        .set({ strength: newStrength, decayApplied: true })
        .where(eq(causalEdges.id, edge.id));
      await recordEdgeChange({
        edgeId: edge.id,
        eventType: 'decayed',
        previousStrength: edge.strength,
        newStrength,
        reasoning: `Decayed by ${(1 - rate) * 100}% after ${ageDays}+ days without corroboration`,
        actor,
      });
      decayed.push(edge.id);
    }
  }

  return { decayed: decayed.length, expired: expired.length, decayedEdgeIds: decayed, expiredEdgeIds: expired };
}
```

## Part C — Cascade Invalidation

### Rationale

If fact F is expired or invalidated, any causal edge whose `source_references` cites F as evidence has lost its supporting grounding. The edge should react:

- If `corroboration_count > 1` (has other supporting evidence): **weaken** by 20%
- If `corroboration_count = 1` (F was the sole evidence): **expire** with reason `upstream fact expired`

This is a targeted cascade, not a full recompute. Only edges directly citing F are affected; second-order effects are left to subsequent patrol reasoning.

### Prerequisite

Cascade requires **Phase 3** (Source Reference Indexing) to efficiently find edges citing a fact. Until Phase 3 lands, cascade falls back to a JSONB scan — correct but slow. Document the dependency and ship Phase 3 first if possible.

### Implementation

```typescript
export interface CascadeResult {
  weakened: string[];
  expired: string[];
}

export async function cascadeFactExpiry(
  factId: string,
  options: { actor: Actor; reasoningReportId?: string }
): Promise<CascadeResult> {
  // After Phase 3: fast path via edge_source_refs join table
  // Before Phase 3: fall back to JSONB containment query
  const affected = await findEdgesCitingReference('fact', factId);

  const weakened: string[] = [];
  const expired: string[] = [];

  for (const edge of affected) {
    if (edge.expiredAt) continue;  // already dead

    if (edge.corroborationCount > 1) {
      const newStrength = Math.max(0.1, edge.strength * 0.8);
      await db.update(causalEdges)
        .set({ strength: newStrength })
        .where(eq(causalEdges.id, edge.id));
      await recordEdgeChange({
        edgeId: edge.id,
        eventType: 'weakened',
        previousStrength: edge.strength,
        newStrength,
        reasoning: `Upstream fact ${factId} was expired; edge has other corroboration so weakened 20%`,
        actor: 'cascade',
        reasoningReportId: options.reasoningReportId,
      });
      weakened.push(edge.id);
    } else {
      await db.update(causalEdges)
        .set({ expiredAt: new Date(), expireReason: `upstream fact ${factId} expired` })
        .where(eq(causalEdges.id, edge.id));
      await recordEdgeChange({
        edgeId: edge.id,
        eventType: 'expired',
        previousStrength: edge.strength,
        newStrength: edge.strength,
        reasoning: `Upstream fact ${factId} expired; this was the sole source of evidence for this edge`,
        actor: 'cascade',
        reasoningReportId: options.reasoningReportId,
      });
      expired.push(edge.id);
    }
  }

  return { weakened, expired };
}
```

### Integration in `facts.ts`

```typescript
export async function expireFact(params: { factId: string; reasoning: string; actor: Actor; reasoningReportId?: string }): Promise<CascadeResult> {
  // ... existing update + fact_history write ...
  
  // Cascade — runs synchronously within the same request
  return await cascadeFactExpiry(params.factId, { actor: params.actor, reasoningReportId: params.reasoningReportId });
}
```

## Auto-Trigger — Pipeline Integration

Decay runs on a counter pattern (same as gardener auto-trigger):

```typescript
// platform/src/pipeline.ts

const DECAY_RUN_INTERVAL = 10;
let decayRunCount = 0;

// Inside extract(), after graph meta + gardener section
decayRunCount++;
if (decayRunCount >= DECAY_RUN_INTERVAL) {
  decayRunCount = 0;
  try {
    const result = await applyConfidenceDecay();
    if (result.decayed > 0 || result.expired > 0) {
      console.log(`[decay] ${result.decayed} decayed, ${result.expired} expired`);
    }
  } catch (err) {
    console.warn('[decay] failed:', err instanceof Error ? err.message : err);
  }
}
```

## API Endpoints

```typescript
// platform/src/index.ts

app.post('/api/decay', async (c) => {
  const { applyConfidenceDecay } = await import('./services/causal.js');
  const result = await applyConfidenceDecay({ actor: 'user' });
  return c.json(result);
});
```

## Reasoning Agent Prompt Updates

Add to `ml-services/app/reasoning_agent.py`:

> **Edge Strength and Corroboration:** When you see `corroboration_count > 1` on an edge, that edge has been independently asserted by multiple sources — prefer it over edges with `corroboration_count = 1` when tracing chains. When you see `decay_applied = true`, the edge has lost strength due to inactivity; either reinforce it with new evidence or let it decay. Weak uncorroborated edges (`strength < 0.4` and `corroboration_count = 1`) are candidates for revision or expiry if you find contradicting evidence.

## Test Design

### Test File: `platform/src/test/harness/edge-lifecycle.test.ts`

```typescript
describe('Phase 2 — Edge Lifecycle', () => {
  beforeEach(async () => {
    await deleteFromTables(
      'causal_edge_history', 'fact_history',
      'causal_edges', 'causal_events',
      'memory_entities', 'entity_aliases', 'facts',
      'entity_merges', 'entities',
    );
  });

  describe('corroboration — exact match', () => {
    it('second assertion of same (cause,effect) corroborates instead of inserting', async () => {
      const { causeId, effectId } = await setupEvents();
      const id1 = await createCausalEdge({
        causeEventId: causeId, effectEventId: effectId,
        strength: 0.5, reasoning: 'first', sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'a' }],
        actor: 'graph_agent',
      });
      const id2 = await createCausalEdge({
        causeEventId: causeId, effectEventId: effectId,
        strength: 0.6, reasoning: 'second', sourceReferences: [{ type: 'memory', id: randomUUID(), relevance: 'b' }],
        actor: 'reasoning_agent',
      });
      expect(id1).toBe(id2);
      const edge = await getEdge(id1);
      expect(edge.corroborationCount).toBe(2);
      expect(edge.strength).toBeCloseTo(0.55, 5);  // 0.5 + 0.05 clamped
      expect(edge.sourceReferences).toHaveLength(2);
    });

    it('writes edge_history row with event_type=corroborated', async () => {
      const { causeId, effectId } = await setupEvents();
      const id = await createCausalEdge({ causeEventId: causeId, effectEventId: effectId, strength: 0.5, ..., actor: 'graph_agent' });
      await createCausalEdge({ causeEventId: causeId, effectEventId: effectId, strength: 0.6, ..., actor: 'reasoning_agent' });
      const hist = await getEdgeHistory(id);
      expect(hist[0].eventType).toBe('corroborated');
      expect(hist[0].previousStrength).toBe(0.5);
      expect(hist[0].newStrength).toBeCloseTo(0.55);
      expect(hist[0].actor).toBe('reasoning_agent');
    });

    it('caps strength at 1.0', async () => {
      const edge = await setupEdge({ strength: 0.98 });
      for (let i = 0; i < 5; i++) {
        await createCausalEdge({ /* same pair */ strength: 0.8, ..., actor: 'reasoning_agent' });
      }
      const result = await getEdge(edge.id);
      expect(result.strength).toBeLessThanOrEqual(1.0);
    });

    it('deduplicates source_references by type+id', async () => {
      const memoryId = randomUUID();
      const id = await createCausalEdge({ ..., sourceReferences: [{ type: 'memory', id: memoryId, relevance: 'a' }], actor: 'graph_agent' });
      await createCausalEdge({ ..., sourceReferences: [{ type: 'memory', id: memoryId, relevance: 'b' }], actor: 'reasoning_agent' });
      const edge = await getEdge(id);
      expect(edge.sourceReferences).toHaveLength(1);  // same memory id — not duplicated
    });

    it('does not corroborate expired edges', async () => {
      const id = await setupEdge();
      await expireCausalEdge({ edgeId: id, reasoning: 'test', actor: 'user' });
      const id2 = await createCausalEdge({ /* same pair */ ... });
      expect(id2).not.toBe(id);  // created a new edge
    });
  });

  describe('corroboration — semantic match', () => {
    it('matches when cause/effect events share entity+predicate but have different IDs', async () => {
      const entityA = await createTestEntity();
      const entityB = await createTestEntity();
      // Two facts about (A → works_at → B), each produces its own causal event
      const factId1 = await createFact({ subjectEntityId: entityA.id, predicate: 'works_at', objectEntityId: entityB.id, ... });
      const factId2 = await createFact({ subjectEntityId: entityA.id, predicate: 'works_at', objectEntityId: entityB.id, ... });
      // Events derived from these facts are semantically equivalent
      const event1 = await getCausalEventForFact(factId1);
      const event2 = await getCausalEventForFact(factId2);
      // ... complete test ...
    });

    it('picks strongest match when multiple semantic candidates exist', async () => { /* ... */ });
  });

  describe('confidence decay', () => {
    it('decays uncorroborated edges older than 30 days', async () => {
      const id = await setupEdge({ strength: 0.5 });
      await testDb.execute(sql`UPDATE causal_edges SET last_corroborated = NOW() - INTERVAL '31 days' WHERE id = ${id}`);
      const result = await applyConfidenceDecay();
      expect(result.decayed).toBe(1);
      const edge = await getEdge(id);
      expect(edge.strength).toBeCloseTo(0.475, 4);  // 0.5 * 0.95
      expect(edge.decayApplied).toBe(true);
    });

    it('does not decay corroborated edges', async () => {
      const id = await setupEdge({ strength: 0.5, corroborationCount: 3 });
      await testDb.execute(sql`UPDATE causal_edges SET last_corroborated = NOW() - INTERVAL '31 days' WHERE id = ${id}`);
      const result = await applyConfidenceDecay();
      expect(result.decayed).toBe(0);
    });

    it('expires edges that fall to floor strength', async () => {
      const id = await setupEdge({ strength: 0.11 });
      await testDb.execute(sql`UPDATE causal_edges SET last_corroborated = NOW() - INTERVAL '31 days' WHERE id = ${id}`);
      const result = await applyConfidenceDecay();
      expect(result.expired).toBe(1);
      const edge = await getEdge(id);
      expect(edge.expiredAt).not.toBeNull();
      expect(edge.expireReason).toBe('confidence decay');
    });

    it('does not decay edges with extraction_method=user', async () => { /* ... */ });

    it('writes edge_history row with event_type=decayed', async () => {
      const id = await setupEdge({ strength: 0.5 });
      await testDb.execute(sql`UPDATE causal_edges SET last_corroborated = NOW() - INTERVAL '31 days' WHERE id = ${id}`);
      await applyConfidenceDecay();
      const hist = await getEdgeHistory(id);
      expect(hist[0].eventType).toBe('decayed');
      expect(hist[0].actor).toBe('system_trigger');
      expect(hist[0].previousStrength).toBe(0.5);
      expect(hist[0].newStrength).toBeCloseTo(0.475);
    });

    it('writes edge_history row with event_type=expired and reason=confidence decay', async () => {
      const id = await setupEdge({ strength: 0.11 });
      await testDb.execute(sql`UPDATE causal_edges SET last_corroborated = NOW() - INTERVAL '31 days' WHERE id = ${id}`);
      await applyConfidenceDecay();
      const hist = await getEdgeHistory(id);
      expect(hist[0].eventType).toBe('expired');
    });
  });

  describe('cascade invalidation', () => {
    it('weakens edges with corroboration > 1 when source fact expires', async () => {
      const factId = await setupFact();
      const edgeId = await setupEdgeCitingFact(factId, { strength: 0.6, corroborationCount: 3 });
      await expireFact({ factId, reasoning: 'test', actor: 'user' });
      const edge = await getEdge(edgeId);
      expect(edge.strength).toBeCloseTo(0.48, 3);  // 0.6 * 0.8
      expect(edge.expiredAt).toBeNull();
    });

    it('expires edges with corroboration = 1 when sole source fact expires', async () => {
      const factId = await setupFact();
      const edgeId = await setupEdgeCitingFact(factId, { strength: 0.7, corroborationCount: 1 });
      await expireFact({ factId, reasoning: 'test', actor: 'user' });
      const edge = await getEdge(edgeId);
      expect(edge.expiredAt).not.toBeNull();
      expect(edge.expireReason).toContain('upstream fact');
    });

    it('writes edge_history row with actor=cascade', async () => {
      const factId = await setupFact();
      const edgeId = await setupEdgeCitingFact(factId, { corroborationCount: 1 });
      await expireFact({ factId, reasoning: 'test', actor: 'user' });
      const hist = await getEdgeHistory(edgeId);
      expect(hist[0].actor).toBe('cascade');
    });

    it('does not cascade across edges that cite other facts too', async () => {
      const factA = await setupFact();
      const factB = await setupFact();
      const edgeId = await setupEdgeCitingMultipleFacts([factA, factB], { corroborationCount: 2 });
      await expireFact({ factId: factA, reasoning: 'test', actor: 'user' });
      // Edge weakened but not expired because it has another source
      const edge = await getEdge(edgeId);
      expect(edge.expiredAt).toBeNull();
      expect(edge.strength).toBeLessThan(0.8);  // weakened
    });
  });

  describe('MCP tool enrichment', () => {
    it('get_causal_history surfaces corroboration fields', async () => {
      const entity = await createTestEntity();
      const edgeId = await setupEdgeInvolvingEntity(entity.id, { corroborationCount: 3 });
      const result = await handleToolCall('get_causal_history', { entity_id: entity.id }, { agent: 'reasoning_agent' });
      const edge = result.edges.find((e: any) => e.id === edgeId);
      expect(edge.corroborationCount).toBe(3);
      expect(edge.lastCorroborated).toBeDefined();
      expect(edge.initialStrength).toBeDefined();
    });
  });

  describe('auto-trigger', () => {
    it('decay runs after DECAY_RUN_INTERVAL extracts', async () => {
      // Mock or expose counter for test access
      for (let i = 0; i < 10; i++) {
        await runExtractForTest();
      }
      // After 10, decay should have run — indirect test via log or side effect
    });
  });

  describe('endpoint', () => {
    it('POST /api/decay returns structured result', async () => {
      const response = await fetch('http://localhost:3001/api/decay', { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('decayed');
      expect(body).toHaveProperty('expired');
    });
  });
});
```

### Coverage Targets

- [ ] Exact-match corroboration increments count, bumps strength, appends refs
- [ ] Semantic corroboration catches same claim from different events
- [ ] Corroboration caps strength at 1.0
- [ ] Source reference deduplication prevents double-counting
- [ ] Expired edges don't corroborate (new edge created instead)
- [ ] Decay reduces strength by correct ratio
- [ ] Decay respects `corroboration_count <= 1` filter
- [ ] Decay respects age threshold
- [ ] Decay expires edges at floor
- [ ] Decay writes history rows with `actor=system_trigger`
- [ ] Cascade weakens multi-corroborated edges by 20%
- [ ] Cascade expires single-source edges
- [ ] Cascade writes history with `actor=cascade`
- [ ] MCP tools surface corroboration fields
- [ ] Viz endpoints surface corroboration fields
- [ ] `/api/decay` endpoint callable

## Test Data Requirements

See [doc 18 — Test Data Hardening Protocol](18-test-data-hardening-protocol.md) for the overarching strategy.

### Fixture Inventory

```
platform/src/test/data/phase2-lifecycle/
├── fixtures/
│   ├── single-corroboration.sql          # L1 — one edge, one re-assertion
│   ├── multi-corroboration.sql           # L1 — one edge, 5 re-assertions
│   ├── semantic-near-duplicates.sql      # L1 — different events, same logical claim
│   ├── decay-threshold-boundary.sql      # L1 edge — age 29d vs 31d vs 90d
│   ├── cascade-single-source.sql         # L1 — fact expiry → sole-source edge expires
│   ├── cascade-multi-source.sql          # L1 — fact expiry → multi-source edge weakens
│   ├── corroboration-storm.sql           # adversarial — 100 corroborations rapid-fire
│   └── mixed-age-realistic.sql           # L2 — 100 edges, varied ages + corroboration counts
├── expected/
│   └── (per-fixture assertion JSON)
└── benchmark-reports/
```

### Benchmark Metrics

| Metric | Target | Notes |
|--------|--------|-------|
| Corroboration detection latency | <20ms | includes semantic check |
| `applyConfidenceDecay` throughput | ≥500 edges/sec | bulk SQL update |
| Cascade latency (100 affected edges) | <500ms | includes audit writes |
| Corroboration strength monotonicity | 100% | never decreases on corroborate |
| No double-decay | 100% | same edge not decayed twice per cycle |
| Source-ref dedup correctness | 100% | no duplicates in JSONB after corroborate |

### Adversarial Scenarios

- **Corroboration storm**: 100 corroborations on same edge within 1s. Assert corroboration_count = 101, strength capped at 1.0, 100 audit rows.
- **Timer manipulation**: manually set `last_corroborated` to epoch, run decay. Assert proper expiry.
- **Cascade to already-expired**: expire fact A twice. Assert second expiry is no-op, no double-cascade.
- **Exclusive predicate interference**: corroborate edge for exclusive predicate whose underlying fact got superseded. Assert sensible behaviour.

### Graduation Criteria

Level 1 → Level 2 when all fixtures pass, decay formula survives 30-day simulation without drift, cascade doesn't orphan audit rows.
Level 2 → Level 3 when integrated with ingest pipeline fixtures (tracked under TEST-E2E).

## Acceptance Criteria

Phase 2 is complete when:

- [ ] `createCausalEdge` corroborates on exact and semantic match
- [ ] `applyConfidenceDecay` runs on interval and via endpoint
- [ ] `cascadeFactExpiry` called automatically from `expireFact` / `invalidateFact`
- [ ] All lifecycle transitions write audit rows
- [ ] MCP tool responses include corroboration fields
- [ ] Reasoning agent prompt updated with corroboration guidance
- [ ] All tests pass
- [ ] No regressions in Phase 1 audit tests

## File Inventory

### Modified
- `platform/src/services/causal.ts` — corroboration logic, decay function, cascade function
- `platform/src/services/facts.ts` — call `cascadeFactExpiry` on expire/invalidate
- `platform/src/services/causal-agent.ts` — enriched tool responses
- `platform/src/pipeline.ts` — decay counter
- `platform/src/index.ts` — `/api/decay` endpoint, viz corroboration fields
- `ml-services/app/reasoning_agent.py` — corroboration guidance in prompt

### New
- `platform/src/test/harness/edge-lifecycle.test.ts`

No new migrations (all fields already exist from Phase B).

## Beads Issues

Parent: **nmemo-e2i** (Phase 2)

- **nmemo-e2i.1** — [service] Exact-match corroboration in createCausalEdge
- **nmemo-e2i.2** — [service] Semantic-match corroboration
- **nmemo-e2i.3** — [service] applyConfidenceDecay with env-var tuning
- **nmemo-e2i.4** — [service] cascadeFactExpiry wired into facts.ts (depends on nmemo-d1r.4)
- **nmemo-e2i.5** — [mcp] Enrich tool responses with corroboration fields
- **nmemo-e2i.6** — [api] /api/decay endpoint + pipeline auto-trigger
- **nmemo-e2i.7** — [prompt] Reasoning agent corroboration guidance
- **nmemo-e2i.8** — [test] edge-lifecycle.test.ts passing
- **nmemo-e2i.9** — [viz] Render corroboration as edge thickness (optional)

Key cross-phase dep: **nmemo-e2i.4** (cascade) blocks on **nmemo-d1r.4** from Phase 3 for efficient reverse lookup. Order Phase 3 before Phase 2 cascade implementation.

`bd show nmemo-e2i` for full tree.
