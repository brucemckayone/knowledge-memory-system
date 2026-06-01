/**
 * Canonical Graph — DB fetch.
 *
 * Thin I/O wrapper: reads the live graph (active facts/edges only, mirroring
 * `/api/viz/unified`) and feeds raw rows into the pure {@link buildCanonicalGraph}.
 * Kept separate from `graph-canonical.ts` so the keying/diff logic stays
 * unit-testable without a DB. Integration-tested only at benchmark time.
 */

import { isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entities, facts, causalEvents, causalEdges, sameAsLinks } from '../db/schema.js';
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
