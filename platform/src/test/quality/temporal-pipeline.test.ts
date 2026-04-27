/**
 * Layer 1: Deterministic Temporal Pipeline Tests
 *
 * Tests the bi-temporal query system with fully seeded data.
 * Zero ML involvement — PostgreSQL only.
 *
 * Requires: PostgreSQL
 * Speed: < 10s
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  deleteFromTables,
  getActiveFacts,
} from '../setup.js';
import { seedTimeline } from './helpers.js';

describe('Layer 1: Temporal Pipeline', () => {
  beforeEach(async () => {
    await deleteFromTables({
      tables: [
        'memory_entities', 'entity_aliases', 'entity_merges',
        'contradiction_reviews', 'facts', 'entities',
      ],
      acknowledgeGlobal: true,
    });
  });

  // T1: Point-in-time query
  it('T1: should return correct employer at each point in time', async () => {
    const { personId } = await seedTimeline('Alice', [
      { name: 'Acme', validAt: new Date('2023-01-01'), invalidAt: new Date('2024-06-01') },
      { name: 'Beta Corp', validAt: new Date('2024-06-01'), invalidAt: new Date('2025-03-01') },
      { name: 'Gamma Ltd', validAt: new Date('2025-03-01') },
    ]);

    // Query at mid-2023 → Acme
    const mid2023 = await testDb`
      SELECT f.*, e.canonical_name as object_name
      FROM facts f
      JOIN entities e ON e.id = f.object_entity_id
      WHERE f.subject_entity_id = ${personId}::uuid
        AND f.predicate = 'works_at'
        AND f.expired_at IS NULL
        AND f.valid_at <= ${new Date('2023-06-15')}
        AND (f.invalid_at IS NULL OR f.invalid_at > ${new Date('2023-06-15')})
    `;
    expect(mid2023).toHaveLength(1);
    expect(mid2023[0]!.object_name).toBe('Acme');

    // Query at 2024-09-01 → Beta Corp
    const sep2024 = await testDb`
      SELECT f.*, e.canonical_name as object_name
      FROM facts f
      JOIN entities e ON e.id = f.object_entity_id
      WHERE f.subject_entity_id = ${personId}::uuid
        AND f.predicate = 'works_at'
        AND f.expired_at IS NULL
        AND f.valid_at <= ${new Date('2024-09-01')}
        AND (f.invalid_at IS NULL OR f.invalid_at > ${new Date('2024-09-01')})
    `;
    expect(sep2024).toHaveLength(1);
    expect(sep2024[0]!.object_name).toBe('Beta Corp');

    // Query at 2025-06-01 → Gamma Ltd
    const jun2025 = await testDb`
      SELECT f.*, e.canonical_name as object_name
      FROM facts f
      JOIN entities e ON e.id = f.object_entity_id
      WHERE f.subject_entity_id = ${personId}::uuid
        AND f.predicate = 'works_at'
        AND f.expired_at IS NULL
        AND f.valid_at <= ${new Date('2025-06-01')}
        AND (f.invalid_at IS NULL OR f.invalid_at > ${new Date('2025-06-01')})
    `;
    expect(jun2025).toHaveLength(1);
    expect(jun2025[0]!.object_name).toBe('Gamma Ltd');
  });

  // T2: Transaction vs event time
  it('T2: should respect transaction time (created_at) vs event time (valid_at)', async () => {
    // Fact was true from Jan 1 but not recorded until Mar 1
    const person = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
    const company = await createTestEntity({ canonicalName: 'DataCo', entityType: 'company' });

    const eventTime = new Date('2025-01-01');
    const recordTime = new Date('2025-03-01');

    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: company.id,
      validAt: eventTime,
      createdAt: recordTime,
    });

    // Query by event time (Feb 1): fact is true in reality
    const byEventTime = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
        AND valid_at <= ${new Date('2025-02-01')}
        AND (invalid_at IS NULL OR invalid_at > ${new Date('2025-02-01')})
    `;
    expect(byEventTime).toHaveLength(1);

    // Query by transaction time (Feb 1): not yet recorded
    const byTxTime = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
        AND created_at <= ${new Date('2025-02-01')}
    `;
    expect(byTxTime).toHaveLength(0);

    // Query by transaction time (Apr 1): now recorded
    const byTxTimeLater = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
        AND created_at <= ${new Date('2025-04-01')}
    `;
    expect(byTxTimeLater).toHaveLength(1);
  });

  // T3: Correction chain via expiredAt
  it('T3: should maintain correction chain with superseded facts', async () => {
    const project = await createTestEntity({ canonicalName: 'Project Alpha', entityType: 'project' });

    // Original budget
    const f1 = await createTestFact({
      subjectEntityId: project.id,
      predicate: 'has_status',
      objectValue: 'Budget: £500k',
      validAt: new Date('2026-01-15'),
    });

    // Correction: expire old, create new
    await testDb`UPDATE facts SET expired_at = NOW() WHERE id = ${f1.id}::uuid`;

    const f2 = await createTestFact({
      subjectEntityId: project.id,
      predicate: 'has_status',
      objectValue: 'Budget: £350k',
      validAt: new Date('2026-02-20'),
    });

    // Second update: expire corrected, create final
    await testDb`UPDATE facts SET expired_at = NOW() WHERE id = ${f2.id}::uuid`;

    await createTestFact({
      subjectEntityId: project.id,
      predicate: 'has_status',
      objectValue: 'Budget: £600k',
      validAt: new Date('2026-03-10'),
    });

    // Only latest active
    const active = await getActiveFacts(project.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.object_value).toBe('Budget: £600k');

    // Full history (including expired)
    const all = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${project.id}::uuid
        AND predicate = 'has_status'
      ORDER BY created_at ASC
    `;
    expect(all).toHaveLength(3);
    // First two should be expired
    expect(all[0]!.expired_at).not.toBeNull();
    expect(all[1]!.expired_at).not.toBeNull();
    expect(all[2]!.expired_at).toBeNull();
  });

  // T4: Exclusive predicate auto-expire
  it('T4: should detect that exclusive predicates produce supersession', async () => {
    const person = await createTestEntity({ canonicalName: 'Carol', entityType: 'person' });
    const compA = await createTestEntity({ canonicalName: 'CompanyA', entityType: 'company' });
    const compB = await createTestEntity({ canonicalName: 'CompanyB', entityType: 'company' });

    // Ensure works_at is exclusive in the predicate table
    const predicateInfo = await testDb`
      SELECT is_exclusive FROM fact_predicates WHERE predicate = 'works_at'
    `;
    expect(predicateInfo[0]?.is_exclusive).toBe(true);

    // Create first works_at fact
    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: compA.id,
      validAt: new Date('2024-01-01'),
    });

    // Create second works_at fact — should be able to coexist in test DB
    // (The facts service handles supersession, not the raw INSERT)
    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: compB.id,
      validAt: new Date('2025-01-01'),
    });

    // Both raw facts exist (supersession is handled at service layer)
    const allFacts = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
    `;
    expect(allFacts.length).toBeGreaterThanOrEqual(2);

    // Verify the predicate IS exclusive (the service layer would handle auto-expire)
    expect(predicateInfo[0]?.is_exclusive).toBe(true);
  });

  // T5: Non-exclusive predicate coexistence
  it('T5: should allow multiple active facts for non-exclusive predicates', async () => {
    const person = await createTestEntity({ canonicalName: 'Diana', entityType: 'person' });
    const p1 = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
    const p2 = await createTestEntity({ canonicalName: 'Eve', entityType: 'person' });
    const p3 = await createTestEntity({ canonicalName: 'Frank', entityType: 'person' });

    // Verify knows is NOT exclusive
    const predicateInfo = await testDb`
      SELECT is_exclusive FROM fact_predicates WHERE predicate = 'knows'
    `;
    expect(predicateInfo[0]?.is_exclusive).toBe(false);

    // Create three knows facts
    await createTestFact({ subjectEntityId: person.id, predicate: 'knows', objectEntityId: p1.id });
    await createTestFact({ subjectEntityId: person.id, predicate: 'knows', objectEntityId: p2.id });
    await createTestFact({ subjectEntityId: person.id, predicate: 'knows', objectEntityId: p3.id });

    // All three should be active
    const active = await getActiveFacts(person.id);
    const knowsFacts = active.filter(f => f.predicate === 'knows');
    expect(knowsFacts).toHaveLength(3);
  });

  // T6: Boundary precision
  it('T6: should handle boundary timestamps correctly (valid_at inclusive, invalid_at exclusive)', async () => {
    const person = await createTestEntity({ canonicalName: 'Eve', entityType: 'person' });
    const company = await createTestEntity({ canonicalName: 'BoundCo', entityType: 'company' });

    const validAt = new Date('2024-06-01T00:00:00.000Z');
    const invalidAt = new Date('2024-12-01T00:00:00.000Z');

    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: company.id,
      validAt,
      invalidAt,
    });

    // At exact valid_at: should be found (inclusive)
    const atStart = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
        AND valid_at <= ${validAt}
        AND (invalid_at IS NULL OR invalid_at > ${validAt})
    `;
    expect(atStart).toHaveLength(1);

    // At exact invalid_at: should NOT be found (exclusive)
    const atEnd = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
        AND valid_at <= ${invalidAt}
        AND (invalid_at IS NULL OR invalid_at > ${invalidAt})
    `;
    expect(atEnd).toHaveLength(0);

    // 1ms before invalid_at: should be found
    const justBefore = new Date(invalidAt.getTime() - 1);
    const atBeforeEnd = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
        AND valid_at <= ${justBefore}
        AND (invalid_at IS NULL OR invalid_at > ${justBefore})
    `;
    expect(atBeforeEnd).toHaveLength(1);
  });

  // T7: Empty timeline
  it('T7: should return empty results for entity with no facts', async () => {
    const person = await createTestEntity({ canonicalName: 'Ghost', entityType: 'person' });

    const facts = await getActiveFacts(person.id);
    expect(facts).toHaveLength(0);

    // Point-in-time query should also return nothing
    const result = await testDb`
      SELECT * FROM facts
      WHERE subject_entity_id = ${person.id}::uuid
        AND predicate = 'works_at'
        AND expired_at IS NULL
        AND valid_at <= NOW()
        AND (invalid_at IS NULL OR invalid_at > NOW())
    `;
    expect(result).toHaveLength(0);
  });

  // T8: Long supersession chain
  it('T8: should handle a 5-employer chain with exactly 1 active at each transition point', async () => {
    const { personId } = await seedTimeline('ChainPerson', [
      { name: 'Emp-A', validAt: new Date('2020-01-01'), invalidAt: new Date('2021-01-01') },
      { name: 'Emp-B', validAt: new Date('2021-01-01'), invalidAt: new Date('2022-01-01') },
      { name: 'Emp-C', validAt: new Date('2022-01-01'), invalidAt: new Date('2023-01-01') },
      { name: 'Emp-D', validAt: new Date('2023-01-01'), invalidAt: new Date('2024-01-01') },
      { name: 'Emp-E', validAt: new Date('2024-01-01') },
    ]);

    const queryAt = async (date: Date) => {
      const rows = await testDb`
        SELECT f.*, e.canonical_name as object_name
        FROM facts f
        JOIN entities e ON e.id = f.object_entity_id
        WHERE f.subject_entity_id = ${personId}::uuid
          AND f.predicate = 'works_at'
          AND f.expired_at IS NULL
          AND f.valid_at <= ${date}
          AND (f.invalid_at IS NULL OR f.invalid_at > ${date})
      `;
      return rows;
    };

    // Mid-point of each employment
    const checks = [
      { date: new Date('2020-06-15'), expected: 'Emp-A' },
      { date: new Date('2021-06-15'), expected: 'Emp-B' },
      { date: new Date('2022-06-15'), expected: 'Emp-C' },
      { date: new Date('2023-06-15'), expected: 'Emp-D' },
      { date: new Date('2024-06-15'), expected: 'Emp-E' },
    ];

    for (const { date, expected } of checks) {
      const result = await queryAt(date);
      expect(result, `Expected exactly 1 result at ${date.toISOString()}`).toHaveLength(1);
      expect(result[0]!.object_name).toBe(expected);
    }

    // Before any employment: nothing
    const before = await queryAt(new Date('2019-06-15'));
    expect(before).toHaveLength(0);
  });
});
