/**
 * Pure-planner unit tests for causal-promotion (doc 41 §6, §8a.6, §12 #5; bead
 * nmemo-vpz.6 / E6). Zero infra — runs under vitest.unit.config.ts. Exercises the
 * disposal rules: ref-resolve drop, self-loop drop, the cited-fact branch
 * (superseded → keep, invalidated → flag stale_citation, never auto-repoint), the
 * missing-fact-as-invalidated default, dedup pass-through, and the doc-01 invariant.
 */

import { describe, it, expect } from 'vitest';
import {
  planCausalPromotion,
  type StagedCausalEdge,
  type CitedFactStatus,
} from '../../services/causal-promotion-plan.js';
import type { SourceReference } from '../../services/audit.js';

let seq = 0;
const uid = (p: string): string => `${p}-${String(seq++).padStart(4, '0')}`;

function memRef(): SourceReference {
  return { type: 'memory', id: uid('mem'), relevance: 'narrates the transition' };
}
function factRef(id: string): SourceReference {
  return { type: 'fact', id, relevance: 'asserts the cited claim' };
}

function edge(
  cause: string,
  effect: string,
  opts: { stagedEdgeId?: string; reasoning?: string; sourceReferences?: SourceReference[] } = {},
): StagedCausalEdge {
  return {
    stagedEdgeId: opts.stagedEdgeId ?? uid('sce'),
    causeEventId: cause,
    effectEventId: effect,
    reasoning: opts.reasoning ?? 'Series B funding enabled the HQ relocation',
    sourceReferences: opts.sourceReferences ?? [memRef()],
  };
}

const settled = (...ids: string[]): Set<string> => new Set(ids);
const statuses = (m: Record<string, CitedFactStatus>): Map<string, CitedFactStatus> =>
  new Map(Object.entries(m));

describe('planCausalPromotion — ref-resolve (rule 1)', () => {
  it('drops an edge whose cause event is not settled', () => {
    const plan = planCausalPromotion([edge('ev-missing', 'ev-b')], settled('ev-b'), statuses({}));
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0]!.reason).toContain('cause ev-missing');
  });

  it('drops an edge whose effect event is not settled', () => {
    const plan = planCausalPromotion([edge('ev-a', 'ev-missing')], settled('ev-a'), statuses({}));
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.dropped[0]!.reason).toContain('effect ev-missing');
  });

  it('keeps an edge when BOTH endpoints are settled', () => {
    const plan = planCausalPromotion([edge('ev-a', 'ev-b')], settled('ev-a', 'ev-b'), statuses({}));
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.dropped).toHaveLength(0);
  });
});

describe('planCausalPromotion — self-loop (rule 2)', () => {
  it('drops cause == effect even when settled', () => {
    const plan = planCausalPromotion([edge('ev-a', 'ev-a')], settled('ev-a'), statuses({}));
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.dropped[0]!.reason).toContain('self-loop');
  });
});

describe('planCausalPromotion — cited-fact branch (rule 3)', () => {
  it('superseded cited fact → KEEP, no stale flag (the past event is still real)', () => {
    const e = edge('ev-a', 'ev-b', { sourceReferences: [memRef(), factRef('fact-sup')] });
    const plan = planCausalPromotion([e], settled('ev-a', 'ev-b'), statuses({ 'fact-sup': 'superseded' }));
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]!.staleCitation).toBe(false);
    expect(plan.toCreate[0]!.staleCitationReason).toBeNull();
  });

  it('active cited fact → KEEP, no stale flag', () => {
    const e = edge('ev-a', 'ev-b', { sourceReferences: [factRef('fact-ok')] });
    const plan = planCausalPromotion([e], settled('ev-a', 'ev-b'), statuses({ 'fact-ok': 'active' }));
    expect(plan.toCreate[0]!.staleCitation).toBe(false);
  });

  it('invalidated cited fact → KEEP + flag stale_citation, naming the fact', () => {
    const e = edge('ev-a', 'ev-b', { sourceReferences: [memRef(), factRef('fact-bad')] });
    const plan = planCausalPromotion([e], settled('ev-a', 'ev-b'), statuses({ 'fact-bad': 'invalidated' }));
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toCreate[0]!.staleCitation).toBe(true);
    expect(plan.toCreate[0]!.staleCitationReason).toContain('fact-bad');
  });

  it('NEVER auto-repoints — cause/effect ids are unchanged on a stale edge', () => {
    const e = edge('ev-a', 'ev-b', { sourceReferences: [factRef('fact-bad')] });
    const plan = planCausalPromotion([e], settled('ev-a', 'ev-b'), statuses({ 'fact-bad': 'invalidated' }));
    expect(plan.toCreate[0]!.causeEventId).toBe('ev-a');
    expect(plan.toCreate[0]!.effectEventId).toBe('ev-b');
  });

  it('a cited fact absent from the status map (vanished) → treated as invalidated', () => {
    const e = edge('ev-a', 'ev-b', { sourceReferences: [factRef('fact-gone')] });
    const plan = planCausalPromotion([e], settled('ev-a', 'ev-b'), statuses({}));
    expect(plan.toCreate[0]!.staleCitation).toBe(true);
    expect(plan.toCreate[0]!.staleCitationReason).toContain('fact-gone');
  });

  it('invalidated wins over superseded when an edge cites both', () => {
    const e = edge('ev-a', 'ev-b', {
      sourceReferences: [factRef('fact-sup'), factRef('fact-bad')],
    });
    const plan = planCausalPromotion(
      [e],
      settled('ev-a', 'ev-b'),
      statuses({ 'fact-sup': 'superseded', 'fact-bad': 'invalidated' }),
    );
    expect(plan.toCreate[0]!.staleCitation).toBe(true);
    expect(plan.toCreate[0]!.staleCitationReason).toContain('fact-bad');
    expect(plan.toCreate[0]!.staleCitationReason).not.toContain('fact-sup');
  });
});

describe('planCausalPromotion — dedup is deferred to apply (createCausalEdge)', () => {
  it('passes two identical (cause,effect) edges through unchanged', () => {
    const e1 = edge('ev-a', 'ev-b', { stagedEdgeId: 'sce-dup-1' });
    const e2 = edge('ev-a', 'ev-b', { stagedEdgeId: 'sce-dup-2' });
    const plan = planCausalPromotion([e1, e2], settled('ev-a', 'ev-b'), statuses({}));
    expect(plan.toCreate).toHaveLength(2);
  });
});

describe('planCausalPromotion — invariant + determinism', () => {
  it('every planned edge carries the non-empty reasoning + source_references it was proposed with', () => {
    const e = edge('ev-a', 'ev-b', { reasoning: 'because X', sourceReferences: [memRef(), factRef('f1')] });
    const plan = planCausalPromotion([e], settled('ev-a', 'ev-b'), statuses({ f1: 'active' }));
    const p = plan.toCreate[0]!;
    expect(p.reasoning).toBe('because X');
    expect(p.sourceReferences.length).toBeGreaterThan(0);
  });

  it('toCreate is sorted by stagedEdgeId regardless of input order', () => {
    const a = edge('ev-a', 'ev-b', { stagedEdgeId: 'sce-aaa' });
    const z = edge('ev-a', 'ev-b', { stagedEdgeId: 'sce-zzz' });
    const forward = planCausalPromotion([a, z], settled('ev-a', 'ev-b'), statuses({}));
    const reverse = planCausalPromotion([z, a], settled('ev-a', 'ev-b'), statuses({}));
    expect(forward).toEqual(reverse);
    expect(forward.toCreate.map((p) => p.stagedEdgeId)).toEqual(['sce-aaa', 'sce-zzz']);
  });
});
