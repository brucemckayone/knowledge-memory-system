/**
 * Phase 6 — Pattern Lifecycle (doc 17, nmemo-d9v)
 *
 * Verifies the pattern detection + lifecycle + matching + ghost contracts.
 * Per the Phase 6 plan, fixtures are L1 + adversarial only — L2/L3 corpora
 * deferred to nmemo-klv.6 (the test-harden agentic loop).
 *
 * G1 (this commit) covers only:
 *   - migration 012 makes `rejected` an accepted lifecycle status
 *   - chain collection CTE walks active causal_edges within the lookback
 *     window, respects min/maxChainLength, applies cycle protection
 *
 * Later groups extend this file with normalisation, clustering, lifecycle
 * transitions, naming, edge-time matching, ghosts, and MCP/HTTP wiring.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { testDb, createTestEntity, createTestFact, deleteFromTables } from '../setup.js';
import { detectCausalPatterns, collectChains } from '../../services/causal-patterns.js';

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'causal_edge_history',
      'fact_history',
      'edge_source_refs',
      'causal_edges',
      'causal_events',
      'causal_patterns',
      'memory_entities',
      'entity_aliases',
      'facts',
      'entity_merges',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
}

interface ChainSetup {
  entityId: string;
  eventIds: string[];
  edgeIds: string[];
}

/**
 * Build a linear chain of `numEdges` causal edges sharing a single subject
 * entity. Returns the entity, the (numEdges + 1) event IDs, and the edge IDs
 * in cause→effect order.
 */
async function buildLinearChain(numEdges: number, opts: { occurredAt?: Date } = {}): Promise<ChainSetup> {
  const entity = await createTestEntity({
    canonicalName: `phase6-chain-entity-${Date.now()}-${Math.random()}`,
    entityType: 'standard_rule',
  });
  const entityId = entity.id;

  const occurredAt = opts.occurredAt ?? new Date();

  const eventIds: string[] = [];
  for (let i = 0; i <= numEdges; i++) {
    const fact = await createTestFact({
      subjectEntityId: entityId,
      predicate: 'requires',
      objectValue: `step-${i}`,
    });
    const [row] = await testDb<Array<{ id: string }>>`
      INSERT INTO public.causal_events
        (fact_id, transition_type, subject_entity_id, predicate, occurred_at, source_text)
      VALUES
        (${fact.id}::uuid, 'created', ${entityId}::uuid, 'requires', ${occurredAt}, ${`chain-step-${i}`})
      RETURNING id
    `;
    eventIds.push(row!.id);
  }

  const edgeIds: string[] = [];
  for (let i = 0; i < numEdges; i++) {
    const sourceRefs = JSON.stringify([{ type: 'fact', id: eventIds[i], relevance: 'chain step' }]);
    const [row] = await testDb<Array<{ id: string }>>`
      INSERT INTO public.causal_edges
        (cause_event_id, effect_event_id, strength, extraction_method,
         reasoning, source_references, initial_strength)
      VALUES
        (${eventIds[i]}::uuid, ${eventIds[i + 1]}::uuid, 0.8, 'llm',
         ${`step ${i} causes step ${i + 1}`}, ${sourceRefs}::jsonb, 0.8)
      RETURNING id
    `;
    edgeIds.push(row!.id);
  }

  return { entityId, eventIds, edgeIds };
}

describe('Phase 6 — G1: migration + chain collection (nmemo-d9v.1 + d9v.2)', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  describe('migration 012 — valid_pattern_status accepts rejected', () => {
    it("CHECK constraint allows status='rejected'", async () => {
      const [row] = await testDb<Array<{ id: string }>>`
        INSERT INTO public.causal_patterns
          (name, template_structure, template_length, status,
           instance_count, first_seen_at)
        VALUES
          ('test rejected pattern', ${JSON.stringify([])}::jsonb, 0, 'rejected',
           0, NOW())
        RETURNING id
      `;
      expect(row?.id).toBeDefined();
    });

    it('rejects unknown status values (sanity — constraint still active)', async () => {
      await expect(
        testDb`
          INSERT INTO public.causal_patterns
            (template_structure, template_length, status, instance_count, first_seen_at)
          VALUES
            (${JSON.stringify([])}::jsonb, 0, 'not_a_real_status', 0, NOW())
        `,
      ).rejects.toThrow();
    });
  });

  describe('collectChains — linear 4-edge chain', () => {
    it('returns 6 chains of length ≥ 2 from a 4-edge chain (defaults)', async () => {
      await buildLinearChain(4);

      const chains = await collectChains();

      // For 4 edges (e1..e4) in a linear chain, the CTE emits all forward
      // sub-chains starting from each edge. Filtered to length ≥ 2:
      //   from e1: [e1,e2], [e1,e2,e3], [e1,e2,e3,e4]   → 3
      //   from e2: [e2,e3], [e2,e3,e4]                  → 2
      //   from e3: [e3,e4]                              → 1
      //   from e4: (only single edge, filtered out)     → 0
      expect(chains).toHaveLength(6);
      for (const chain of chains) {
        expect(chain.length).toBeGreaterThanOrEqual(2);
        expect(chain.length).toBeLessThanOrEqual(4);
        expect(chain.edgeIds).toHaveLength(chain.length);
      }
    });

    it('respects maxChainLength', async () => {
      await buildLinearChain(4);

      const chains = await collectChains({ maxChainLength: 2 });

      for (const c of chains) {
        expect(c.length).toBeLessThanOrEqual(2);
      }
    });

    it('respects lookbackDays — old chains excluded', async () => {
      const past = new Date('2025-01-01T00:00:00Z'); // > 1 year ago
      await buildLinearChain(4, { occurredAt: past });

      const chains = await collectChains({ lookbackDays: 30 });
      expect(chains).toHaveLength(0);
    });
  });

  describe('detectCausalPatterns — orchestrator', () => {
    it('returns chainsExamined > 0 for an in-window chain', async () => {
      await buildLinearChain(4);
      const result = await detectCausalPatterns();
      expect(result.chainsExamined).toBeGreaterThan(0);
      // G1 stops at chain collection — later groups populate the rest.
      expect(result.templatesFound).toBe(0);
      expect(result.newStaging).toBe(0);
      expect(result.updatedExisting).toBe(0);
    });

    it('returns 0 chainsExamined when graph is empty', async () => {
      const result = await detectCausalPatterns();
      expect(result.chainsExamined).toBe(0);
    });
  });
});
