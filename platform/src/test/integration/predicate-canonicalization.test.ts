/**
 * Predicate canonicalization restores supersession (bead nmemo-hm4.10).
 *
 * The headline supersession gap: the graph agent normalizes a predicate
 * (causal-agent.ts: `normalizePredicate(...)`) before calling createFact, and
 * createFact only supersedes when (a) the predicate is exclusive AND (b) an
 * earlier active fact shares the EXACT predicate string. Before the fix the
 * title/role sprawl (`job_title`/`title`/`role`/`role_at`/…) and the HQ sprawl
 * (`headquartered_in`/`hq`/…) were neither canonicalized nor exclusive, so a
 * person accumulated many coexisting title facts and an org sat in two HQs.
 *
 * The fix folds the sprawl onto two exclusive canonicals — `job_title` and
 * `headquartered_in` — in predicate-ontology.ts (normalize) AND seeds them as
 * is_exclusive=true in fact_predicates (migration 039). createFact reads the
 * exclusivity flag from the fact_predicates TABLE (its own local
 * getPredicateInfo), not the ontology module, so BOTH halves are required.
 *
 * This test exercises the real createFact path against cognitive_test. Because
 * deleteFromTables wipes fact_predicates, beforeEach re-seeds exactly the two
 * rows migration 039 ships — making the createFact→fact_predicates dependency
 * explicit at the call site rather than implicit in global setup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createFact } from '../../services/facts.js';
import { normalizePredicate } from '../../services/predicate-ontology.js';
import { exportRichGraph } from '../../services/graph-canonical-query.js';
import { runInvariants } from '../../services/graph-invariants.js';
import {
  testDb,
  deleteFromTables,
  createTestEntity,
  getActiveFacts,
} from '../setup.js';

/**
 * Re-seed the two exclusive canonicals migration 039 ships. deleteFromTables
 * (called in beforeEach) wipes fact_predicates, and createFact reads the
 * is_exclusive flag from this table — so without this the supersession gate
 * is closed for every predicate and nothing is collapsed.
 */
async function seedExclusivePredicates(): Promise<void> {
  await testDb`
    INSERT INTO fact_predicates (predicate, description, predicate_type, is_exclusive, category, aliases, status)
    VALUES
      ('job_title', 'Current job title/role held by a person', 'role', true, 'professional',
       ARRAY['title','role','position','job','occupation','role_at','current_title','job_role','current_role','designation'], 'canonical'),
      ('headquartered_in', 'Headquarters location of an organization', 'location', true, 'location',
       ARRAY['hq','headquarters','head_office','headquartered','hq_in','head_office_in'], 'canonical')
    ON CONFLICT (predicate) DO UPDATE SET is_exclusive = EXCLUDED.is_exclusive
  `;
}

describe('Predicate canonicalization restores supersession (nmemo-hm4.10)', () => {
  beforeEach(async () => {
    await deleteFromTables({ acknowledgeGlobal: true });
    await seedExclusivePredicates();
  });

  it('title/role sprawl collapses to a single active job_title fact (Elena → CTO only)', async () => {
    const person = await createTestEntity({
      canonicalName: `elena-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      entityType: 'person',
    });

    const timeline: Array<[rawPredicate: string, value: string, year: number]> = [
      ['job_title', 'junior software engineer', 2019],
      ['title', 'senior engineer', 2021],
      ['role', 'engineering lead', 2022],
      ['title', 'chief technology officer', 2023],
    ];

    for (const [rawPredicate, value, year] of timeline) {
      await createFact({
        subjectEntityId: person.id,
        predicate: normalizePredicate(rawPredicate),
        objectValue: value,
        validAt: new Date(`${year}-01-01`),
        actor: 'graph_agent',
        reasoning: `test: ${rawPredicate} = ${value} (${year})`,
      });
    }

    const active = await getActiveFacts(person.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.object_value).toBe('chief technology officer');
    // All four assertions folded onto the one canonical predicate.
    expect(active[0]!.predicate).toBe('job_title');
  });

  it('HQ sprawl collapses to a single active headquartered_in fact (Helix → Austin only)', async () => {
    const company = await createTestEntity({
      canonicalName: `helix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      entityType: 'company',
    });

    await createFact({
      subjectEntityId: company.id,
      predicate: normalizePredicate('headquartered_in'),
      objectValue: 'Boston',
      validAt: new Date('2019-01-01'),
      actor: 'graph_agent',
      reasoning: 'test: HQ Boston 2019',
    });
    await createFact({
      subjectEntityId: company.id,
      predicate: normalizePredicate('headquarters'),
      objectValue: 'Austin',
      validAt: new Date('2022-01-01'),
      actor: 'graph_agent',
      reasoning: 'test: HQ Austin 2022',
    });

    const active = await getActiveFacts(company.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.object_value).toBe('Austin');
    expect(active[0]!.predicate).toBe('headquartered_in');
  });

  it('V3 invariant singleActivePerExclusiveGroup passes after canonicalization', async () => {
    // Build the same two subjects, then assert the pure graph invariant the
    // harness uses sees no exclusive-group conflict.
    const person = await createTestEntity({
      canonicalName: `elena-inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      entityType: 'person',
    });
    const company = await createTestEntity({
      canonicalName: `helix-inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      entityType: 'company',
    });

    for (const [rawPredicate, value, year] of [
      ['job_title', 'junior software engineer', 2019],
      ['title', 'senior engineer', 2021],
      ['role', 'engineering lead', 2022],
      ['title', 'chief technology officer', 2023],
    ] as Array<[string, string, number]>) {
      await createFact({
        subjectEntityId: person.id,
        predicate: normalizePredicate(rawPredicate),
        objectValue: value,
        validAt: new Date(`${year}-01-01`),
        actor: 'graph_agent',
        reasoning: 'test',
      });
    }
    for (const [rawPredicate, value, year] of [
      ['headquartered_in', 'Boston', 2019],
      ['headquarters', 'Austin', 2022],
    ] as Array<[string, string, number]>) {
      await createFact({
        subjectEntityId: company.id,
        predicate: normalizePredicate(rawPredicate),
        objectValue: value,
        validAt: new Date(`${year}-01-01`),
        actor: 'graph_agent',
        reasoning: 'test',
      });
    }

    const g = await exportRichGraph();
    const report = runInvariants(g);
    const v3 = report.results.find((r) => r.name === 'singleActivePerExclusiveGroup');

    expect(v3).toBeDefined();
    expect(v3!.violations).toEqual([]);
    expect(v3!.pass).toBe(true);
  });
});
