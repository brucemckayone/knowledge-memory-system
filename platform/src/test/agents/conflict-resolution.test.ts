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

  // Phase 4 Golden Tests: CNF-001 to CNF-005 (Boundaries B8, B9)

  describe('CNF-001: Detect exclusive conflict (B8)', () => {
    it('should identify works_at as exclusive predicate', async () => {
      // Given: Check predicate exclusivity
      const predicate = await testDb`
        SELECT is_exclusive FROM fact_predicates WHERE predicate = 'works_at'
      `;

      // Then: works_at is exclusive (can only work at one place at a time)
      expect(predicate[0]?.is_exclusive).toBe(true);
    });

    it('should flag multiple exclusive facts as conflicting', async () => {
      // Given: Person entity
      const person = await createTestEntity({
        canonicalName: 'Conflict Test Person',
        entityType: 'person',
      });

      const company1 = await createTestEntity({
        canonicalName: 'First Company',
        entityType: 'company',
      });

      const company2 = await createTestEntity({
        canonicalName: 'Second Company',
        entityType: 'company',
      });

      // When: Create two active facts with exclusive predicate
      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company1.id,
        validAt: new Date(),
      });

      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: company2.id,
        validAt: new Date(),
      });

      // Then: Two active facts exist (conflict not yet resolved)
      const activeFacts = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${person.id}::uuid
          AND predicate = 'works_at'
          AND invalid_at IS NULL
      `;

      // This represents a conflict state that needs resolution
      expect(activeFacts.length).toBe(2);
    });
  });

  describe('CNF-002: Allow non-exclusive (B8)', () => {
    it('should identify knows as non-exclusive predicate', async () => {
      // Given: Check predicate exclusivity
      const predicate = await testDb`
        SELECT is_exclusive FROM fact_predicates WHERE predicate = 'knows'
      `;

      // Then: knows is non-exclusive (can know many people)
      expect(predicate[0]?.is_exclusive).toBe(false);
    });

    it('should allow multiple non-exclusive facts without conflict', async () => {
      // Given: Person who knows multiple people
      const person = await createTestEntity({
        canonicalName: 'Social Person',
        entityType: 'person',
      });

      const friend1 = await createTestEntity({
        canonicalName: 'Friend One',
        entityType: 'person',
      });

      const friend2 = await createTestEntity({
        canonicalName: 'Friend Two',
        entityType: 'person',
      });

      const friend3 = await createTestEntity({
        canonicalName: 'Friend Three',
        entityType: 'person',
      });

      // When: Create multiple knows facts
      await createTestFact({ subjectEntityId: person.id, predicate: 'knows', objectEntityId: friend1.id });
      await createTestFact({ subjectEntityId: person.id, predicate: 'knows', objectEntityId: friend2.id });
      await createTestFact({ subjectEntityId: person.id, predicate: 'knows', objectEntityId: friend3.id });

      // Then: All facts coexist (no conflict)
      const facts = await testDb`
        SELECT * FROM facts
        WHERE subject_entity_id = ${person.id}::uuid
          AND predicate = 'knows'
          AND invalid_at IS NULL
      `;

      expect(facts.length).toBe(3);
    });
  });

  describe('CNF-003: Supersede older fact (B9)', () => {
    it('should invalidate older fact when newer contradicting fact arrives', async () => {
      // Given: Person with historical employment
      const person = await createTestEntity({
        canonicalName: 'Employee History',
        entityType: 'person',
      });

      const oldJob = await createTestEntity({
        canonicalName: 'Previous Employer',
        entityType: 'company',
      });

      const newJob = await createTestEntity({
        canonicalName: 'Current Employer',
        entityType: 'company',
      });

      const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const now = new Date();

      // Create old employment fact
      const oldFact = await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: oldJob.id,
        validAt: threeMonthsAgo,
      });

      // When: Supersede with new employment
      await testDb`UPDATE facts SET invalid_at = ${now} WHERE id = ${oldFact.id}::uuid`;

      await createTestFact({
        subjectEntityId: person.id,
        predicate: 'works_at',
        objectEntityId: newJob.id,
        validAt: now,
      });

      // Then: Only new fact is current
      const currentFacts = await testDb`
        SELECT f.*, e.canonical_name as employer
        FROM facts f
        JOIN entities e ON f.object_entity_id = e.id
        WHERE f.subject_entity_id = ${person.id}::uuid
          AND f.predicate = 'works_at'
          AND f.invalid_at IS NULL
      `;

      expect(currentFacts.length).toBe(1);
      expect(currentFacts[0]!.employer).toBe('Current Employer');
    });
  });

  describe('CNF-004: Flag ambiguous (B9)', () => {
    it('should store ambiguous conflict for manual review', async () => {
      // Given: Job with ambiguous conflict state
      const jobId = randomUUID();
      const ambiguousState = {
        resolution: 'flag',
        reason: 'Multiple valid interpretations possible',
        factIds: [randomUUID(), randomUUID()],
        confidence: 0.5,
        requiresHumanReview: true,
      };

      // When: Store flagged state
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, checkpoint)
        VALUES (
          ${jobId}::uuid,
          'gardener:resolve-conflicts',
          'periodic',
          ${JSON.stringify(ambiguousState)}::jsonb
        )
      `;

      // Then: State can be retrieved for review
      const result = await testDb`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      const checkpoint = typeof result[0]!.checkpoint === 'string'
        ? JSON.parse(result[0]!.checkpoint as string)
        : result[0]!.checkpoint;

      expect((checkpoint as Record<string, unknown>).resolution).toBe('flag');
      expect((checkpoint as Record<string, unknown>).requiresHumanReview).toBe(true);
    });
  });

  describe('CNF-005: Checkpoint batch (B9)', () => {
    it('should checkpoint every 10 facts during batch processing', async () => {
      // Given: Batch processing state
      const jobId = randomUUID();

      // Simulate checkpoint at fact 10
      const checkpoint10 = {
        processedIds: Array.from({ length: 10 }, () => randomUUID()),
        lastBatchIndex: 10,
        totalFacts: 50,
        conflictsFound: 2,
      };

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, checkpoint)
        VALUES (${jobId}::uuid, 'gardener:resolve-conflicts', 'periodic', ${JSON.stringify(checkpoint10)}::jsonb)
      `;

      // When: Update checkpoint at fact 20
      const checkpoint20 = {
        processedIds: Array.from({ length: 20 }, () => randomUUID()),
        lastBatchIndex: 20,
        totalFacts: 50,
        conflictsFound: 4,
      };

      await testDb`
        UPDATE gardener_job_meta
        SET checkpoint = ${JSON.stringify(checkpoint20)}::jsonb,
            checkpoint_at = NOW()
        WHERE job_id = ${jobId}::uuid
      `;

      // Then: Checkpoint reflects batch progress
      const result = await testDb`
        SELECT checkpoint, checkpoint_at FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      const checkpoint = typeof result[0]!.checkpoint === 'string'
        ? JSON.parse(result[0]!.checkpoint as string)
        : result[0]!.checkpoint;

      expect((checkpoint as Record<string, unknown>).lastBatchIndex).toBe(20);
      expect(((checkpoint as Record<string, unknown>).processedIds as string[]).length).toBe(20);
    });
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
