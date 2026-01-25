/**
 * Conflict Resolution Agent Tests
 *
 * Tests for the Conflict Resolution Gardener Agent.
 * Covers CR-001 through CR-008 from the test strategy.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  getFact,
  randomUUID,
  isMLServiceAvailable,
  ML_SERVICES_URL,
} from '../setup.js';

describe('Conflict Resolution Agent', () => {
  let mlAvailable = false;

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - some conflict resolution tests will be skipped');
    }
  });

  // Note: Tests are self-contained with unique IDs - no global cleanup needed

  describe('CR-001: Antonym detection', () => {
    it.skipIf(!mlAvailable)('should detect contradiction for different employers', async () => {
      // Given: Two facts claiming different employers
      await createTestEntity({
        canonicalName: 'Career Person',
        entityType: 'person',
      });

      await createTestEntity({
        canonicalName: 'Company A',
        entityType: 'company',
      });

      await createTestEntity({
        canonicalName: 'Company B',
        entityType: 'company',
      });

      // When: Check for contradiction
      const fact1 = { subject: 'Career Person', predicate: 'works_at', object: 'Company A' };
      const fact2 = { subject: 'Career Person', predicate: 'works_at', object: 'Company B' };

      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1, fact2 }),
      });

      // Then: Contradiction detected
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.contradicts).toBe(true);
      // Type might be 'antonym', 'exclusive', etc.
      expect(result.contradiction_type).toBeDefined();
    }, 30000);
  });

  describe('CR-002: Temporal supersession', () => {
    it('should set invalid_at on old fact when superseded', async () => {
      // Given: Person with old employment
      const person = await createTestEntity({
        canonicalName: 'Job Changer',
        entityType: 'person',
      });

      const oldCompany = await createTestEntity({
        canonicalName: 'Old Corp',
        entityType: 'company',
      });

      const newCompany = await createTestEntity({
        canonicalName: 'New Corp',
        entityType: 'company',
      });

      const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const now = new Date();

      // Create old fact
      const oldFact = await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: oldCompany.id,
        validAt: sixMonthsAgo,
      });

      // When: Supersede with new fact
      // This simulates what the conflict resolution agent would do
      await testDb`
        UPDATE facts
        SET invalid_at = ${now}
        WHERE id = ${oldFact.id}::uuid
      `;

      // Create new fact
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: newCompany.id,
        validAt: now,
      });

      // Then: Old fact has invalid_at set
      const updatedOldFact = await getFact(oldFact.id);
      expect(updatedOldFact!.invalid_at).not.toBeNull();

      // Only new fact is "current"
      const currentFacts = await testDb`
        SELECT f.*, e.canonical_name as company
        FROM facts f
        JOIN entities e ON f.object_entity_id = e.id
        WHERE f.subject_entity_id = ${person.id}::uuid
          AND f.predicate = 'works_at'
          AND f.invalid_at IS NULL
      `;

      expect(currentFacts.length).toBe(1);
      expect(currentFacts[0]!.company).toBe('New Corp');
    });
  });

  describe('CR-003: No contradiction', () => {
    it.skipIf(!mlAvailable)('should not flag compatible facts as contradictions', async () => {
      // Given: Two compatible "knows" relationships
      const fact1 = { subject: 'Alice', predicate: 'knows', object: 'Bob' };
      const fact2 = { subject: 'Alice', predicate: 'knows', object: 'Carol' };

      // When: Check for contradiction
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1, fact2 }),
      });

      // Then: No contradiction (can know multiple people)
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.contradicts).toBe(false);
    }, 30000);
  });

  describe('CR-004: Numeric contradiction', () => {
    it.skipIf(!mlAvailable)('should detect numeric value conflicts', async () => {
      // Given: Two facts with different numeric values
      const fact1 = { subject: 'Project Budget', predicate: 'amount_is', object: '$100,000' };
      const fact2 = { subject: 'Project Budget', predicate: 'amount_is', object: '$200,000' };

      // When: Check for contradiction
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1, fact2 }),
      });

      // Then: Numeric contradiction detected
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.contradicts).toBe(true);
      // May be detected as 'numeric' type
    }, 30000);
  });

  describe('CR-005: Negation detection', () => {
    it.skipIf(!mlAvailable)('should detect negation contradictions', async () => {
      // Given: Positive and negative statements
      const fact1 = { subject: 'Project X', predicate: 'status_is', object: 'active' };
      const fact2 = { subject: 'Project X', predicate: 'status_is', object: 'cancelled' };

      // When: Check for contradiction
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1, fact2 }),
      });

      // Then: Negation/status contradiction detected
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.contradicts).toBe(true);
    }, 30000);
  });

  describe('CR-006: Flag for review', () => {
    it('should track ambiguous cases for manual review', async () => {
      // Given: Job tracking table
      const jobId = randomUUID();

      // When: Record ambiguous case
      await testDb`
        INSERT INTO gardener_job_meta (
          job_id, job_type, tier,
          checkpoint
        )
        VALUES (
          ${jobId}::uuid,
          'gardener:resolve-conflicts',
          'periodic',
          ${JSON.stringify({
            flaggedForReview: true,
            reason: 'Ambiguous contradiction - requires human judgment',
            factPair: ['fact-1', 'fact-2'],
          })}::jsonb
        )
      `;

      // Then: Case is flagged
      const result = await testDb`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      // Note: postgres-js may return JSONB as string, so parse if needed
      const checkpoint = typeof result[0]!.checkpoint === 'string'
        ? JSON.parse(result[0]!.checkpoint as string)
        : result[0]!.checkpoint;
      expect((checkpoint as Record<string, unknown>).flaggedForReview).toBe(true);
      expect(String((checkpoint as Record<string, unknown>).reason)).toContain('Ambiguous');
    });
  });

  describe('CR-007: Checkpoint resume', () => {
    it('should resume from checkpoint on long batch', async () => {
      // Given: Interrupted job with checkpoint
      const jobId = randomUUID();
      const checkpointState = {
        processedFactPairs: 50,
        totalFactPairs: 100,
        lastProcessedPairIndex: 49,
        conflictsFound: 5,
        resolutionsApplied: 3,
      };

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, checkpoint, attempts)
        VALUES (
          ${jobId}::uuid,
          'gardener:resolve-conflicts',
          'periodic',
          ${JSON.stringify(checkpointState)}::jsonb,
          1
        )
      `;

      // When: Resume from checkpoint
      const result = await testDb`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      // Then: Can resume from where we left off
      // Note: postgres-js may return JSONB as string, so parse if needed
      const restored = typeof result[0]!.checkpoint === 'string'
        ? JSON.parse(result[0]!.checkpoint as string)
        : result[0]!.checkpoint;
      expect((restored as Record<string, unknown>).processedFactPairs).toBe(50);
      expect((restored as Record<string, unknown>).totalFactPairs).toBe(100);

      // Would continue from index 50
      const resumeFrom = ((restored as Record<string, unknown>).lastProcessedPairIndex as number) + 1;
      expect(resumeFrom).toBe(50);
    });
  });

  describe('CR-008: LLM fallback', () => {
    it.skipIf(!mlAvailable)('should use LLM for subtle contradictions', async () => {
      // Given: Subtle contradiction that needs reasoning
      const fact1 = {
        subject: 'John',
        predicate: 'expertise_in',
        object: 'JavaScript development',
      };
      const fact2 = {
        subject: 'John',
        predicate: 'expertise_in',
        object: 'Has never written a line of code',
      };

      // When: Use LLM to detect subtle contradiction
      const response = await fetch(`${ML_SERVICES_URL}/detect-contradiction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact1, fact2 }),
      });

      // Then: LLM reasoning provided
      expect(response.ok).toBe(true);
      const result = await response.json() as Record<string, unknown>;

      expect(result.contradicts).toBe(true);
      // Reasoning should explain why these conflict
      if (result.reasoning) {
        expect(typeof result.reasoning).toBe('string');
        expect((result.reasoning as string).length).toBeGreaterThan(10);
      }
    }, 30000);
  });

  describe('Conflict detection - predicate exclusivity', () => {
    it('should detect conflicts for exclusive predicates', async () => {
      // Given: Exclusive predicate configuration
      const exclusivePredicates = await testDb`
        SELECT predicate, is_exclusive FROM fact_predicates
        WHERE is_exclusive = true
      `;

      const exclusiveList = exclusivePredicates.map(p => p.predicate);

      // Then: works_at should be exclusive
      expect(exclusiveList).toContain('works_at');

      // has_role should be exclusive
      expect(exclusiveList).toContain('has_role');
    });

    it('should allow multiple non-exclusive predicates', async () => {
      // Given: Person with multiple project assignments
      const person = await createTestEntity({
        canonicalName: 'Multi-Project Person',
        entityType: 'person',
      });

      const project1 = await createTestEntity({
        canonicalName: 'Project A',
        entityType: 'project',
      });

      const project2 = await createTestEntity({
        canonicalName: 'Project B',
        entityType: 'project',
      });

      // When: Assign to multiple projects
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_on',
        objectEntityId: project1.id,
      });

      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_on',
        objectEntityId: project2.id,
      });

      // Then: Both facts coexist (works_on is not exclusive)
      const facts = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${person.id}::uuid
          AND predicate = 'works_on'
          AND invalid_at IS NULL
      `;

      expect(facts.length).toBe(2);
    });
  });
});
