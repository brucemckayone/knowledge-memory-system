/**
 * Canonical Graph — DB fetch.
 *
 * Thin I/O wrapper: reads the live graph (active facts/edges only, mirroring
 * `/api/viz/unified`) and feeds raw rows into the pure {@link buildCanonicalGraph}.
 * Kept separate from `graph-canonical.ts` so the keying/diff logic stays
 * unit-testable without a DB. Integration-tested only at benchmark time.
 */

import { eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  entities,
  entityMeta,
  facts,
  causalEvents,
  causalEdges,
  sameAsLinks,
  contradictions,
  extractionReports,
  gardeningReports,
  reasoningReports,
} from '../db/schema.js';
import { buildCanonicalGraph, type CanonicalGraph } from './graph-canonical.js';

export async function exportCanonicalGraph(): Promise<CanonicalGraph> {
  const [ents, fcts, events, edges, sameAs] = await Promise.all([
    db.select({ id: entities.id, name: entities.canonicalName, type: entities.entityType }).from(entities),
    db
      .select({
        id: facts.id,
        subj: facts.subjectEntityId,
        pred: facts.predicate,
        objId: facts.objectEntityId,
        objVal: facts.objectValue,
        conf: facts.confidence,
      })
      .from(facts)
      .where(isNull(facts.expiredAt)),
    db
      .select({
        id: causalEvents.id,
        subj: causalEvents.subjectEntityId,
        pred: causalEvents.predicate,
        tt: causalEvents.transitionType,
        factId: causalEvents.factId,
      })
      .from(causalEvents),
    db
      .select({
        id: causalEdges.id,
        cause: causalEdges.causeEventId,
        effect: causalEdges.effectEventId,
        strength: causalEdges.strength,
      })
      .from(causalEdges)
      .where(isNull(causalEdges.expiredAt)),
    db.select({ a: sameAsLinks.entityAId, b: sameAsLinks.entityBId }).from(sameAsLinks),
  ]);

  return buildCanonicalGraph({ entities: ents, facts: fcts, events, edges, sameAs });
}

// ============================================
// Rich graph dump (doc 39 §3.1 — validity & quality harness)
// ============================================

/**
 * Rich, id-/timestamp-bearing graph dump for the validity & quality harness.
 *
 * Where {@link exportCanonicalGraph} deliberately STRIPS temporal + reasoning
 * fields (active facts only; edges without `reasoning`/`source_references`) so
 * two runs of the same corpus are byte-comparable, the rich export keeps
 * everything the validity layer needs and the canonical form must omit:
 *
 *  - expired facts INCLUDED (so a supersession chain is auditable, not just its
 *    surviving tip) with `valid_at`/`expired_at`/`expire_reason`;
 *  - causal edges WITH `reasoning` + `source_references` (the doc-01 causal
 *    invariant) and expired edges included;
 *  - contradictions, `same_as` links, and the agents' own reports
 *    (extraction / gardening / reasoning) — the second, independent signal of
 *    dimension E.
 *
 * This is the durable, inspectable, agent-reviewable artifact — NOT a diff key.
 * {@link exportCanonicalGraph} and its unit tests are intentionally left
 * untouched; the doc-38 litmus/diff path depends on that stripped form.
 *
 * Note the field mapping vs. doc 39's prose: an entity's human-readable
 * `summary` lives in `entity_meta.summary` (the agent's `update_entity_summary`
 * tool writes it), not on `entities` — so it is LEFT JOINed in. Causal
 * `reasoning`/`source_references` are columns on edges, not events; events carry
 * `transition_type`/`occurred_at`/`delta_confidence`.
 */
export interface RichGraph {
  entities: Array<{
    id: string;
    name: string;
    type: string;
    /** Free-text description on the entity row (distinct from the agent summary). */
    description: string | null;
    /** Agent-written summary from entity_meta (null when no meta row yet). */
    summary: string | null;
    /** Reverse merge lineage — entities folded into this survivor. */
    mergedFrom: string[] | null;
    confidence: number;
    createdAt: Date;
  }>;
  facts: Array<{
    id: string;
    subjectEntityId: string;
    predicate: string;
    objectEntityId: string | null;
    objectValue: string | null;
    confidence: number | null;
    validAt: Date | null;
    invalidAt: Date | null;
    createdAt: Date;
    /** Non-null on superseded/expired facts — the supersession audit signal. */
    expiredAt: Date | null;
    expireReason: string | null;
    sourceMemoryId: string | null;
  }>;
  events: Array<{
    id: string;
    factId: string | null;
    transitionType: string;
    subjectEntityId: string | null;
    predicate: string | null;
    deltaConfidence: number | null;
    occurredAt: Date;
    sourceMemoryId: string | null;
    createdAt: Date;
  }>;
  edges: Array<{
    id: string;
    causeEventId: string;
    effectEventId: string;
    strength: number;
    extractionMethod: string;
    /** TEXT NOT NULL — the doc-01 causal-justification invariant. */
    reasoning: string;
    /** JSONB NOT NULL — source traceability for the causal claim. */
    sourceReferences: unknown;
    corroborationCount: number;
    createdAt: Date;
    expiredAt: Date | null;
    expireReason: string | null;
  }>;
  sameAs: Array<{
    id: string;
    entityAId: string;
    entityBId: string;
    reasoning: string;
    confidence: number;
    createdBy: string;
    createdAt: Date;
  }>;
  /** All contradiction rows (detected + resolved + dismissed), full columns. */
  contradictions: Array<typeof contradictions.$inferSelect>;
  /** The agents' self-reports — the independent signal for the reports review. */
  reports: {
    extraction: Array<typeof extractionReports.$inferSelect>;
    gardening: Array<typeof gardeningReports.$inferSelect>;
    reasoning: Array<typeof reasoningReports.$inferSelect>;
  };
  /** Derived tallies (active vs expired split) for cheap downstream metrics. */
  counts: {
    entities: number;
    facts: number;
    activeFacts: number;
    expiredFacts: number;
    events: number;
    edges: number;
    activeEdges: number;
    expiredEdges: number;
    sameAs: number;
    contradictions: number;
    reports: number;
  };
}

/**
 * Fetch the full rich graph dump. Includes EXPIRED facts and edges (no
 * `expired_at IS NULL` filter) so supersession is auditable. All queries fire
 * in parallel; row counts are benchmark-scale (dozens–hundreds), so no paging.
 */
export async function exportRichGraph(): Promise<RichGraph> {
  const [ents, fcts, events, edges, sameAs, contras, extraction, gardening, reasoning] =
    await Promise.all([
      db
        .select({
          id: entities.id,
          name: entities.canonicalName,
          type: entities.entityType,
          description: entities.description,
          summary: entityMeta.summary,
          mergedFrom: entities.mergedFrom,
          confidence: entities.confidence,
          createdAt: entities.createdAt,
        })
        .from(entities)
        .leftJoin(entityMeta, eq(entityMeta.entityId, entities.id)),
      db
        .select({
          id: facts.id,
          subjectEntityId: facts.subjectEntityId,
          predicate: facts.predicate,
          objectEntityId: facts.objectEntityId,
          objectValue: facts.objectValue,
          confidence: facts.confidence,
          validAt: facts.validAt,
          invalidAt: facts.invalidAt,
          createdAt: facts.createdAt,
          expiredAt: facts.expiredAt,
          expireReason: facts.expireReason,
          sourceMemoryId: facts.sourceMemoryId,
        })
        .from(facts), // no expired filter — expired rows are the audit trail
      db
        .select({
          id: causalEvents.id,
          factId: causalEvents.factId,
          transitionType: causalEvents.transitionType,
          subjectEntityId: causalEvents.subjectEntityId,
          predicate: causalEvents.predicate,
          deltaConfidence: causalEvents.deltaConfidence,
          occurredAt: causalEvents.occurredAt,
          sourceMemoryId: causalEvents.sourceMemoryId,
          createdAt: causalEvents.createdAt,
        })
        .from(causalEvents),
      db
        .select({
          id: causalEdges.id,
          causeEventId: causalEdges.causeEventId,
          effectEventId: causalEdges.effectEventId,
          strength: causalEdges.strength,
          extractionMethod: causalEdges.extractionMethod,
          reasoning: causalEdges.reasoning,
          sourceReferences: causalEdges.sourceReferences,
          corroborationCount: causalEdges.corroborationCount,
          createdAt: causalEdges.createdAt,
          expiredAt: causalEdges.expiredAt,
          expireReason: causalEdges.expireReason,
        })
        .from(causalEdges), // include expired edges
      db
        .select({
          id: sameAsLinks.id,
          entityAId: sameAsLinks.entityAId,
          entityBId: sameAsLinks.entityBId,
          reasoning: sameAsLinks.reasoning,
          confidence: sameAsLinks.confidence,
          createdBy: sameAsLinks.createdBy,
          createdAt: sameAsLinks.createdAt,
        })
        .from(sameAsLinks),
      db.select().from(contradictions),
      db.select().from(extractionReports),
      db.select().from(gardeningReports),
      db.select().from(reasoningReports),
    ]);

  const activeFacts = fcts.filter((f) => f.expiredAt == null).length;
  const activeEdges = edges.filter((e) => e.expiredAt == null).length;

  return {
    entities: ents,
    facts: fcts,
    events,
    edges,
    sameAs,
    contradictions: contras,
    reports: { extraction, gardening, reasoning },
    counts: {
      entities: ents.length,
      facts: fcts.length,
      activeFacts,
      expiredFacts: fcts.length - activeFacts,
      events: events.length,
      edges: edges.length,
      activeEdges,
      expiredEdges: edges.length - activeEdges,
      sameAs: sameAs.length,
      contradictions: contras.length,
      reports: extraction.length + gardening.length + reasoning.length,
    },
  };
}
