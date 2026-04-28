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
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import {
  facts,
  entities,
  causalEvents,
  causalEdges,
} from '../db/schema.js';

// ============================================
// Types
// ============================================

export type ImpactNodeType = 'fact' | 'entity' | 'causal_event' | 'causal_edge';
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
  scoreSeverity(allNodes, {
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

/** C2: bidirectional recursive CTE walk through `causal_edges`. */
async function findTransitiveChains(
  _rootEventIds: string[],
  _maxDepth: number,
): Promise<ImpactNode[]> {
  return [];
}

/** C2: dispatch to `findEdgesCitingReference` from Phase 3. */
async function findCitationDependents(
  _nodeType: RootNodeType,
  _nodeId: string,
): Promise<ImpactNode[]> {
  return [];
}

/** C3: JOIN through `causal_edges.pattern_id` to find provisional/canonical patterns. */
async function findPatternImpact(_rootEventIds: string[]): Promise<ImpactNode[]> {
  // Phase 6 hasn't shipped pattern detection yet; the schema column exists
  // (causal_edges.pattern_id at db/schema.ts:296) so the query is safe — it
  // simply returns [] until Phase 6 populates rows.
  return [];
}

/** C3: 9-rule severity table (doc 15). First match wins. */
function scoreSeverity(
  nodes: ImpactNode[],
  _ctx: { rootCorroboration?: number; hypothetical?: HypotheticalAction },
): void {
  // Stub: leave the per-node default (`medium`) until C3 wires the rules.
  // Reads `nodes` to silence the unused-param linter once the body lands.
  void nodes;
}

function tallySeverity(nodes: ImpactNode[]): BlastRadiusReport['severitySummary'] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const n of nodes) {
    counts[n.severity]++;
  }
  return counts;
}

// Used by raw-SQL CTE helpers in C2; kept local to avoid an unused import warning
// when the body still stubs out.
void sql;
