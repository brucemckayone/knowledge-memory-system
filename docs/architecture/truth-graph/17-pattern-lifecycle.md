# Phase 6 — Pattern Lifecycle

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Size:** L
**Depends on:** Phase 2 (corroboration signals drive promotion)
**Blocks:** None (ships capability — capstone)

## Purpose

The `causal_patterns` table exists with a full lifecycle schema — staging → candidate → provisional → canonical — and has zero code touching it. This phase brings it alive:

- **Detection** — scan recent causal chains, normalise to abstract templates, cluster structurally identical ones
- **Promotion** — templates appearing 3+ times enter staging; lifecycle transitions follow dwell and activation thresholds
- **Matching** — when a new causal edge is created, check if it starts or continues a known pattern
- **Ghost detection** — find missing expected links where a partial chain matches a canonical pattern
- **Naming** — Haiku-generates names and descriptions for patterns reaching candidate status

## Concept — How Patterns Emerge

A causal chain is a sequence of connected causal edges. A **template** is the same chain with entity names replaced by entity types and predicates replaced by predicate categories. When the same template appears in multiple chains, we have a pattern.

```d2
direction: right

concrete1: "Concrete Chain 1" {
  a1: "Rule 5.0\n(standard_rule)"
  a2: "Rule 5.1\n(standard_rule)"
  a3: "strict aliasing\n(compliance_practice)"
  a1 -> a2: "requires (REQUIRES)"
  a2 -> a3: "prevents (PREVENTS)"
}

concrete2: "Concrete Chain 2" {
  b1: "Rule 6.4\n(standard_rule)"
  b2: "Rule 6.5\n(standard_rule)"
  b3: "type narrowing\n(compliance_practice)"
  b1 -> b2: "requires (REQUIRES)"
  b2 -> b3: "prevents (PREVENTS)"
}

concrete3: "Concrete Chain 3" {
  c1: "Rule 21.3\n(standard_rule)"
  c2: "Rule 21.4\n(standard_rule)"
  c3: "memory safety\n(compliance_practice)"
  c1 -> c2: "requires (REQUIRES)"
  c2 -> c3: "prevents (PREVENTS)"
}

template: "Abstract Template\n(all 3 share this structure)" {
  style.fill: "#fff3cd"
  t1: "standard_rule"
  t2: "standard_rule"
  t3: "compliance_practice"
  t1 -> t2: "REQUIRES"
  t2 -> t3: "PREVENTS"
}

concrete1 -> template: "normalise"
concrete2 -> template: "normalise"
concrete3 -> template: "normalise"
```

## Lifecycle

```d2
direction: right

staging: "staging" {
  shape: circle
  style.fill: "#f8d7da"
  criteria: "≥ 3 instances\nfirst detected"
}

candidate: "candidate" {
  shape: circle
  style.fill: "#fff3cd"
  criteria: "≥ 5 instances\nseen in last 14d\n+ LLM name"
}

provisional: "provisional" {
  shape: circle
  style.fill: "#cfe8ff"
  criteria: "≥ 10 instances\n≥ 3 activations/30d"
}

canonical: "canonical" {
  shape: circle
  style.fill: "#d4edda"
  criteria: "14d in provisional\n≥ 5 activations/30d"
}

rejected: "rejected" {
  shape: circle
  style.fill: "#e0e0e0"
  criteria: "0 activations/30d\nat staging level"
}

staging -> candidate: "promote"
candidate -> provisional: "promote"
provisional -> canonical: "promote"

staging -> rejected: "demote\n(never reached threshold)"
candidate -> staging: "demote\n(inactivity)"
provisional -> candidate: "demote\n(inactivity)"
canonical -> provisional: "demote\n(significant decline)"
```

## Data Model — Drizzle Additions

The table already exists from Phase B. No migration required for Phase 6 — only code. But we add Drizzle-level helpers:

```typescript
// Schema types already exist; add the lifecycle enum constants
export const PATTERN_STATUSES = ['staging', 'candidate', 'provisional', 'canonical', 'rejected'] as const;
export type PatternStatus = typeof PATTERN_STATUSES[number];
```

Might optionally add a new migration to introduce `rejected` status if the existing check constraint doesn't allow it. Check `002_causal_graph.sql`:

```sql
CONSTRAINT valid_pattern_status CHECK (
  status IN ('staging', 'candidate', 'provisional', 'canonical')
)
```

Needs an extension:

```sql
-- platform/src/db/migrations/012_pattern_rejected.sql
ALTER TABLE public.causal_patterns
  DROP CONSTRAINT valid_pattern_status;
ALTER TABLE public.causal_patterns
  ADD CONSTRAINT valid_pattern_status CHECK (
    status IN ('staging', 'candidate', 'provisional', 'canonical', 'rejected')
  );
```

## Service — `platform/src/services/causal-patterns.ts`

### Detection

```typescript
export interface DetectOptions {
  minChainLength?: number;     // default 2
  maxChainLength?: number;     // default 6
  lookbackDays?: number;       // default 30
  instanceThreshold?: number;  // default 3 for staging
  maxChains?: number;          // default 1000
}

export interface DetectResult {
  chainsExamined: number;
  templatesFound: number;
  newStaging: number;
  updatedExisting: number;
}

export async function detectCausalPatterns(options: DetectOptions = {}): Promise<DetectResult>;
```

Steps:

1. **Collect chains** — recursive CTE walks active causal edges from events in the last `lookbackDays`. Caps at `maxChains` chains. Returns sequences of `(edge_id, cause_event_id, effect_event_id)` up to `maxChainLength`.

2. **Normalise** — for each chain, replace each edge's event metadata with:
   - cause event: `subject_entity_type` + `transition_type` + `predicate_category`
   - effect event: same

   Template structure is a JSONB array:
   ```json
   [
     { "entity_type": "standard_rule", "transition": "created", "predicate_category": "compliance" },
     { "entity_type": "standard_rule", "transition": "created", "predicate_category": "compliance" },
     { "entity_type": "compliance_practice", "transition": "created", "predicate_category": "effects" }
   ]
   ```

3. **Cluster** — group normalised templates by structural equality (JSON canonicalisation + hash). Count occurrences per template.

4. **Upsert** — for each template with count ≥ threshold:
   - If template exists in `causal_patterns`: UPDATE `instance_count`, `last_seen_at`, `avg_strength` (rolling average), `avg_temporal_span` (rolling average)
   - If new: INSERT with `status = 'staging'`, generate `pattern_embedding` from text description

5. **Record edge→pattern linkage** — update each participating `causal_edges.pattern_id` and `pattern_position`.

### Predicate Category Table

Detection depends on knowing which category each predicate belongs to. Use existing `fact_predicates.category` column (from the ontology system). For unknown predicates, fall back to the predicate string itself (less aggressive normalisation).

### Promotion

```typescript
export interface PromoteResult {
  promoted: Array<{ id: string; from: PatternStatus; to: PatternStatus; name?: string }>;
  demoted: Array<{ id: string; from: PatternStatus; to: PatternStatus }>;
  rejected: Array<{ id: string; reason: string }>;
}

export async function promotePatterns(options: {
  actor?: Actor;
} = {}): Promise<PromoteResult>;
```

Thresholds (env-tunable):

```typescript
const PATTERN_STAGING_TO_CANDIDATE = { instances: 5, lookbackDays: 14 };
const PATTERN_CANDIDATE_TO_PROVISIONAL = { instances: 10, activations30d: 3 };
const PATTERN_PROVISIONAL_TO_CANONICAL = { dwellDays: 14, activations30d: 5 };
const PATTERN_DEMOTION = { activations30d: 0, demoteAfterDays: 30 };
const PATTERN_REJECTION = { stagingDays: 14, activations30d: 0 };
```

Logic:

- **staging → candidate**: If `instance_count >= 5` AND `last_seen_at >= NOW() - 14 days`, promote. Call `nameCandidatePatterns()` on newly-promoted patterns.
- **candidate → provisional**: If `instance_count >= 10` AND `activation_count_30d >= 3`, promote.
- **provisional → canonical**: If `NOW() - promoted_at >= 14 days` (in provisional) AND `activation_count_30d >= 5`, promote.
- **Demotion**: if `activation_count_30d == 0` for 30+ days, demote one level. Canonical → provisional, provisional → candidate, candidate → staging. Staging → rejected (terminal).

### LLM Naming

```typescript
async function nameCandidatePatterns(patternIds: string[]): Promise<void> {
  for (const id of patternIds) {
    const pattern = await getPattern(id);
    if (pattern.name) continue;  // already named

    const prompt = [
      "This recurring causal pattern appeared in the graph:",
      JSON.stringify(pattern.templateStructure, null, 2),
      `Instance count: ${pattern.instanceCount}`,
      `Average strength: ${pattern.avgStrength}`,
      "Generate:",
      "1. A short, action-oriented name (3-6 words)",
      "2. A one-sentence description",
      "Respond in JSON: { name, description }"
    ].join('\n');

    const result = await ml.generateJson(prompt, { task: 'pattern_naming' });
    await db.update(causalPatterns)
      .set({ name: result.name, description: result.description })
      .where(eq(causalPatterns.id, id));
  }
}
```

`pattern_naming` added to `TASK_DEFAULTS` in `llm.py`: `{ model: "haiku", effort: "low" }`.

### Edge Matching on Creation

```typescript
export async function matchEdgeToPattern(edgeId: string): Promise<string | null>;
```

Called fire-and-forget from `createCausalEdge()` after INSERT/corroborate. Never blocks edge creation — if pattern matching fails, log warning, continue.

Algorithm:

1. Load the edge and its cause/effect events
2. Build a 1-step template from this edge's normalised metadata
3. Find provisional/canonical patterns whose template[0] matches this 1-step structure
4. For each candidate:
   - Look back at the cause event's preceding edges — do they match template[-1..0]?
   - Look forward at the effect event's following edges — do they match template[1..N]?
5. If a full match is found, set `edge.pattern_id`, `edge.pattern_position`, increment `pattern.activation_count_30d`, update `pattern.last_seen_at`

Also add partial matches (mid-chain) by treating the new edge as potentially completing a pattern started by earlier edges.

### Ghost Detection

```typescript
export interface Ghost {
  patternId: string;
  patternName: string | null;
  expectedCauseEntityType: string;
  expectedEffectEntityType: string;
  expectedPredicateCategory: string;
  positionInPattern: number;
  confidence: number;      // pattern.avg_strength adjusted by completeness
  reasoning: string;
}

export async function findCausalGhosts(entityId: string): Promise<Ghost[]>;
```

Algorithm:

1. Get all canonical patterns involving this entity's type
2. For each pattern, find where the entity has edges matching `N-1` steps but is missing one (either the first step, the last step, or a middle step)
3. Score ghosts by pattern `avg_strength` × match completeness
4. Return top ghosts sorted by confidence

### Active Patterns Query

```typescript
export async function activePatterns(options: {
  entityId?: string;
  status?: PatternStatus[];
  limit?: number;
} = {}): Promise<CausalPattern[]>;
```

Filters by status (default: `['provisional', 'canonical']`). If `entityId` provided, joins through `causal_edges.pattern_id` to edges involving that entity.

## Pipeline Integration

Pattern detection runs periodically on a DB-reactive cadence. The original
design (this doc, pre-`nmemo-2yv.72`) hitched detection to a counter ticked
inside `invokeReasoningAgent()` — a Rule 2 violation per doc 34 §3.4 because
the cadence went dormant whenever the patrol was dormant. The current shape:

- `public.derived_freshness` (migration 024 + 035) holds a `pattern_detection`
  row with `facts_since_compute` ticked by the existing AFTER-INSERT trigger
  on `public.facts`.
- `services/derived-freshness.ts::maybeFirePatternDetection()` is called
  from `createFact()`'s post-insert hook. When `facts_since_compute` crosses
  `PATTERN_DETECTION_FACT_THRESHOLD` (default 50), the helper atomically
  resets the row and fires `detectCausalPatterns()` + `promotePatterns()`
  fire-and-forget in-process.
- Manual debug surfaces (`POST /api/patterns/detect`, `POST /api/patterns/promote`)
  remain as Rule-3 endpoints — no production trigger relies on them.

```typescript
// platform/src/services/derived-freshness.ts (simplified)

export async function maybeFirePatternDetection(): Promise<void> {
  const claimed = await tryClaimThresholdReset(
    'pattern_detection',
    config.PATTERN_DETECTION_FACT_THRESHOLD,
  );
  if (!claimed) return;
  void (async () => {
    const detection = await detectCausalPatterns();
    const promotion = await promotePatterns();
    console.log(`[patterns] ${detection.newStaging} new, ${promotion.promoted.length} promoted`);
    await markDerivedComputed('pattern_detection');
  })();
}
```

The `tryClaimThresholdReset` step is an atomic `UPDATE ... RETURNING` against
the `pattern_detection` row — concurrent inserts each call the helper, but
only the inserter that crossed the threshold gets a returning row and owns
the fire. Doc 32 §2 catalogues this trigger; doc 34 §3.4 records the cleanup.

## API + MCP

### HTTP

```typescript
app.post('/api/patterns/detect', ...);   // manual trigger
app.post('/api/patterns/promote', ...);  // manual trigger
app.get('/api/patterns', ...);           // list (with status filter)
app.get('/api/patterns/:id/instances', ...);  // edges matching this pattern
app.get('/api/ghosts/:entityId', ...);   // findCausalGhosts endpoint
```

### MCP Tools

```typescript
{
  name: 'get_active_patterns',
  description: 'List active causal patterns. Filter by entity involvement or status. Provisional and canonical patterns are stable enough to reason with.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
      status: { type: 'array', items: { enum: ['staging', 'candidate', 'provisional', 'canonical'] } },
      limit: { type: 'number', default: 20 },
    },
  },
}

{
  name: 'find_causal_ghosts',
  description: 'Find expected-but-missing causal links for an entity, based on canonical pattern templates. Use during patrol to discover likely edges the graph is missing.',
  inputSchema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', format: 'uuid' },
    },
    required: ['entity_id'],
  },
}

{
  name: 'get_pattern_instances',
  description: 'Get the concrete causal chains that instantiate a given pattern.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern_id: { type: 'string', format: 'uuid' },
      limit: { type: 'number', default: 10 },
    },
    required: ['pattern_id'],
  },
}
```

## Reasoning Agent Prompt Updates

Add to patrol mode:

> **After investigating a neighbourhood, call `find_causal_ghosts(entity_id)` for the central entity.**
> For each high-confidence ghost (> 0.6):
> 1. Check if the expected cause/effect entities exist in the graph
> 2. Read source memories via `search_memories` for evidence that this causal link is supported
> 3. If evidence supports it, create the edge via `create_causal_edge` with reasoning explaining: "this edge completes canonical pattern [name]"
> 4. If no evidence supports it, do nothing — don't fabricate edges

Add to query mode:

> **When answering questions about processes or mechanisms, call `get_active_patterns` with the relevant entity.**
> Canonical patterns are stable causal templates in this knowledge. Citing them in your answer makes the reasoning more authoritative and traceable.

## Test Design

### Test File: `platform/src/test/harness/causal-patterns.test.ts`

```typescript
describe('Phase 6 — Pattern Lifecycle', () => {
  beforeEach(async () => {
    await deleteFromTables(
      'contradictions', 'causal_edge_history', 'fact_history',
      'edge_source_refs', 'causal_edges', 'causal_events',
      'causal_patterns', 'memory_entities', 'entity_aliases',
      'facts', 'entity_merges', 'entities',
    );
  });

  describe('detection — chain collection', () => {
    it('collects chains of length 2 to 6 from active edges', async () => {
      await setupChain(4);  // 4-edge chain
      const result = await detectCausalPatterns();
      expect(result.chainsExamined).toBeGreaterThan(0);
    });

    it('respects maxChainLength', async () => {
      await setupChain(10);  // long chain
      const result = await detectCausalPatterns({ maxChainLength: 3 });
      // no chain longer than 3 should be examined
    });

    it('excludes chains containing expired edges', async () => { /* ... */ });

    it('respects lookbackDays window', async () => {
      await setupChain(3, { occurredAt: new Date('2026-01-01') });
      const result = await detectCausalPatterns({ lookbackDays: 30 });
      expect(result.chainsExamined).toBe(0);
    });
  });

  describe('detection — template normalisation', () => {
    it('replaces entity references with entity types', async () => {
      // Two chains: [Rule A → Rule B] and [Rule C → Rule D]
      // Both should normalise to the same template: [standard_rule → standard_rule]
      await setupTypedChain([{ type: 'standard_rule' }, { type: 'standard_rule' }]);
      await setupTypedChain([{ type: 'standard_rule' }, { type: 'standard_rule' }]);
      const result = await detectCausalPatterns({ instanceThreshold: 2 });
      const patterns = await testDb.select().from(causalPatterns);
      expect(patterns).toHaveLength(1);
      expect((patterns[0].templateStructure as any[])[0].entity_type).toBe('standard_rule');
    });

    it('falls back to predicate string when category is unknown', async () => { /* ... */ });
  });

  describe('detection — clustering and thresholds', () => {
    it('promotes template with 3 instances to staging', async () => {
      for (let i = 0; i < 3; i++) await setupTypedChain(sameTemplate);
      const result = await detectCausalPatterns({ instanceThreshold: 3 });
      expect(result.newStaging).toBe(1);
      const pattern = (await testDb.select().from(causalPatterns))[0];
      expect(pattern.status).toBe('staging');
      expect(pattern.instanceCount).toBe(3);
    });

    it('updates existing pattern on second detection pass', async () => {
      for (let i = 0; i < 3; i++) await setupTypedChain(sameTemplate);
      await detectCausalPatterns({ instanceThreshold: 3 });
      await setupTypedChain(sameTemplate);  // 4th instance
      const result = await detectCausalPatterns({ instanceThreshold: 3 });
      expect(result.newStaging).toBe(0);
      expect(result.updatedExisting).toBe(1);
      const pattern = (await testDb.select().from(causalPatterns))[0];
      expect(pattern.instanceCount).toBe(4);
    });

    it('does not promote template below threshold', async () => {
      for (let i = 0; i < 2; i++) await setupTypedChain(sameTemplate);
      await detectCausalPatterns({ instanceThreshold: 3 });
      const patterns = await testDb.select().from(causalPatterns);
      expect(patterns).toHaveLength(0);
    });

    it('sets edge.pattern_id for edges in the template', async () => {
      const edges = await setupTypedChainInstances(3, sameTemplate);
      await detectCausalPatterns({ instanceThreshold: 3 });
      for (const edgeId of edges) {
        const edge = await getEdge(edgeId);
        expect(edge.patternId).not.toBeNull();
        expect(edge.patternPosition).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('promotion lifecycle', () => {
    it('staging → candidate at instance threshold', async () => {
      const patternId = await setupPattern({ status: 'staging', instanceCount: 5, lastSeenAt: new Date() });
      const result = await promotePatterns();
      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0].to).toBe('candidate');
    });

    it('candidate → provisional with activation threshold', async () => {
      const patternId = await setupPattern({ status: 'candidate', instanceCount: 12, activationCount30d: 4 });
      await promotePatterns();
      const pattern = await getPattern(patternId);
      expect(pattern.status).toBe('provisional');
    });

    it('provisional → canonical after dwell + activations', async () => {
      const patternId = await setupPattern({
        status: 'provisional',
        promotedAt: new Date(Date.now() - 15 * 86400 * 1000),  // 15 days ago
        activationCount30d: 6,
      });
      await promotePatterns();
      const pattern = await getPattern(patternId);
      expect(pattern.status).toBe('canonical');
    });

    it('demotes inactive canonical to provisional', async () => {
      const patternId = await setupPattern({
        status: 'canonical',
        activationCount30d: 0,
        lastSeenAt: new Date(Date.now() - 31 * 86400 * 1000),
      });
      await promotePatterns();
      const pattern = await getPattern(patternId);
      expect(pattern.status).toBe('provisional');
    });

    it('staging with no activity for 14 days moves to rejected', async () => {
      const patternId = await setupPattern({
        status: 'staging',
        lastSeenAt: new Date(Date.now() - 15 * 86400 * 1000),
        activationCount30d: 0,
      });
      await promotePatterns();
      const pattern = await getPattern(patternId);
      expect(pattern.status).toBe('rejected');
    });
  });

  describe('LLM naming', () => {
    it('generates name and description when pattern promotes to candidate', async () => {
      const patternId = await setupPattern({ status: 'staging', instanceCount: 5, lastSeenAt: new Date(), name: null });
      await promotePatterns();
      const pattern = await getPattern(patternId);
      expect(pattern.status).toBe('candidate');
      expect(pattern.name).not.toBeNull();
      expect(pattern.description).not.toBeNull();
    });

    it('does not re-generate name if one already exists', async () => {
      const patternId = await setupPattern({ status: 'staging', instanceCount: 5, lastSeenAt: new Date(), name: 'existing name' });
      await promotePatterns();
      const pattern = await getPattern(patternId);
      expect(pattern.name).toBe('existing name');
    });
  });

  describe('edge matching on creation', () => {
    it('matchEdgeToPattern sets pattern_id when edge matches canonical pattern', async () => {
      const patternId = await setupCanonicalPattern();  // template: [A_type → B_type → C_type]
      // Create precursor edge
      const priorEdge = await setupEdge({ /* A_type → B_type */ });
      await matchEdgeToPattern(priorEdge);  // should match start of pattern
      // Create completing edge
      const newEdge = await createCausalEdge({ /* B_type → C_type */ ..., actor: 'graph_agent' });
      const edge = await getEdge(newEdge);
      expect(edge.patternId).toBe(patternId);
    });

    it('does not match against staging patterns', async () => {
      const patternId = await setupPattern({ status: 'staging' });
      const edgeId = await createCausalEdge({ /* matches staging */ ..., actor: 'graph_agent' });
      const edge = await getEdge(edgeId);
      expect(edge.patternId).toBeNull();
    });

    it('increments activation_count_30d on match', async () => {
      const patternId = await setupCanonicalPattern({ activationCount30d: 0 });
      await createCausalEdge({ /* matches */ ..., actor: 'graph_agent' });
      const pattern = await getPattern(patternId);
      expect(pattern.activationCount30d).toBe(1);
    });

    it('updates last_seen_at on match', async () => {
      const patternId = await setupCanonicalPattern({ lastSeenAt: new Date('2026-01-01') });
      await createCausalEdge({ /* matches */ ..., actor: 'graph_agent' });
      const pattern = await getPattern(patternId);
      expect(pattern.lastSeenAt!.getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());
    });
  });

  describe('ghost detection', () => {
    it('finds missing link when entity has N-1 of N pattern steps', async () => {
      const patternId = await setupCanonicalPattern();
      const entity = await createTestEntity({ entityType: 'standard_rule' });
      // Build a partial chain — entity has steps 0 and 1 but missing step 2
      await setupPartialChain(entity, patternId, { coverage: 2 });
      const ghosts = await findCausalGhosts(entity.id);
      expect(ghosts.length).toBeGreaterThan(0);
      expect(ghosts[0].positionInPattern).toBe(2);
    });

    it('scores ghosts by pattern.avg_strength', async () => {
      const strongPattern = await setupCanonicalPattern({ avgStrength: 0.9 });
      const weakPattern = await setupCanonicalPattern({ avgStrength: 0.4 });
      const entity = await createTestEntity();
      await setupPartialForBothPatterns(entity, strongPattern, weakPattern);
      const ghosts = await findCausalGhosts(entity.id);
      const strongGhost = ghosts.find(g => g.patternId === strongPattern);
      const weakGhost = ghosts.find(g => g.patternId === weakPattern);
      expect(strongGhost!.confidence).toBeGreaterThan(weakGhost!.confidence);
    });

    it('returns empty array when entity matches no patterns', async () => {
      const entity = await createTestEntity({ entityType: 'unrelated' });
      const ghosts = await findCausalGhosts(entity.id);
      expect(ghosts).toEqual([]);
    });
  });

  describe('active patterns query', () => {
    it('filters by status', async () => {
      await setupPattern({ status: 'staging' });
      await setupPattern({ status: 'canonical' });
      const result = await activePatterns({ status: ['canonical'] });
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('canonical');
    });

    it('filters by entity involvement', async () => {
      const entity = await createTestEntity();
      const p1 = await setupCanonicalPatternInvolving(entity.id);
      const p2 = await setupCanonicalPattern();  // unrelated
      const result = await activePatterns({ entityId: entity.id });
      expect(result.map(r => r.id)).toContain(p1);
      expect(result.map(r => r.id)).not.toContain(p2);
    });
  });

  describe('MCP tools', () => {
    it('get_active_patterns returns structured list', async () => {
      await setupCanonicalPattern();
      const result = await handleToolCall('get_active_patterns', { status: ['canonical'] }, { agent: 'reasoning_agent' });
      expect(Array.isArray(result)).toBe(true);
    });

    it('find_causal_ghosts returns list of missing links', async () => {
      const entity = await createTestEntity();
      const result = await handleToolCall('find_causal_ghosts', { entity_id: entity.id }, { agent: 'reasoning_agent' });
      expect(Array.isArray(result)).toBe(true);
    });

    it('get_pattern_instances returns concrete chains for a pattern', async () => {
      const patternId = await setupCanonicalPattern();
      const result = await handleToolCall('get_pattern_instances', { pattern_id: patternId }, { agent: 'reasoning_agent' });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('performance', () => {
    it('detection completes in under 2s on 1000 edges', async () => {
      await generateGraph({ edges: 1000 });
      const t0 = Date.now();
      await detectCausalPatterns();
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('matchEdgeToPattern completes in under 200ms', async () => {
      await setupCanonicalPatterns(5);
      const t0 = Date.now();
      const edgeId = await createCausalEdge({ ... });
      await matchEdgeToPattern(edgeId);
      expect(Date.now() - t0).toBeLessThan(200);
    });
  });
});
```

### Coverage Targets

- [ ] Chain collection respects length and lookback bounds
- [ ] Excludes expired edges
- [ ] Normalisation replaces entity refs with types
- [ ] Normalisation replaces predicates with categories (with fallback)
- [ ] 3+ identical instances promoted to staging
- [ ] Existing patterns updated on second pass (not duplicated)
- [ ] `edge.pattern_id` set for matched edges
- [ ] All lifecycle transitions work at correct thresholds
- [ ] Demotion works (canonical → provisional → candidate → staging → rejected)
- [ ] LLM naming called on promotion to candidate
- [ ] LLM naming skipped when name exists
- [ ] `matchEdgeToPattern` matches canonical/provisional only
- [ ] Match increments activation count
- [ ] Ghost detection finds missing steps
- [ ] Ghost scoring uses pattern strength
- [ ] Active patterns query filters correctly
- [ ] MCP tools callable
- [ ] Performance targets met

## Test Data Requirements

See [doc 18 — Test Data Hardening Protocol](18-test-data-hardening-protocol.md). This is the phase with the most sophisticated test data needs — patterns emerge from corpora, not from simple fixtures.

### Fixture Inventory

```
platform/src/test/data/phase6-patterns/
├── fixtures/
│   ├── three-identical-chains.sql              # L1 — minimum for staging (3 instances, same template)
│   ├── ten-identical-chains.sql                # L1 — threshold for candidate promotion
│   ├── two-near-templates.sql                  # L1 edge — same structure, different predicate categories (should NOT merge)
│   ├── canonical-pattern-seeded.sql            # L1 — pre-seeded pattern at canonical status
│   ├── promotion-lifecycle-progression.sql     # L2 — time-series fixtures to test staging→candidate→provisional→canonical
│   ├── demotion-inactive.sql                   # L2 — canonical pattern with 0 activations for 30d
│   ├── partial-chain-for-ghost.sql             # L1 — entity has N-1 of N steps, ghost target
│   ├── multi-pattern-entity.sql                # L2 — entity participates in 3 patterns simultaneously
│   ├── noisy-emergence-corpus.sql              # L3 — realistic corpus with patterns mixed into noise
│   ├── misra-rule-chains.sql                   # L3 — MISRA rule dependency chains for real pattern detection
│   ├── pattern-poisoning.sql                   # adversarial — identical chains with no semantic meaning
│   ├── ghost-flood.sql                         # adversarial — high-fan-out entity, many matching patterns
│   └── promotion-race.sql                      # adversarial — concurrent promotion attempts
├── expected/
│   ├── three-identical-chains.expected.json
│   └── (per-fixture, including expected pattern IDs and template structures)
└── benchmark-reports/
```

### Benchmark Metrics

| Metric | Target |
|--------|--------|
| `detectCausalPatterns` on 1000 chains | <2s |
| Template normalisation — identical structures produce identical templates | 100% |
| 3-instance threshold triggers staging | 100% |
| Promotion lifecycle correctness | 100% (vs expected JSON timeline) |
| LLM naming called at most once per pattern | 100% |
| `matchEdgeToPattern` latency | <200ms |
| Match accuracy on canonical patterns | ≥ 90% |
| Ghost detection precision | ≥ 80% — don't surface low-confidence ghosts |
| Ghost detection recall (where pattern exists) | ≥ 70% |
| Pattern demotion on inactivity | 100% | |
| No pattern_id drift (edges match their pattern's template) | 100% |

### Adversarial

- **Pattern poisoning**: 100 identical chains that are semantically meaningless (all predicates=foo). Protocol: should staging detect them? Probably yes — but naming should reveal meaninglessness. Track this as a naming-quality benchmark.
- **Ghost flood**: entity with 50 matching partial patterns. Response time and top-K selection quality.
- **Chain length boundary**: chain of exactly 6 (max). Assert included. Chain of 7: assert excluded.
- **Concurrent promotion**: two calls to `promotePatterns()` in parallel. Assert no double-promotion, atomicity.
- **Normalisation edge**: chain with unknown predicate category. Assert fallback to predicate string doesn't accidentally match known-category template.

### Graduation

Level 1 → Level 2 when detection + promotion lifecycle work on synthetic data.
Level 2 → Level 3 when real MISRA patterns emerge from ingest + detection cycle without false positives.
Level 3 → Level 4 (end-to-end): ghost detection produces actionable suggestions that the reasoning agent can act on, measured via the TEST-E2E benchmark (`bd show nmemo-klv.7`).

### Critical for Agentic Loop

Phase 6 is the phase where the test-harden skill gets the most value. The skill should:
1. Generate synthetic chain corpora with controlled structure
2. Run detection, compare against expected patterns
3. Inject noise progressively, measure precision/recall degradation
4. Identify at what noise level detection breaks, log as code-improvement issue

## Acceptance Criteria

Phase 6 is complete when:

- [ ] Migration `012_pattern_rejected.sql` applied (if needed)
- [ ] `detectCausalPatterns()` discovers templates from live graph data
- [ ] Lifecycle transitions triggered correctly
- [ ] Pattern matching populates `causal_edges.pattern_id`
- [ ] Ghost detection returns sensible candidates
- [ ] LLM naming produces names for candidate patterns
- [ ] MCP tools registered and functional
- [ ] Reasoning agent prompt mentions ghost detection and active patterns
- [ ] Pipeline auto-runs pattern detection and promotion
- [ ] Viz shows patterns as overlay on matching edges
- [ ] All tests pass

## File Inventory

### New
- `platform/src/services/causal-patterns.ts` (~500 LOC)
- `platform/src/db/migrations/012_pattern_rejected.sql` (optional, constraint update)
- `platform/src/test/harness/causal-patterns.test.ts`

### Modified
- `platform/src/services/causal.ts` — `matchEdgeToPattern()` call in `createCausalEdge`
- `platform/src/services/causal-agent.ts` — 3 new MCP tools
- `platform/src/services/ml-client.ts` — `generateJson` helper for pattern naming
- `ml-services/app/core/llm.py` — `pattern_naming` task default
- `ml-services/app/reasoning_agent.py` — ghost detection in patrol, active patterns in query
- `platform/src/pipeline.ts` — pattern detection trigger
- `platform/src/index.ts` — `/api/patterns/*`, `/api/ghosts/:entityId` endpoints
- `platform/viz/js/app.js`, `index.html` — pattern overlay UI

## Beads Issues

Parent: **nmemo-d9v** (Phase 6)

- **nmemo-d9v.1** — [migration] 012_pattern_rejected status constraint
- **nmemo-d9v.2** — [service] detectCausalPatterns — chain collection (recursive CTE)
- **nmemo-d9v.3** — [service] detectCausalPatterns — template normalisation
- **nmemo-d9v.4** — [service] detectCausalPatterns — clustering + upsert to staging
- **nmemo-d9v.5** — [service] promotePatterns — lifecycle transitions
- **nmemo-d9v.6** — [service] promotePatterns — demotion and rejection
- **nmemo-d9v.7** — [service] nameCandidatePatterns via Haiku
- **nmemo-d9v.8** — [service] matchEdgeToPattern + wire into createCausalEdge
- **nmemo-d9v.9** — [service] findCausalGhosts
- **nmemo-d9v.10** — [service] activePatterns query
- **nmemo-d9v.11** — [mcp] get_active_patterns, find_causal_ghosts, get_pattern_instances
- **nmemo-d9v.12** — [prompt] Ghost detection in patrol, patterns in query
- **nmemo-d9v.13** — [pipeline] Auto-trigger after reasoning patrol runs
- **nmemo-d9v.14** — [api] HTTP endpoints for patterns + ghosts
- **nmemo-d9v.15** — [viz] Pattern overlay UI
- **nmemo-d9v.16** — [test] causal-patterns.test.ts passing

`bd show nmemo-d9v` for full tree.
