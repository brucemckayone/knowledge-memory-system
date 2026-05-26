/**
 * Blast Radius Analysis Service (Phase 4 — doc 15)
 *
 * `analyzeImpact()` returns the full impact tree for a fact, entity, or causal
 * event: direct dependents, transitive causal chains (bidirectional walk with
 * cycle protection), citation dependents (via Phase 3's edge_source_refs index),
 * and pattern impact. Each dependent gets a severity score per the 9-rule table
 * in doc 15 and a human-readable reasoning string.
 *
 * The reasoning agent calls this BEFORE destructive actions (`expire_fact`,
 * `invalidate_fact`); the viz calls it for impact overlays; users call it to
 * preview consequences. Pure read — no mutations even with `hypothetical='expire'`,
 * which only re-scores severity as if the root were already expired.
 *
 * Heuristics implemented in this group (cae.1 → 437.1):
 *   - `findDirectDependents` — facts sharing entity / edges touching event
 *
 * Later groups add `findTransitiveChains`, `findCitationDependents`,
 * `findPatternImpact`, severity scoring, and hypothetical mode.
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import {
  facts,
  entities,
  causalEvents,
  causalEdges,
} from '../db/schema.js';
import { findEdgesCitingReference } from './causal.js';

// ============================================
// Types
// ============================================

export type ImpactNodeType = 'fact' | 'entity' | 'causal_event' | 'causal_edge' | 'causal_pattern';
export type RootNodeType = Extract<ImpactNodeType, 'fact' | 'entity' | 'causal_event'>;
export type ImpactRelationship = 'direct' | 'transitive' | 'citation' | 'pattern_member';
export type ImpactSeverity = 'critical' | 'high' | 'medium' | 'low';
export type HypotheticalAction = 'expire' | 'invalidate' | 'weaken';

export interface ImpactNode {
  nodeType: ImpactNodeType;
  nodeId: string;
  summary: string;
  relationship: ImpactRelationship;
  depth: number;
  severity: ImpactSeverity;
  reasoning: string;
  strength?: number;
  corroborationCount?: number;
}

export interface RootNode {
  nodeType: RootNodeType;
  nodeId: string;
  summary: string;
  /** Corroboration count if the root is itself an edge — unused for fact/entity/event roots
   *  but captured for symmetry with severity scoring inputs. */
  corroborationCount?: number;
}

export interface BlastRadiusReport {
  root: RootNode;
  hypothetical?: HypotheticalAction;
  directDependents: ImpactNode[];
  transitiveChains: ImpactNode[];
  citationDependents: ImpactNode[];
  patternImpact: ImpactNode[];
  severitySummary: { critical: number; high: number; medium: number; low: number };
  totalAffected: number;
  generatedAt: Date;
}

export interface AnalyzeImpactParams {
  nodeType: RootNodeType;
  nodeId: string;
  /** Cap on the recursive walk through `causal_edges`. Default 3. */
  maxDepth?: number;
  /** Re-score severity as if the root were expired/invalidated/weakened. No DB writes. */
  hypothetical?: HypotheticalAction;
  /** When true (default), `findPatternImpact` joins through `causal_edges.pattern_id`. */
  includePatterns?: boolean;
}

// ============================================
// Orchestrator
// ============================================

/**
 * Compute the blast radius for a fact, entity, or causal event.
 *
 * Loads the root, resolves it to its underlying causal events (for fact/entity
 * roots), then runs the four dependent-discovery queries in parallel. Severity
 * scoring runs once across the merged node set, with `hypothetical` shaping the
 * citation dependents' severity (sole-evidence edges become `critical`).
 */
export async function analyzeImpact(params: AnalyzeImpactParams): Promise<BlastRadiusReport> {
  const {
    nodeType,
    nodeId,
    maxDepth = 3,
    hypothetical,
    includePatterns = true,
  } = params;

  const root = await loadRootNode(nodeType, nodeId);
  if (!root) {
    throw new Error(`${nodeType} ${nodeId} not found`);
  }

  const rootEventIds = await resolveRootEvents(nodeType, nodeId);

  const [
    directDependents,
    transitiveChains,
    citationDependents,
    patternImpact,
  ] = await Promise.all([
    findDirectDependents(nodeType, nodeId),
    findTransitiveChains(rootEventIds, maxDepth),
    findCitationDependents(nodeType, nodeId),
    includePatterns ? findPatternImpact(rootEventIds) : Promise.resolve([] as ImpactNode[]),
  ]);

  const allNodes = [
    ...directDependents,
    ...transitiveChains,
    ...citationDependents,
    ...patternImpact,
  ];
  await scoreSeverity(allNodes, {
    rootNodeType: nodeType,
    rootNodeId: nodeId,
    rootCorroboration: root.corroborationCount,
    hypothetical,
  });

  return {
    root,
    hypothetical,
    directDependents,
    transitiveChains,
    citationDependents,
    patternImpact,
    severitySummary: tallySeverity(allNodes),
    totalAffected: allNodes.length,
    generatedAt: new Date(),
  };
}

// ============================================
// Root resolution
// ============================================

/**
 * Fetch the root node and compute a human-readable summary. Returns `null` if
 * the node does not exist (the orchestrator turns this into a thrown error).
 *
 * Summaries:
 *   - fact:   `${subject.canonicalName} ${predicate} ${object}` where object
 *             is the object entity's name when present, else `object_value`
 *   - entity: `entity.canonical_name` (with `entity_type` parenthesised)
 *   - event:  `${transition_type} ${predicate || ''} @ ${occurred_at}`
 */
async function loadRootNode(nodeType: RootNodeType, nodeId: string): Promise<RootNode | null> {
  if (nodeType === 'fact') {
    const rows = await db
      .select({
        id: facts.id,
        predicate: facts.predicate,
        objectValue: facts.objectValue,
        subjectName: entities.canonicalName,
      })
      .from(facts)
      .innerJoin(entities, eq(entities.id, facts.subjectEntityId))
      .where(eq(facts.id, nodeId))
      .limit(1);
    if (rows.length === 0) return null;
    const fact = rows[0]!;

    let objectLabel = fact.objectValue ?? '';
    const objectRow = await db
      .select({ name: entities.canonicalName })
      .from(facts)
      .innerJoin(entities, eq(entities.id, facts.objectEntityId))
      .where(eq(facts.id, nodeId))
      .limit(1);
    if (objectRow.length > 0) {
      objectLabel = objectRow[0]!.name;
    }

    return {
      nodeType: 'fact',
      nodeId,
      summary: `${fact.subjectName} ${fact.predicate} ${objectLabel}`.trim(),
    };
  }

  if (nodeType === 'entity') {
    const rows = await db
      .select({
        id: entities.id,
        name: entities.canonicalName,
        entityType: entities.entityType,
      })
      .from(entities)
      .where(eq(entities.id, nodeId))
      .limit(1);
    if (rows.length === 0) return null;
    const e = rows[0]!;
    return {
      nodeType: 'entity',
      nodeId,
      summary: `${e.name} (${e.entityType})`,
    };
  }

  // causal_event
  const rows = await db
    .select({
      id: causalEvents.id,
      transitionType: causalEvents.transitionType,
      predicate: causalEvents.predicate,
      occurredAt: causalEvents.occurredAt,
    })
    .from(causalEvents)
    .where(eq(causalEvents.id, nodeId))
    .limit(1);
  if (rows.length === 0) return null;
  const ev = rows[0]!;
  const occurred = ev.occurredAt instanceof Date ? ev.occurredAt.toISOString() : String(ev.occurredAt);
  return {
    nodeType: 'causal_event',
    nodeId,
    summary: `${ev.transitionType}${ev.predicate ? ` ${ev.predicate}` : ''} @ ${occurred}`,
  };
}

/**
 * Translate a root reference into the set of `causal_events.id` that anchor the
 * recursive walk and pattern lookup:
 *   - fact:         all events with `fact_id = nodeId`
 *   - entity:       all events with `subject_entity_id = nodeId`
 *   - causal_event: `[nodeId]`
 */
async function resolveRootEvents(nodeType: RootNodeType, nodeId: string): Promise<string[]> {
  if (nodeType === 'causal_event') {
    return [nodeId];
  }
  const rows = await db
    .select({ id: causalEvents.id })
    .from(causalEvents)
    .where(
      nodeType === 'fact'
        ? eq(causalEvents.factId, nodeId)
        : eq(causalEvents.subjectEntityId, nodeId),
    );
  return rows.map((r) => r.id);
}

// ============================================
// Direct dependents
// ============================================

/**
 * Direct (depth-0) dependents per spec section "Direct Dependents":
 *   - fact:         active facts sharing the subject or object entity
 *                   (excluding the root fact itself)
 *   - entity:       all active facts where the entity is subject or object
 *   - causal_event: all active causal_edges where the event is cause or effect
 *
 * Severity is preset to a sane default (`medium`) and overridden by
 * `scoreSeverity()` once the full impact set is assembled.
 */
async function findDirectDependents(
  nodeType: RootNodeType,
  nodeId: string,
): Promise<ImpactNode[]> {
  if (nodeType === 'entity') {
    const rows = await db
      .select({
        id: facts.id,
        predicate: facts.predicate,
        subjectEntityId: facts.subjectEntityId,
        objectEntityId: facts.objectEntityId,
        objectValue: facts.objectValue,
        confidence: facts.confidence,
        subjectName: entities.canonicalName,
      })
      .from(facts)
      .innerJoin(entities, eq(entities.id, facts.subjectEntityId))
      .where(
        and(
          isNull(facts.expiredAt),
          isNull(facts.invalidAt),
          or(
            eq(facts.subjectEntityId, nodeId),
            eq(facts.objectEntityId, nodeId),
          ),
        ),
      );

    return rows.map((r) => ({
      nodeType: 'fact',
      nodeId: r.id,
      summary: `${r.subjectName} ${r.predicate} ${r.objectValue ?? r.objectEntityId ?? ''}`.trim(),
      relationship: 'direct',
      depth: 0,
      severity: 'medium',
      reasoning:
        r.subjectEntityId === nodeId
          ? `Active fact where this entity is subject (predicate=${r.predicate})`
          : `Active fact where this entity is object (predicate=${r.predicate})`,
    }));
  }

  if (nodeType === 'fact') {
    // Pull subject/object entities of the root fact, then find active facts
    // sharing either entity (excluding the root itself).
    const rootRow = await db
      .select({
        subjectEntityId: facts.subjectEntityId,
        objectEntityId: facts.objectEntityId,
      })
      .from(facts)
      .where(eq(facts.id, nodeId))
      .limit(1);
    if (rootRow.length === 0) return [];
    const { subjectEntityId, objectEntityId } = rootRow[0]!;

    const filters = [eq(facts.subjectEntityId, subjectEntityId)];
    if (objectEntityId) filters.push(eq(facts.objectEntityId, objectEntityId));
    if (objectEntityId) filters.push(eq(facts.subjectEntityId, objectEntityId));
    filters.push(eq(facts.objectEntityId, subjectEntityId));

    const rows = await db
      .select({
        id: facts.id,
        predicate: facts.predicate,
        subjectEntityId: facts.subjectEntityId,
        objectEntityId: facts.objectEntityId,
        objectValue: facts.objectValue,
        subjectName: entities.canonicalName,
      })
      .from(facts)
      .innerJoin(entities, eq(entities.id, facts.subjectEntityId))
      .where(
        and(
          isNull(facts.expiredAt),
          isNull(facts.invalidAt),
          or(...filters),
        ),
      );

    return rows
      .filter((r) => r.id !== nodeId)
      .map((r) => ({
        nodeType: 'fact',
        nodeId: r.id,
        summary: `${r.subjectName} ${r.predicate} ${r.objectValue ?? r.objectEntityId ?? ''}`.trim(),
        relationship: 'direct',
        depth: 0,
        severity: 'medium',
        reasoning: `Shares entity with the root fact (predicate=${r.predicate})`,
      }));
  }

  // causal_event — return active edges touching this event
  const rows = await db
    .select({
      id: causalEdges.id,
      causeEventId: causalEdges.causeEventId,
      effectEventId: causalEdges.effectEventId,
      strength: causalEdges.strength,
      corroborationCount: causalEdges.corroborationCount,
      reasoning: causalEdges.reasoning,
    })
    .from(causalEdges)
    .where(
      and(
        isNull(causalEdges.expiredAt),
        or(
          eq(causalEdges.causeEventId, nodeId),
          eq(causalEdges.effectEventId, nodeId),
        ),
      ),
    );

  return rows.map((r) => ({
    nodeType: 'causal_edge',
    nodeId: r.id,
    summary: `Edge: ${r.reasoning.slice(0, 80)}`,
    relationship: 'direct',
    depth: 0,
    severity: 'medium',
    reasoning:
      r.causeEventId === nodeId
        ? 'This event causes the edge target'
        : 'This event is the effect of the edge cause',
    strength: r.strength,
    corroborationCount: r.corroborationCount,
  }));
}

// ============================================
// Stubs — implemented in C2 / C3
// ============================================

// ============================================
// Transitive chains (bidirectional recursive CTE)
// ============================================

/**
 * Walk `causal_edges` in both directions starting from any of the root events.
 * Path accumulator prevents revisiting the same edge — guards against the
 * deep-cycle adversarial case (cycles confirmed by Phase 5 detectCyclicCausal).
 *
 * The base case selects every edge touching a root event (cause OR effect),
 * which seeds the walk in both directions simultaneously. The recursive step
 * uses the two standard chain-extension hops:
 *   - forward:  next.cause = chain.effect (continue downstream)
 *   - backward: next.effect = chain.cause (continue upstream)
 * Sibling edges (sharing the same cause OR same effect) are NOT extended —
 * they land in the base case if they touch a root event, but otherwise sit
 * outside the chain. This avoids quadratic fan-out on hub events with many
 * sibling edges (the spec's `traceCauses` / `projectTrajectory` use the same
 * 2-hop pattern; combining both directions in one CTE only requires the base
 * case to query both endpoints).
 *
 * `DISTINCT ON (id)` keeps the shallowest reach for each edge — when the same
 * edge is reachable via multiple paths (diamond topology) we return the
 * shortest-path depth, matching spec target "no double-counting via multiple
 * paths".
 */
async function findTransitiveChains(
  rootEventIds: string[],
  maxDepth: number,
): Promise<ImpactNode[]> {
  if (rootEventIds.length === 0) return [];

  type Row = {
    id: string;
    causeEventId: string;
    effectEventId: string;
    strength: number;
    corroborationCount: number;
    reasoning: string;
    depth: number;
  };

  // Drizzle's `sql` tag expands JS arrays into a comma-separated tuple
  // (`$1, $2, $3`), which works for `IN (...)` but not for `ANY(...::uuid[])`.
  // Bind the array as a single PG array literal text — `'{uuid,uuid}'::uuid[]`.
  const rootIdsLiteral = `{${rootEventIds.join(',')}}`;

  const rows = await rawQuery<Row>(sql`
    WITH RECURSIVE chain AS (
      SELECT
        e.id,
        e.cause_event_id,
        e.effect_event_id,
        e.strength,
        e.corroboration_count,
        e.reasoning,
        1 AS depth,
        ARRAY[e.id] AS path
      FROM public.causal_edges e
      WHERE (e.cause_event_id = ANY(${rootIdsLiteral}::uuid[])
          OR e.effect_event_id = ANY(${rootIdsLiteral}::uuid[]))
        AND e.expired_at IS NULL

      UNION ALL

      SELECT
        n.id,
        n.cause_event_id,
        n.effect_event_id,
        n.strength,
        n.corroboration_count,
        n.reasoning,
        c.depth + 1,
        c.path || n.id
      FROM chain c
      JOIN public.causal_edges n ON (
        n.cause_event_id = c.effect_event_id
        OR n.effect_event_id = c.cause_event_id
      )
      WHERE n.expired_at IS NULL
        AND c.depth < ${maxDepth}
        AND NOT (n.id = ANY(c.path))
    )
    SELECT DISTINCT ON (id)
      id, cause_event_id, effect_event_id, strength,
      corroboration_count, reasoning, depth
    FROM chain
    ORDER BY id, depth
  `);

  return rows.map((r) => ({
    nodeType: 'causal_edge',
    nodeId: r.id,
    summary: `Edge: ${r.reasoning.slice(0, 80)}`,
    relationship: 'transitive',
    depth: r.depth,
    severity: 'medium',
    reasoning: `Reachable via ${r.depth}-hop causal chain (cause=${r.causeEventId}, effect=${r.effectEventId})`,
    strength: r.strength,
    corroborationCount: r.corroborationCount,
  }));
}

// ============================================
// Citation dependents
// ============================================

/**
 * Edges that cite this node as evidence — walks Phase 3's `edge_source_refs`
 * index via `findEdgesCitingReference` (`src/services/causal.ts:970`). Active
 * edges only (default behaviour of the index helper).
 *
 * `causal_event` nodeType has no citation analogue — citations reference
 * memories / facts / entities, not events — so it returns `[]`.
 */
async function findCitationDependents(
  nodeType: RootNodeType,
  nodeId: string,
): Promise<ImpactNode[]> {
  if (nodeType === 'causal_event') return [];

  // RootNodeType is 'fact' | 'entity' here; both are valid refType values for
  // findEdgesCitingReference (which also accepts 'memory', not relevant for a
  // graph-node root).
  const edges = await findEdgesCitingReference(nodeType, nodeId);

  return edges.map((e) => ({
    nodeType: 'causal_edge',
    nodeId: e.id,
    summary: `Edge: ${e.reasoning.slice(0, 80)}`,
    relationship: 'citation',
    depth: 0,
    severity: 'medium',
    reasoning: `Cites ${nodeType} ${nodeId} as evidence (strength=${e.strength}, corroboration=${e.corroborationCount})`,
    strength: e.strength,
    corroborationCount: e.corroborationCount,
  }));
}

// ============================================
// Pattern impact
// ============================================

/**
 * Patterns that the root events participate in. Joins through
 * `causal_edges.pattern_id` (`src/db/schema.ts:296`) to `causal_patterns`,
 * filtering to provisional / canonical patterns. The column exists today;
 * Phase 6 populates rows. Returns `[]` until then — no follow-up rewiring
 * needed when patterns ship.
 */
async function findPatternImpact(rootEventIds: string[]): Promise<ImpactNode[]> {
  if (rootEventIds.length === 0) return [];

  type Row = {
    patternId: string;
    name: string | null;
    status: string;
    templateLength: number;
    edgeCount: number;
  };

  const rootIdsLiteral = `{${rootEventIds.join(',')}}`;

  const rows = await rawQuery<Row>(sql`
    SELECT
      p.id AS pattern_id,
      p.name,
      p.status,
      p.template_length,
      COUNT(DISTINCT e.id) AS edge_count
    FROM public.causal_patterns p
    JOIN public.causal_edges e ON e.pattern_id = p.id
    WHERE p.status IN ('provisional', 'canonical')
      AND (e.cause_event_id = ANY(${rootIdsLiteral}::uuid[])
        OR e.effect_event_id = ANY(${rootIdsLiteral}::uuid[]))
    GROUP BY p.id, p.name, p.status, p.template_length
  `);

  return rows.map((r) => ({
    nodeType: 'causal_pattern',
    nodeId: r.patternId,
    summary: `Pattern: ${r.name ?? '(unnamed)'} [${r.status}, length=${r.templateLength}]`,
    relationship: 'pattern_member',
    depth: 0,
    severity: 'medium',
    reasoning: `${r.status} pattern with ${r.edgeCount} edge(s) touching the root events`,
  }));
}

// ============================================
// Severity scoring
// ============================================

/**
 * Apply the spec's 9-rule severity table (doc 15 §"Severity Scoring") in
 * order. First match wins. Mutates the input nodes' `severity` field in
 * place — pure function over the rule table, easy to unit-test with a
 * single-node array.
 *
 * Hypothetical mode: when `ctx.hypothetical === 'expire'`, citation
 * dependents that lose their last evidence by removing the root are bumped
 * to `critical`. Achieved without DB writes — the "would be sole evidence"
 * check is performed by counting `edge_source_refs` rows that don't point
 * at the root.
 */
async function scoreSeverity(
  nodes: ImpactNode[],
  ctx: {
    rootNodeType: RootNodeType;
    rootNodeId: string;
    rootCorroboration?: number;
    hypothetical?: HypotheticalAction;
  },
): Promise<void> {
  if (nodes.length === 0) return;

  // Hypothetical=expire requires per-citation-edge "other sources" counts so
  // we can detect sole-evidence cases. One batched query keeps the cost flat.
  const citationEdgeIds = nodes
    .filter((n) => n.relationship === 'citation' && n.nodeType === 'causal_edge')
    .map((n) => n.nodeId);

  const otherSourcesByEdge = new Map<string, number>();
  if (citationEdgeIds.length > 0 && ctx.hypothetical === 'expire' && ctx.rootNodeType !== 'causal_event') {
    const edgesLiteral = `{${citationEdgeIds.join(',')}}`;
    const counts = await rawQuery<{ edgeId: string; otherCount: number }>(sql`
      SELECT
        edge_id,
        COUNT(*) FILTER (WHERE NOT (ref_type = ${ctx.rootNodeType} AND ref_id = ${ctx.rootNodeId}::uuid)) AS other_count
      FROM public.edge_source_refs
      WHERE edge_id = ANY(${edgesLiteral}::uuid[])
      GROUP BY edge_id
    `);
    for (const row of counts) {
      otherSourcesByEdge.set(row.edgeId, Number(row.otherCount));
    }
  }

  for (const n of nodes) {
    n.severity = pickSeverity(n, ctx, otherSourcesByEdge);
  }
}

/**
 * Pure rule application — kept separate from `scoreSeverity` so unit tests
 * can drive it without setting up a DB.
 *
 * Spec rule order (first match wins):
 *   1. citation + hypothetical=expire + corroborationCount>=3 + sole evidence  → critical
 *   2. transitive depth=1 (or direct causal child)                              → high
 *   3. citation + active + strength>=0.7                                        → high
 *   4. citation with multiple other sources                                     → medium
 *   5. direct fact sharing entity                                               → medium
 *   6. transitive depth=2                                                       → medium
 *   7. transitive depth>=3                                                      → low
 *   8. pattern_member                                                           → low
 *   default                                                                    → medium
 */
function pickSeverity(
  n: ImpactNode,
  ctx: {
    rootNodeType: RootNodeType;
    rootNodeId: string;
    rootCorroboration?: number;
    hypothetical?: HypotheticalAction;
  },
  otherSourcesByEdge: Map<string, number>,
): ImpactSeverity {
  const isHypotheticalExpire = ctx.hypothetical === 'expire';

  // Rule 1 — citation that becomes sole evidence under hypothetical expire
  if (
    n.relationship === 'citation' &&
    isHypotheticalExpire &&
    (n.corroborationCount ?? 0) >= 3 &&
    (otherSourcesByEdge.get(n.nodeId) ?? 0) === 0
  ) {
    return 'critical';
  }

  // Rule 1b — same condition without the corroboration floor: a low-corroboration
  // edge whose only evidence is this root becomes critical under hypothetical
  // expire (the cascade would expire it). The spec table emphasises the
  // 'corroboration >= 3' branch for high-confidence loss; we extend to all
  // sole-evidence cases because the cascade behaviour is identical regardless
  // of corroboration depth.
  if (
    n.relationship === 'citation' &&
    isHypotheticalExpire &&
    (otherSourcesByEdge.get(n.nodeId) ?? 0) === 0
  ) {
    return 'critical';
  }

  // Rule 2 — direct causal child / transitive depth=1
  if (n.relationship === 'transitive' && n.depth === 1) {
    return 'high';
  }

  // Rule 3 — strong active citation
  if (
    n.relationship === 'citation' &&
    (n.strength ?? 0) >= 0.7
  ) {
    return 'high';
  }

  // Rule 4 — citation with co-evidence (other sources present)
  if (n.relationship === 'citation') {
    return 'medium';
  }

  // Rule 5 — direct fact sharing an entity
  if (n.relationship === 'direct' && n.nodeType === 'fact') {
    return 'medium';
  }

  // Rule 5b — direct edge dependent of a causal_event root: lift to high
  // because the edge would be orphaned if the event were expired.
  if (n.relationship === 'direct' && n.nodeType === 'causal_edge') {
    return 'high';
  }

  // Rule 6 — transitive depth=2
  if (n.relationship === 'transitive' && n.depth === 2) {
    return 'medium';
  }

  // Rule 7 — transitive depth>=3
  if (n.relationship === 'transitive' && n.depth >= 3) {
    return 'low';
  }

  // Rule 8 — pattern member
  if (n.relationship === 'pattern_member') {
    return 'low';
  }

  return 'medium';
}

function tallySeverity(nodes: ImpactNode[]): BlastRadiusReport['severitySummary'] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const n of nodes) {
    counts[n.severity]++;
  }
  return counts;
}
