# Phase 4 — Blast Radius Analysis

**Parent:** [10 — Reasoning Layer Overview](10-reasoning-layer-overview.md)
**Size:** M
**Depends on:** Phase 3 (source reference index)
**Blocks:** None (ships capability)

## Purpose

Given any node in the graph (fact, entity, or causal event), return the full impact tree: what depends on it, what breaks if it changes, and how severe each dependency is.

This is the "what happens if I pull this thread" query. The reasoning agent calls it before destructive actions. The viz calls it to render impact overlays. A user calls it to understand consequences before manual intervention.

## Concept

```d2
direction: right

root: "Fact F\n(the target)" {
  shape: circle
  style.fill: "#f8d7da"
}

direct_facts: "Direct Facts\n(share entity)" {
  f1: "F1"
  f2: "F2"
  style.fill: "#cfe8ff"
}

direct_edges: "Direct Edges\n(touch this fact)" {
  e1: "Edge E1"
  style.fill: "#cfe8ff"
}

citing_edges: "Citation Dependents\n(cite F as evidence)" {
  e2: "Edge E2"
  e3: "Edge E3"
  style.fill: "#fff3cd"
}

transitive: "Transitive Chains\n(N-hop causal)" {
  t1: "Edge T1"
  t2: "Edge T2\n(depth 2)"
  style.fill: "#d4edda"
}

patterns: "Pattern Membership" {
  p1: "Pattern P1\n(F is step 2)"
  style.fill: "#e6d9ec"
}

root -> direct_facts: "shared subject/object"
root -> direct_edges: "causal event"
root -> citing_edges: "via edge_source_refs"
root -> transitive: "recursive CTE"
root -> patterns: "causal_edges.pattern_id"
transitive.t1 -> transitive.t2: "chain continues"
```

Each dependent is returned with:
- **relationship**: how it's connected (direct, transitive, citation, pattern_member)
- **depth**: hop count from the root (0 for direct)
- **severity**: how badly it would be affected by a change to the root
- **reasoning**: human-readable explanation

## Severity Scoring

Five rules, evaluated in order. First match wins.

| Condition | Severity |
|-----------|----------|
| Edge has corroboration_count >= 3 AND this node is its sole evidence | **critical** |
| Direct causal child / transitive depth=1, effect has no other active causes | **high** |
| Citation dependent where edge is active and strength >= 0.7 | **high** |
| Transitive depth=1, effect has 1-2 other active causes | **medium** |
| Transitive depth=1, effect has >=3 other active causes | **low** |
| Citation dependent where edge has multiple other sources | **medium** |
| Direct fact sharing entity | **medium** |
| Transitive chain at depth 2 | **medium** |
| Transitive chain at depth 3+ | **low** |
| Pattern member, root would orphan the pattern (no edges outside root) | **high** |
| Pattern member, partial survival (0 < edges_outside_root < template_length) | **medium** |
| Pattern member, full template survives outside root | **low** |

Rationale: severity reflects "irreplaceability" — how much unique evidence or connection this node provides.

## API Surface

### Service Function

```typescript
// platform/src/services/impact.ts

export interface ImpactNode {
  nodeType: 'fact' | 'entity' | 'causal_event' | 'causal_edge' | 'causal_pattern';
  nodeId: string;
  summary: string;              // human-readable label
  relationship: 'direct' | 'transitive' | 'citation' | 'pattern_member';
  depth: number;                // 0 = direct, 1+ = transitive
  severity: 'critical' | 'high' | 'medium' | 'low';
  reasoning: string;            // why this is affected
  strength?: number;            // for edges
  corroborationCount?: number;  // for edges
}

export interface BlastRadiusReport {
  root: { nodeType: string; nodeId: string; summary: string };
  hypothetical?: 'expire';
  directDependents: ImpactNode[];
  transitiveChains: ImpactNode[];
  citationDependents: ImpactNode[];
  patternImpact: ImpactNode[];
  severitySummary: { critical: number; high: number; medium: number; low: number };
  totalAffected: number;
  generatedAt: Date;
}

export async function analyzeImpact(params: {
  nodeType: 'fact' | 'entity' | 'causal_event';
  nodeId: string;
  maxDepth?: number;           // default 3
  hypothetical?: 'expire';
  includePatterns?: boolean;   // default true (requires Phase 6)
}): Promise<BlastRadiusReport>;
```

### MCP Tool

```typescript
{
  name: 'analyze_blast_radius',
  description: 'Given a fact, entity, or causal event, compute the full impact tree: dependents, transitive chains, citation links, and severity. Call this BEFORE expiring or invalidating anything to understand consequences.',
  inputSchema: {
    type: 'object',
    properties: {
      node_type: { enum: ['fact', 'entity', 'causal_event'] },
      node_id: { type: 'string', format: 'uuid' },
      max_depth: { type: 'number', minimum: 1, maximum: 10, default: 3 },
      hypothetical: { enum: ['expire'] },
    },
    required: ['node_type', 'node_id'],
  },
}
```

### HTTP Endpoint

```typescript
// platform/src/index.ts

app.get('/api/impact/:nodeType/:nodeId', async (c) => {
  const nodeType = c.req.param('nodeType') as 'fact' | 'entity' | 'causal_event';
  const nodeId = c.req.param('nodeId');
  const maxDepth = parseInt(c.req.query('depth') ?? '3', 10);
  const hypothetical = c.req.query('hypothetical') as any;
  const { analyzeImpact } = await import('./services/impact.js');
  const report = await analyzeImpact({ nodeType, nodeId, maxDepth, hypothetical });
  return c.json(report);
});
```

## Implementation Sketch

```typescript
// platform/src/services/impact.ts

export async function analyzeImpact(params: AnalyzeImpactParams): Promise<BlastRadiusReport> {
  const { nodeType, nodeId, maxDepth = 3, hypothetical, includePatterns = true } = params;

  const root = await loadRootNode(nodeType, nodeId);
  if (!root) throw new Error(`${nodeType} ${nodeId} not found`);

  const [directDependents, transitiveChains, citationDependents, patternImpact] = await Promise.all([
    findDirectDependents(nodeType, nodeId),
    findTransitiveChains(nodeType, nodeId, maxDepth),
    findCitationDependents(nodeType, nodeId),
    includePatterns ? findPatternImpact(nodeType, nodeId) : Promise.resolve([]),
  ]);

  const allNodes = [...directDependents, ...transitiveChains, ...citationDependents, ...patternImpact];
  scoreSeverity(allNodes, { rootCorroboration: root.corroborationCount });

  const severitySummary = tallySeverity(allNodes);

  return {
    root: { nodeType, nodeId, summary: root.summary },
    hypothetical,
    directDependents,
    transitiveChains,
    citationDependents,
    patternImpact,
    severitySummary,
    totalAffected: allNodes.length,
    generatedAt: new Date(),
  };
}
```

### Direct Dependents

For `nodeType = 'fact'`:
- Other facts sharing the same subject entity (lower specificity — only include if predicate also relevant)
- Facts where this fact's subject is the other's object (or vice versa)

For `nodeType = 'entity'`:
- All active facts where entity is subject or object

For `nodeType = 'causal_event'`:
- All active causal edges where this event is cause or effect

### Transitive Chains

Recursive CTE, following the existing pattern from `traceCauses()` and `projectTrajectory()`:

```sql
WITH RECURSIVE chain AS (
  -- Base: all edges touching the root event
  SELECT id, cause_event_id, effect_event_id, strength, 1 as depth
  FROM causal_edges
  WHERE (cause_event_id = $root_event_id OR effect_event_id = $root_event_id)
    AND expired_at IS NULL

  UNION ALL

  SELECT next_edge.id, next_edge.cause_event_id, next_edge.effect_event_id, next_edge.strength, chain.depth + 1
  FROM chain
  JOIN causal_edges next_edge ON (
    next_edge.cause_event_id = chain.effect_event_id OR
    next_edge.effect_event_id = chain.cause_event_id
  )
  WHERE next_edge.expired_at IS NULL
    AND chain.depth < $max_depth
)
SELECT DISTINCT * FROM chain ORDER BY depth;
```

### Citation Dependents

Uses Phase 3's `findEdgesCitingReference`:

```typescript
async function findCitationDependents(nodeType: string, nodeId: string): Promise<ImpactNode[]> {
  const refType = nodeType as 'fact' | 'entity' | 'memory';
  const edges = await findEdgesCitingReference(refType, nodeId);
  return edges.map(e => ({
    nodeType: 'causal_edge',
    nodeId: e.id,
    summary: `Edge: ${e.reasoning.slice(0, 80)}`,
    relationship: 'citation',
    depth: 0,
    severity: 'medium',  // overridden by scoreSeverity
    reasoning: `Cites ${nodeType} ${nodeId} as evidence`,
    strength: e.strength,
    corroborationCount: e.corroborationCount,
  }));
}
```

### Pattern Impact (conditional on Phase 6)

If patterns exist, find provisional/canonical patterns where this node participates:

```sql
SELECT DISTINCT p.*
FROM causal_patterns p
JOIN causal_edges e ON e.pattern_id = p.id
WHERE p.status IN ('provisional', 'canonical')
  AND (e.cause_event_id IN (<relevant events>) OR e.effect_event_id IN (<relevant events>))
```

## Hypothetical Mode

`hypothetical = 'expire'` does not mutate. It recalculates severity **as if** the root were expired:

- Citation dependents get their "sole source" status re-evaluated: if this root is the only citation, they'd be expired on cascade
- Direct causal edges touching this event get their "irreplaceable" status evaluated

This produces a "what would happen if..." report without changing state. Useful for UIs showing consequences before a user clicks "Confirm".

Only the `expire` mode is currently supported. `invalidate` and `weaken` were originally specified but never implemented — `invalidate` requires temporal-window citation semantics the data model doesn't carry, and `weaken` had no clear service-level semantic. They were removed from the API in Review #11 to keep the surface honest. Re-add deliberately if the citation model gains time bounds.

## Reasoning Agent Integration

```python
# ml-services/app/reasoning_agent.py — system prompt addition

> **Before Destructive Actions:** When you are about to call `expire_fact`,
> `invalidate_fact`, `expire_causal_edge`, or `resolve_contradiction` with a
> mutating resolution type, FIRST call
> `analyze_blast_radius(node_type=..., node_id=..., hypothetical='expire')`.
> Review the severity summary. If the report includes `critical` severity dependents,
> do NOT proceed without recording the justification in your reasoning. If there are
> `high` severity dependents, explain in your reasoning why the expiry is still
> correct despite the blast radius.
```

The prompt-side rule is a soft guideline. Independently of which actor invoked
the destructive path (reasoning agent, gardener, reconciliation agent, user-
initiated), the service layer captures the pre-mutation severity summary on
the audit row — see §"Audit Surface" below. Bead `nmemo-2yv.102` added the
service-side capture so the invariant is observable regardless of whether the
prompt-side rule fired.

## Audit Surface

The service layer persists the pre-mutation `severitySummary` to three audit
columns at the moment of the destructive action. Warn-only — never blocks the
mutation. The audit data exists to answer the operational question "did the
agent ever expire facts/edges with critical dependents?"; stronger gating
(reject-on-critical, override flags) is deferred until the observability
shows whether agents are systematically expiring critical-dependent state.

| Column | Populated by | Shape |
|---|---|---|
| `fact_history.pre_expire_blast_radius` | `expireFact` / `invalidateFact` | `SeveritySummary` (`{critical, high, medium, low}`) or NULL |
| `causal_edge_history.pre_expire_blast_radius` | `expireCausalEdge` | `SeveritySummary` or NULL |
| `contradictions.pre_resolve_blast_radius` | `resolveContradiction` (mutating types only) | `SeveritySummary`, or `{fact_a, fact_b}` for `expire_both`, or `{edge_a, edge_b}` for `expire_both_edges`, or NULL |

**NULL semantics.** The column is NULL when the mutation was not
agent-initiated:

- Cascade-internal mutations (e.g. `createFact` superseder path expiring the
  prior fact with `actor='cascade'`).
- Legacy rows written before migration 023.
- Non-mutating resolution types on `contradictions` (`reconcile`, `both_valid`,
  `dismissed`).

**Preflight.** Agent-initiated paths call `preflightBlastRadius` (a wrapper
over `analyzeImpact` with `hypothetical='expire'` and try/catch — the bead's
contract is non-blocking observability, so a preflight failure logs but never
blocks the mutation). For edge expiry the preflight roots at the edge's
`cause_event_id` — expiring an edge says "this causal claim is wrong" and the
cause is the most natural anchor for the blast-radius walk.

**Warning policy.** When `severitySummary.critical > 0` at preflight time,
the service emits a single structured `console.warn` line:

```
[blast-radius] critical-dependent expiry actor=<actor> root_type=<fact|causal_edge> root_id=<uuid> critical=N high=M medium=O low=P total_affected=T
```

No throw, no rejection, no override flag. The mutation proceeds.

## Observability

Every `analyzeImpact` invocation emits a structured `console.info` log line at
the tail of the orchestrator. F4 (audit columns + warn-on-critical) captures
the pre-mutation severity summary on destructive paths only; F7 covers the
residual general-purpose observability — every read of the impact graph,
regardless of whether a mutation follows. Bead `nmemo-2yv.105`.

```
[impact] actor=<actor> root_type=<fact|entity|causal_event> root_id=<uuid> depth=<N> hypo=<expire|none> critical=N high=M medium=O low=P total=T duration_ms=D
```

The `actor` field is supplied by the caller. Known callers:

- `http` — `/api/impact/:type/:id`
- `<agent-name>` — the MCP `analyze_blast_radius` tool (`gardener_agent`,
  `reconciliation_agent`, etc., via the `ToolCallContext.agent` field)
- `preflight` — `preflightBlastRadius` invocations from F4 destructive-path
  audit hooks (separable from direct HTTP / MCP calls so log grep can
  partition the two)
- `unknown` — fallback when the parameter is not threaded

On a thrown error the orchestrator emits a single `console.warn` line and
re-throws (HTTP layer turns the throw into a 404/500 per its existing error
shape):

```
[impact] error actor=<actor> root_type=<...> root_id=<uuid> message="<error message>"
```

Format chosen so log aggregators can grep on `[impact] ` and parse `key=value`
pairs without multi-line stitching. No PostgreSQL row is written per
invocation — impact is a stateless read query, and a DB row per read would
have the wrong cost shape (the viz alone could write hundreds of rows per
session). If aggregation becomes important later, ingest the log stream into
the observability stack.

## Viz Integration

`viz/js/panels/detail.js` — on clicking a fact edge, entity node, or causal-event node in the detail panel, show an "Impact" subpanel. All three root types are first-class: `showNodeDetail` mounts it for entity + causalEvent nodes; `showEdgeDetail` mounts it inside the `fact` edge branch. The subpanel itself lives in `viz/js/panels/impact.js` and is invoked through two helpers — `impactSectionMarkup(apiNodeType, nodeId)` for the placeholder markup, `triggerImpactFetch(apiNodeType, nodeId)` for the post-`innerHTML` async fetch. Causal edges are intentionally excluded — the service contract `RootNodeType = 'fact' | 'entity' | 'causal_event'` doesn't admit them (bead `nmemo-2yv.103`).

- Renders a tree: direct dependents on the left, transitive chains in the middle, citation dependents on the right, patterns at the bottom
- Severity colour-coded: critical = red, high = orange, medium = yellow, low = grey
- "Preview expire" button calls with `hypothetical=expire` and dims the affected nodes in the main graph

## Test Design

### Test File: `platform/src/test/harness/blast-radius.test.ts`

```typescript
describe('Phase 4 — Blast Radius Analysis', () => {
  beforeEach(async () => {
    await deleteFromTables(/* full clean */);
  });

  describe('direct dependents', () => {
    it('returns facts sharing the entity as subject', async () => {
      const entity = await createTestEntity();
      const fact1 = await createFact({ subjectEntityId: entity.id, predicate: 'works_at', ... });
      const fact2 = await createFact({ subjectEntityId: entity.id, predicate: 'lives_in', ... });
      const report = await analyzeImpact({ nodeType: 'entity', nodeId: entity.id });
      expect(report.directDependents.map(d => d.nodeId).sort())
        .toEqual([fact1, fact2].sort());
    });

    it('returns causal edges touching a causal_event', async () => {
      const { eventId, edgeIds } = await setupEventWithEdges({ edges: 3 });
      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: eventId });
      expect(report.directDependents.map(d => d.nodeId).sort()).toEqual(edgeIds.sort());
    });
  });

  describe('transitive chains', () => {
    it('walks causal chains up to maxDepth', async () => {
      // Build: E0 → E1 → E2 → E3 → E4
      const events = await setupChain(5);
      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: events[0], maxDepth: 3 });
      const depths = report.transitiveChains.map(t => t.depth);
      expect(Math.max(...depths)).toBeLessThanOrEqual(3);
    });

    it('respects maxDepth cap', async () => {
      const events = await setupChain(10);
      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: events[0], maxDepth: 2 });
      const depths = report.transitiveChains.map(t => t.depth);
      expect(Math.max(...depths)).toBeLessThanOrEqual(2);
    });

    it('includes both forward and backward walks', async () => {
      const events = await setupChain(5);  // E0 → E1 → E2 → E3 → E4
      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: events[2] });
      // Should see E1, E3 at depth 1
      const directNeighbours = report.transitiveChains.filter(t => t.depth === 1).map(t => t.nodeId);
      expect(directNeighbours).toContain(events[1]);
      expect(directNeighbours).toContain(events[3]);
    });
  });

  describe('citation dependents', () => {
    it('finds edges citing the fact as evidence', async () => {
      const factId = await setupFact();
      const edge1 = await setupEdgeCitingFact(factId);
      const edge2 = await setupEdgeCitingFact(factId);
      const report = await analyzeImpact({ nodeType: 'fact', nodeId: factId });
      expect(report.citationDependents.map(d => d.nodeId).sort()).toEqual([edge1, edge2].sort());
    });

    it('does not include expired edges', async () => {
      const factId = await setupFact();
      const edge1 = await setupEdgeCitingFact(factId);
      const edge2 = await setupEdgeCitingFact(factId);
      await expireCausalEdge({ edgeId: edge2, reasoning: 'test', actor: 'user' });
      const report = await analyzeImpact({ nodeType: 'fact', nodeId: factId });
      expect(report.citationDependents.map(d => d.nodeId)).toEqual([edge1]);
    });
  });

  describe('severity scoring', () => {
    it('scores critical when corroborated edge would lose sole evidence', async () => {
      const factId = await setupFact();
      const edgeId = await setupEdgeCitingFact(factId, { corroborationCount: 3, strength: 0.8 });
      // The edge has high corroboration but this fact is its sole citation
      const report = await analyzeImpact({ nodeType: 'fact', nodeId: factId, hypothetical: 'expire' });
      const edgeImpact = report.citationDependents.find(d => d.nodeId === edgeId);
      expect(edgeImpact?.severity).toBe('critical');
    });

    it('scores high for direct causal children with no other causes', async () => {
      const event = await setupEvent();
      const childEvent = await setupEvent();
      await setupEdge({ causeEventId: event, effectEventId: childEvent });
      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: event });
      const impact = report.transitiveChains.find(t => t.nodeId === childEvent);
      expect(impact?.severity).toBe('high');
    });

    it('scores low for depth-3 transitive chains', async () => {
      const events = await setupChain(5);
      const report = await analyzeImpact({ nodeType: 'causal_event', nodeId: events[0], maxDepth: 3 });
      const depth3 = report.transitiveChains.find(t => t.depth === 3);
      expect(depth3?.severity).toBe('low');
    });

    it('severity summary counts match node severities', async () => {
      const report = await generateComplexScenario();
      const allNodes = [...report.directDependents, ...report.transitiveChains, ...report.citationDependents, ...report.patternImpact];
      const counted = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const n of allNodes) counted[n.severity]++;
      expect(report.severitySummary).toEqual(counted);
    });
  });

  describe('hypothetical mode', () => {
    it('hypothetical=expire simulates without mutating', async () => {
      const factId = await setupFact();
      const edgeId = await setupEdgeCitingFact(factId, { corroborationCount: 1 });
      const report = await analyzeImpact({ nodeType: 'fact', nodeId: factId, hypothetical: 'expire' });

      // Verify no actual state change
      const fact = await getFact(factId);
      expect(fact.expiredAt).toBeNull();
      const edge = await getEdge(edgeId);
      expect(edge.expiredAt).toBeNull();

      // But severity reflects the what-if: sole citation → critical
      expect(report.severitySummary.critical).toBeGreaterThan(0);
    });

    it('without hypothetical, severity reflects current state', async () => {
      const factId = await setupFact();
      const edgeId = await setupEdgeCitingFact(factId, { corroborationCount: 1 });
      const report = await analyzeImpact({ nodeType: 'fact', nodeId: factId });
      // Without hypothetical, this is a citation with normal severity
      expect(report.severitySummary.critical).toBe(0);
    });
  });

  describe('isolated nodes', () => {
    it('returns empty arrays when node has no dependents', async () => {
      const entity = await createTestEntity();  // no facts, no events
      const report = await analyzeImpact({ nodeType: 'entity', nodeId: entity.id });
      expect(report.directDependents).toEqual([]);
      expect(report.transitiveChains).toEqual([]);
      expect(report.citationDependents).toEqual([]);
      expect(report.totalAffected).toBe(0);
    });
  });

  describe('performance', () => {
    it('completes in under 500ms on a graph with 1000 edges', async () => {
      await generateGraph({ entities: 100, facts: 500, events: 500, edges: 1000 });
      const someFactId = await pickRandomFact();
      const t0 = Date.now();
      await analyzeImpact({ nodeType: 'fact', nodeId: someFactId, maxDepth: 3 });
      expect(Date.now() - t0).toBeLessThan(500);
    });
  });

  describe('MCP tool', () => {
    it('analyze_blast_radius returns structured JSON via handler', async () => {
      const factId = await setupFact();
      const result = await handleToolCall('analyze_blast_radius', { node_type: 'fact', node_id: factId }, { agent: 'reasoning_agent' });
      expect(result).toHaveProperty('severitySummary');
      expect(result).toHaveProperty('totalAffected');
    });
  });

  describe('HTTP endpoint', () => {
    it('GET /api/impact/:type/:id returns report', async () => {
      const factId = await setupFact();
      const response = await fetch(`http://localhost:3001/api/impact/fact/${factId}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('root');
      expect(body.root.nodeId).toBe(factId);
    });

    it('GET /api/impact supports depth and hypothetical query params', async () => {
      const factId = await setupFact();
      const response = await fetch(`http://localhost:3001/api/impact/fact/${factId}?depth=5&hypothetical=expire`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hypothetical).toBe('expire');
    });
  });
});
```

### Coverage Targets

- [ ] Direct dependents for each node type
- [ ] Transitive chains forward and backward
- [ ] maxDepth respected
- [ ] Citation dependents via edge_source_refs
- [ ] Expired edges excluded from citation results
- [ ] All five severity rules
- [ ] Severity summary totals match per-node severities
- [ ] hypothetical=expire simulates without mutating
- [ ] Isolated nodes return empty report
- [ ] Performance < 500ms at 1000-edge scale
- [ ] MCP tool callable
- [ ] HTTP endpoint returns structured response
- [ ] Query params (depth, hypothetical) handled

## Test Data Requirements

See [doc 18 — Test Data Hardening Protocol](18-test-data-hardening-protocol.md).

### Fixture Inventory

```
platform/src/test/data/phase4-blastradius/
├── fixtures/
│   ├── small-graph-5-nodes.sql             # L1 — deterministic topology, all relationships known
│   ├── linear-chain-depth-10.sql           # L1 — transitive walk test
│   ├── diamond-topology.sql                # L1 — multi-path convergent
│   ├── cycle-topology.sql                  # L1 edge — causal cycle
│   ├── orphan-node.sql                     # L1 edge — isolated entity
│   ├── fan-out-explosion.sql               # adversarial — 1 fact cited by 500 edges
│   ├── deep-cycle-depth-20.sql             # adversarial — stress for maxDepth cap
│   ├── realistic-500-entity.sql            # L2 — mixed topology at moderate scale
│   └── misra-chapter-impact.sql            # L3 — MISRA subset for hypothetical expire
├── expected/
│   ├── small-graph-5-nodes.expected.json   # complete impact tree per node
│   └── (per-fixture)
└── benchmark-reports/
```

### Benchmark Metrics

| Metric | Target |
|--------|--------|
| `analyzeImpact` (1000-edge graph, depth 3) | <500ms |
| Severity scoring correctness | 100% (vs expected JSON) |
| Hypothetical mode — zero state mutation | 100% |
| maxDepth respected | 100% |
| No double-counting of nodes reachable via multiple paths | 100% |
| Citation dependents correctness | 100% (via Phase 3 index) |

### Adversarial

- **Fan-out explosion**: fact cited by 500 edges. Hypothetical expire. Assert response time stays sub-second.
- **Deep cycle**: forms A→B→C→A at depth 3. Assert maxDepth terminates without infinite loop.
- **Severity rule gaming**: build graph where every node scores critical. Assert severity summary reflects that accurately, doesn't cap.
- **Hypothetical chain attack**: run hypothetical=expire repeatedly on same fact in parallel. Assert zero mutations across all runs.

### Graduation

Level 1 → Level 2 when all topology fixtures pass, performance target met at 1000 edges.
Level 2 → Level 3 when MISRA-chapter fixture produces sensible impact for real rule dependencies.

## Acceptance Criteria

Phase 4 is complete when:

- [ ] `analyzeImpact()` returns `BlastRadiusReport` for facts, entities, causal_events
- [ ] MCP tool `analyze_blast_radius` registered and callable
- [ ] `GET /api/impact/:type/:id` returns structured JSON
- [ ] Severity scoring matches specification
- [ ] Hypothetical mode does not mutate state
- [ ] Reasoning agent prompt instructs use before destructive actions
- [ ] Viz integration shows impact subpanel
- [ ] All tests pass

## File Inventory

### New
- `platform/src/services/impact.ts`
- `platform/src/test/harness/blast-radius.test.ts`

### Modified
- `platform/src/services/causal-agent.ts` — register `analyze_blast_radius` tool
- `platform/src/index.ts` — `/api/impact/:type/:id` endpoint
- `platform/viz/js/app.js` — impact subpanel rendering
- `platform/viz/index.html` — panel container
- `ml-services/app/reasoning_agent.py` — prompt guidance for pre-action analysis

## Beads Issues

Parent: **nmemo-437** (Phase 4)

- **nmemo-437.1** — [service] impact.ts skeleton + direct dependents
- **nmemo-437.2** — [service] Transitive chains via recursive CTE
- **nmemo-437.3** — [service] Citation dependents via edge_source_refs (depends on nmemo-d1r.4)
- **nmemo-437.4** — [service] Severity scoring rules
- **nmemo-437.5** — [service] Hypothetical mode (expire/invalidate/weaken)
- **nmemo-437.6** — [mcp] analyze_blast_radius MCP tool
- **nmemo-437.7** — [api] GET /api/impact/:type/:id endpoint
- **nmemo-437.8** — [prompt] Reasoning agent pre-action blast radius
- **nmemo-437.9** — [viz] Impact subpanel UI
- **nmemo-437.10** — [test] blast-radius.test.ts passing

`bd show nmemo-437` for full tree.
