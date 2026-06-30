/**
 * Group-aware, latest-valid supersession via the real createFact path
 * (bead nmemo-vpz.1 / E1; doc 41 §5c, §10).
 *
 * These exercise the headline benchmark failure (parallel-ingestion-2026-06-09):
 * a single logical attribute spread across several predicates
 * (`lives_in`/`relocated_to`/`headquartered_in`, `has_role`/`job_title`) used to
 * coexist because createFact matched supersession on an EXACT predicate string.
 * After E1, predicates that resolve to the same exclusive GROUP contend for one
 * active slot, and the LATEST-VALID fact — not the last-committed one — wins.
 *
 * Unlike predicate-canonicalization.test.ts (which pre-normalises everything to
 * a single canonical so exact-match already works), these deliberately use
 * predicates that DO NOT share a canonical and are NOT seeded as exclusive in
 * fact_predicates — so the only thing that can collapse them is the shared
 * exclusive-group resolver + the group gate.
 *
 * Runs against testDb (vitest.config.ts global setup). Embeddings hit the host
 * ML service; no LLM/agent pipeline is invoked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createFact } from '../../services/facts.js';
import { exportRichGraph } from '../../services/graph-canonical-query.js';
import { runInvariants } from '../../services/graph-invariants.js';
import {
  testDb,
  deleteFromTables,
  createTestEntity,
  getActiveFacts,
} from '../setup.js';

const uniqueName = (stem: string) =>
  `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('Group-aware latest-valid supersession (nmemo-vpz.1)', () => {
  beforeEach(async () => {
    // Wipe shared tables INCLUDING fact_predicates: these scenarios must collapse
    // purely via the exclusive-group resolver, with no DB exclusivity flag.
    await deleteFromTables({ acknowledgeGlobal: true });
  });

  it('collapses cross-predicate location sprawl to one latest-valid active fact', async () => {
    const helix = await createTestEntity({ canonicalName: uniqueName('helix'), entityType: 'company' });

    // Same logical attribute (current location), three different predicates,
    // ascending valid_at — none of these share a canonical or a DB exclusive flag.
    await createFact({
      subjectEntityId: helix.id, predicate: 'lives_in', objectValue: 'Boston',
      validAt: new Date('2019-01-01'), actor: 'graph_agent', reasoning: 'HQ Boston 2019',
    });
    await createFact({
      subjectEntityId: helix.id, predicate: 'relocated_to', objectValue: 'Denver',
      validAt: new Date('2020-01-01'), actor: 'graph_agent', reasoning: 'relocated Denver 2020',
    });
    await createFact({
      subjectEntityId: helix.id, predicate: 'headquartered_in', objectValue: 'Austin',
      validAt: new Date('2022-01-01'), actor: 'graph_agent', reasoning: 'HQ Austin 2022',
    });

    const active = await getActiveFacts(helix.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.object_value).toBe('Austin');         // latest valid_at wins
    expect(active[0]!.predicate).toBe('headquartered_in');
  });

  it('collapses cross-predicate role/title sprawl (has_role → job_title)', async () => {
    const elena = await createTestEntity({ canonicalName: uniqueName('elena'), entityType: 'person' });

    await createFact({
      subjectEntityId: elena.id, predicate: 'has_role', objectValue: 'engineering lead',
      validAt: new Date('2021-01-01'), actor: 'graph_agent', reasoning: 'role 2021',
    });
    await createFact({
      subjectEntityId: elena.id, predicate: 'job_title', objectValue: 'Chief Technology Officer',
      validAt: new Date('2023-01-01'), actor: 'graph_agent', reasoning: 'title 2023',
    });

    const active = await getActiveFacts(elena.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.object_value).toBe('Chief Technology Officer');
  });

  it('leaves non-exclusive predicates untouched (all remain active)', async () => {
    const person = await createTestEntity({ canonicalName: uniqueName('person'), entityType: 'person' });

    for (const who of ['Alice', 'Bob', 'Carol']) {
      await createFact({
        subjectEntityId: person.id, predicate: 'knows', objectValue: who,
        validAt: new Date('2024-01-01'), actor: 'graph_agent', reasoning: `knows ${who}`,
      });
    }

    const active = await getActiveFacts(person.id);
    expect(active).toHaveLength(3); // 'knows' is non-exclusive → no group → no supersession
  });

  it('keeps the latest-VALID fact when a back-dated assertion arrives later (nmemo-bsb)', async () => {
    const org = await createTestEntity({ canonicalName: uniqueName('org'), entityType: 'company' });

    // Latest-valid (2022) is committed FIRST...
    await createFact({
      subjectEntityId: org.id, predicate: 'lives_in', objectValue: 'Austin',
      validAt: new Date('2022-01-01'), actor: 'graph_agent', reasoning: 'Austin 2022',
    });
    // ...then a BACK-DATED (2019) assertion arrives. Under last-committed-wins this
    // would wrongly displace Austin; under latest-valid it must lose.
    await createFact({
      subjectEntityId: org.id, predicate: 'relocated_to', objectValue: 'Boston',
      validAt: new Date('2019-01-01'), actor: 'graph_agent', reasoning: 'Boston 2019 (back-dated)',
    });

    const active = await getActiveFacts(org.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.object_value).toBe('Austin'); // latest valid_at, NOT last committed

    // The back-dated fact is still recorded — inserted, then superseded — so the
    // assertion is auditable rather than silently dropped.
    const bostonRows = await testDb`
      SELECT id, expired_at FROM facts
      WHERE subject_entity_id = ${org.id}::uuid AND object_value = 'Boston'
    `;
    expect(bostonRows).toHaveLength(1);
    expect(bostonRows[0]!.expired_at).not.toBeNull();

    const supersededHist = await testDb`
      SELECT event_type, actor FROM fact_history
      WHERE fact_id = ${bostonRows[0]!.id}::uuid AND event_type = 'superseded'
    `;
    expect(supersededHist).toHaveLength(1);
    expect(supersededHist[0]!.actor).toBe('cascade');
  });

  it('satisfies the singleActivePerExclusiveGroup invariant after cross-predicate ingest', async () => {
    const helix = await createTestEntity({ canonicalName: uniqueName('helix-inv'), entityType: 'company' });

    for (const [predicate, value, year] of [
      ['lives_in', 'Boston', 2019],
      ['relocated_to', 'Denver', 2020],
      ['headquartered_in', 'Austin', 2022],
    ] as Array<[string, string, number]>) {
      await createFact({
        subjectEntityId: helix.id, predicate, objectValue: value,
        validAt: new Date(`${year}-01-01`), actor: 'graph_agent', reasoning: 'test',
      });
    }

    const g = await exportRichGraph();
    const report = runInvariants(g);
    const v3 = report.results.find((r) => r.name === 'singleActivePerExclusiveGroup');
    expect(v3).toBeDefined();
    // No coexisting location facts for helix — the headline benchmark failure is gone.
    const helixViolations = v3!.violations.filter((vio) => vio.subjectId === helix.id);
    expect(helixViolations).toEqual([]);
  });
});
