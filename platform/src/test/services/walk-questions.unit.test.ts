/**
 * Unit Tests: Walk-question composition skill (ASK-013, MNEMO-478.1).
 *
 * Pure unit — the external seams (candidate selection, ghost detection, source
 * lift, compose, hard-topics) are injected via composeWalkQuestions's `_deps`, so
 * no DB / Qdrant / ml-services. Exercises the ranking, the per-session no-repeat
 * contract, hard-topics suppression, the no-readable-content skip, span
 * re-validation, and the ASK-013 output shape.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub the modules walk-questions imports at runtime so loading it under the
// no-infra unit config does NOT pull the real db/index.js → config.ts (which
// process.exit(1)s without DATABASE_URL). Every external seam is injected via
// `_deps` in the tests below, so these stubs are never actually called — they
// only keep the import graph from touching real config. (Same posture as
// entity-profile.test.ts.)
vi.mock('../../db/index.js', () => ({ db: { execute: vi.fn() } }));
vi.mock('../../services/qdrant.js', () => ({ getMemory: vi.fn() }));
vi.mock('../../services/causal-patterns.js', () => ({ findCausalGhosts: vi.fn() }));
vi.mock('../../services/voice-c-compose-llm.js', () => ({ composeVoiceCWithLLMFallback: vi.fn() }));

import {
  composeWalkQuestions,
  type WalkQuestionDeps,
  type CandidateEntity,
} from '../../services/walk-questions.js';
import type { Ghost } from '../../services/causal-patterns.js';

function makeGhost(patternId: string, confidence: number): Ghost {
  return {
    patternId,
    patternName: `pattern-${patternId}`,
    expectedCauseEntityType: 'standard_rule',
    expectedEffectEntityType: 'standard_rule',
    expectedPredicateCategory: 'because',
    positionInPattern: 1,
    confidence,
    reasoning: `ghost for ${patternId}`,
  };
}

/**
 * A deps factory: each entity owns one ghost (pattern id = `p-${entity}`) and one
 * readable source memory (`m-${entity}`). `compose` echoes a Voice-C-ish question
 * with a single annotation spanning the leading observation phrase. Override any
 * seam per test.
 */
function makeDeps(overrides: Partial<WalkQuestionDeps> = {}): Partial<WalkQuestionDeps> {
  const base: WalkQuestionDeps = {
    selectCandidateEntities: async () => [],
    findCausalGhosts: async (entityId: string) => [makeGhost(`p-${entityId}`, 0.5)],
    getEntitySourceMemories: async (entityId: string) => [`m-${entityId}`],
    getMemoryContent: async (memoryId: string) => `i kept circling ${memoryId}`,
    compose: async (input) => {
      const firstId = input.parts[0]?.source.id ?? 'm';
      const text = `i kept circling ${firstId} in march, then again in may. — where did this begin?`;
      const phrase = `i kept circling ${firstId}`;
      return { text, annotations: [{ start: 0, end: phrase.length, source: { type: 'memory', id: firstId } }] };
    },
    isHardTopic: () => false,
  };
  return { ...base, ...overrides };
}

function candidates(...specs: Array<[string, number]>): CandidateEntity[] {
  return specs.map(([entityId, rank]) => ({ entityId, rank }));
}

describe('composeWalkQuestions (ASK-013 degraded v1)', () => {
  it('returns up to 7 questions in the ASK-013 output shape', async () => {
    const deps = makeDeps({
      selectCandidateEntities: async () =>
        candidates(['e1', 9], ['e2', 8], ['e3', 7], ['e4', 6], ['e5', 5], ['e6', 4], ['e7', 3], ['e8', 2]),
    });
    const qs = await composeWalkQuestions({ _deps: deps });

    expect(qs).toHaveLength(7); // MAX_QUEUE_TARGET cap even with 8 candidates
    for (const q of qs) {
      expect(typeof q.question_id).toBe('string');
      expect(q.question_id.length).toBeGreaterThan(0);
      expect(q.question_prose.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(q.annotations)).toBe(true); // bare array, never null
      expect(q.target_gap.type).toBe('missing_causal_edge');
      expect(q.target_gap.ghost_pattern_id.length).toBeGreaterThan(0);
      expect(q.target_gap.between_entity_ids.length).toBeGreaterThanOrEqual(1);
    }
    // question ids are unique
    expect(new Set(qs.map((q) => q.question_id)).size).toBe(qs.length);
  });

  it('ranks by topology (confidence) then recency (entity rank)', async () => {
    const deps = makeDeps({
      selectCandidateEntities: async () => candidates(['low', 100], ['high', 1]),
      findCausalGhosts: async (entityId: string) =>
        entityId === 'high' ? [makeGhost('p-high', 0.9)] : [makeGhost('p-low', 0.2)],
    });
    const qs = await composeWalkQuestions({ _deps: deps, limit: 2 });
    expect(qs.map((q) => q.target_gap.ghost_pattern_id)).toEqual(['p-high', 'p-low']);
  });

  it('never repeats a ghost pattern within one call', async () => {
    // e1 and e2 both surface the SAME pattern id — it must appear once.
    const deps = makeDeps({
      selectCandidateEntities: async () => candidates(['e1', 5], ['e2', 4]),
      findCausalGhosts: async () => [makeGhost('shared-pattern', 0.7)],
    });
    const qs = await composeWalkQuestions({ _deps: deps });
    expect(qs).toHaveLength(1);
    expect(qs[0]?.target_gap.ghost_pattern_id).toBe('shared-pattern');
  });

  it('respects excludeGhostPatternIds (the persisted per-session no-repeat set)', async () => {
    const deps = makeDeps({
      selectCandidateEntities: async () => candidates(['e1', 5], ['e2', 4]),
      findCausalGhosts: async (entityId: string) => [makeGhost(`p-${entityId}`, 0.5)],
    });
    const qs = await composeWalkQuestions({ _deps: deps, excludeGhostPatternIds: ['p-e1'] });
    expect(qs.map((q) => q.target_gap.ghost_pattern_id)).toEqual(['p-e2']);
  });

  it('drops hard-topic ghosts (never surfaced)', async () => {
    const deps = makeDeps({
      selectCandidateEntities: async () => candidates(['safe', 5], ['hard', 4]),
      isHardTopic: (_ghost, entityId) => entityId === 'hard',
    });
    const qs = await composeWalkQuestions({ _deps: deps });
    expect(qs).toHaveLength(1);
    expect(qs[0]?.target_gap.between_entity_ids).toEqual(['safe']);
  });

  it('skips a ghost whose focus entity has no readable source content', async () => {
    const deps = makeDeps({
      selectCandidateEntities: async () => candidates(['hasWords', 5], ['silent', 4]),
      getMemoryContent: async (memoryId: string) => (memoryId === 'm-silent' ? null : `words for ${memoryId}`),
    });
    const qs = await composeWalkQuestions({ _deps: deps });
    expect(qs).toHaveLength(1);
    expect(qs[0]?.target_gap.between_entity_ids).toEqual(['hasWords']);
  });

  it('drops out-of-bounds annotation spans (decoder invalidSpan guard)', async () => {
    const deps = makeDeps({
      selectCandidateEntities: async () => candidates(['e1', 5]),
      compose: async () => ({
        text: 'short prose',
        annotations: [
          { start: 0, end: 5, source: { type: 'memory', id: 'm-e1' } }, // in-bounds
          { start: 0, end: 999, source: { type: 'memory', id: 'm-e1' } }, // out-of-bounds → dropped
          { start: 0, end: 5, source: { type: 'memory', id: '' } }, // blank id → dropped
        ],
      }),
    });
    const qs = await composeWalkQuestions({ _deps: deps });
    expect(qs[0]?.annotations).toEqual([{ start: 0, end: 5, source: { type: 'memory', id: 'm-e1' } }]);
  });

  it('returns [] when there are no candidate entities (cold graph)', async () => {
    const deps = makeDeps({ selectCandidateEntities: async () => [] });
    const qs = await composeWalkQuestions({ _deps: deps });
    expect(qs).toEqual([]);
  });

  it('clamps limit to the 1..7 range', async () => {
    const many = candidates(...Array.from({ length: 10 }, (_, i) => [`e${i}`, 10 - i] as [string, number]));
    const deps = makeDeps({ selectCandidateEntities: async () => many });
    const over = await composeWalkQuestions({ _deps: deps, limit: 99 });
    expect(over).toHaveLength(7);
    const under = await composeWalkQuestions({ _deps: deps, limit: 0 }); // 0 → default 7
    expect(under).toHaveLength(7);
  });

  it('isolates a failing findCausalGhosts to its entity (does not sink the queue)', async () => {
    const deps = makeDeps({
      selectCandidateEntities: async () => candidates(['boom', 9], ['ok', 8]),
      findCausalGhosts: async (entityId: string) => {
        if (entityId === 'boom') throw new Error('ghost query exploded');
        return [makeGhost('p-ok', 0.5)];
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const qs = await composeWalkQuestions({ _deps: deps });
    warn.mockRestore();
    expect(qs.map((q) => q.target_gap.ghost_pattern_id)).toEqual(['p-ok']);
  });
});
