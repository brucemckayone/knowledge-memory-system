/**
 * Pure-planner unit tests (doc 41 §5, §10; bead nmemo-vpz.3 / E3). Zero infra —
 * runs under vitest.unit.config.ts. The headline is the doc-38 litmus proven by
 * construction: planPromotion(forward) deep-equals planPromotion(reverse).
 */

import { describe, it, expect } from 'vitest';
import {
  planPromotion,
  normalizeName,
  escalationKey,
  type PriorCanonical,
  type StagedProposals,
  type StagedEntity,
  type StagedFact,
  type IdentityVerdict,
  type ConflictVerdict,
} from '../../services/promotion-plan.js';

const EMPTY_PRIOR: PriorCanonical = { entities: [], activeFacts: [] };

let seq = 0;
const id = (p: string): string => `${p}-${String(seq++).padStart(4, '0')}`;

function ent(name: string, type = 'organization', anchor?: string): StagedEntity {
  return { handle: id('h'), name, type, summary: null, anchorCanonicalId: anchor ?? null };
}
function fact(
  subjectHandle: string,
  predicate: string,
  opts: Partial<StagedFact> & ({ objectHandle: string } | { objectValue: string }),
): StagedFact {
  const validAt = opts.validAt ?? null;
  return {
    stagedFactId: id('sf'),
    subjectHandle,
    predicate,
    objectHandle: 'objectHandle' in opts ? opts.objectHandle ?? null : null,
    objectValue: 'objectValue' in opts ? opts.objectValue ?? null : null,
    validAt,
    undated: validAt == null,
    chunkIndex: opts.chunkIndex ?? null,
    confidence: opts.confidence ?? 0.9,
    reasoning: opts.reasoning ?? 'r',
    exclusiveGroup: opts.exclusiveGroup ?? null,
    supersedesFactId: opts.supersedesFactId ?? null,
  };
}

describe('normalizeName', () => {
  it('lowercases, trims, collapses whitespace, strips honorifics', () => {
    expect(normalizeName('  Dr.  Elena   Vasquez ')).toBe('elena vasquez');
    expect(normalizeName('Helix Robotics')).toBe('helix robotics');
    expect(normalizeName('helix.')).toBe('helix');
  });
});

describe('planPromotion — entity resolution (step a)', () => {
  it('merges helix / helix-robotics fresh duplicates into one entity (nmemo-wyb)', () => {
    const helix = ent('Helix');
    const helixRobotics = ent('Helix Robotics');
    // A fact on the merged cluster keeps it from being orphan-pruned (step e).
    const plan = planPromotion(EMPTY_PRIOR, {
      entities: [helix, helixRobotics],
      facts: [fact(helix.handle, 'founded_in', { objectValue: '2015' })],
    });
    expect(plan.entitiesToMint).toHaveLength(1);
    expect(plan.entitiesToMint[0]!.memberHandles.sort()).toEqual([helix.handle, helixRobotics.handle].sort());
    // Display name is the most specific member.
    expect(plan.entitiesToMint[0]!.name).toBe('helix robotics');
  });

  it('does NOT merge a non-word-prefix lookalike (helix vs helixology)', () => {
    const helix = ent('Helix');
    const helixology = ent('Helixology');
    const plan = planPromotion(EMPTY_PRIOR, {
      entities: [helix, helixology],
      facts: [
        fact(helix.handle, 'founded_in', { objectValue: '2015' }),
        fact(helixology.handle, 'founded_in', { objectValue: '2016' }),
      ],
    });
    expect(plan.entitiesToMint).toHaveLength(2);
  });

  it('anchored proposals inherit their canonical id; peers align', () => {
    const anchored = ent('Helix Robotics', 'organization', 'canon-helix');
    const peer = ent('Helix Robotics'); // unanchored, same name
    const plan = planPromotion(EMPTY_PRIOR, { entities: [anchored, peer], facts: [] });
    // Both resolve to the anchored canonical id — nothing minted.
    expect(plan.entitiesToMint).toHaveLength(0);
  });

  it('resolves a fresh cluster to a prior canonical entity by word-prefix', () => {
    const prior: PriorCanonical = {
      entities: [{ id: 'canon-helix', name: 'Helix Robotics', type: 'organization' }],
      activeFacts: [],
    };
    const plan = planPromotion(prior, { entities: [ent('Helix')], facts: [] });
    expect(plan.entitiesToMint).toHaveLength(0); // resolved to prior, not minted
  });

  it('escalates (identity) and keeps distinct when a name prefixes TWO distinct priors', () => {
    const prior: PriorCanonical = {
      entities: [
        { id: 'canon-a', name: 'Helix Robotics', type: 'organization' },
        { id: 'canon-b', name: 'Helix Biosciences', type: 'organization' },
      ],
      activeFacts: [],
    };
    const helix = ent('Helix');
    const plan = planPromotion(prior, {
      entities: [helix],
      facts: [fact(helix.handle, 'founded_in', { objectValue: '2015' })],
    });
    expect(plan.escalations).toHaveLength(1);
    expect(plan.escalations[0]!.kind).toBe('identity');
    // Conservative default: minted as its own fresh entity, not guessed.
    expect(plan.entitiesToMint).toHaveLength(1);
  });
});

describe('planPromotion — supersession (step c)', () => {
  it('keeps the latest-valid fact active in an exclusive group; expires/deactivates the rest', () => {
    const helix = ent('Helix');
    const boston = fact(helix.handle, 'headquartered_in', {
      objectValue: 'Boston',
      validAt: new Date('2020-01-01'),
      exclusiveGroup: 'location',
    });
    const austin = fact(helix.handle, 'relocated_to', {
      objectValue: 'Austin',
      validAt: new Date('2023-01-01'),
      exclusiveGroup: 'location',
    });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix], facts: [boston, austin] });
    const byId = new Map(plan.factsToInsert.map((f) => [f.stagedFactId, f]));
    expect(byId.get(austin.stagedFactId)!.active).toBe(true);
    expect(byId.get(boston.stagedFactId)!.active).toBe(false);
    expect(byId.get(boston.stagedFactId)!.expireReason).toContain('location');
  });

  it('expires a prior-canonical active when a later-valid proposal supersedes it', () => {
    const prior: PriorCanonical = {
      entities: [{ id: 'canon-helix', name: 'Helix', type: 'organization' }],
      activeFacts: [
        {
          id: 'prior-hq',
          subjectEntityId: 'canon-helix',
          predicate: 'headquartered_in',
          objectEntityId: null,
          objectValue: 'Boston',
          validAt: new Date('2019-01-01'),
          confidence: 1,
        },
      ],
    };
    const helix = ent('Helix', 'organization', 'canon-helix');
    const austin = fact(helix.handle, 'headquartered_in', {
      objectValue: 'Austin',
      validAt: new Date('2024-01-01'),
      exclusiveGroup: 'location',
    });
    const plan = planPromotion(prior, { entities: [helix], facts: [austin] });
    expect(plan.factsToExpire.map((e) => e.factId)).toContain('prior-hq');
    expect(plan.factsToInsert.find((f) => f.stagedFactId === austin.stagedFactId)!.active).toBe(true);
  });
});

describe('planPromotion — triple dedup (step d) + self-loops (step e)', () => {
  it('collapses identical triples into one fact with the duplicates folded in', () => {
    const helix = ent('Helix');
    const f1 = fact(helix.handle, 'founded_in', { objectValue: '2015', confidence: 0.8 });
    const f2 = fact(helix.handle, 'founded_in', { objectValue: '2015', confidence: 0.95 });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix], facts: [f1, f2] });
    expect(plan.factsToInsert).toHaveLength(1);
    expect(plan.factsToInsert[0]!.confidence).toBe(0.95); // max
    expect(plan.factsToInsert[0]!.corroboratesStagedFactIds).toHaveLength(1);
  });

  it('drops a self-loop fact AND the now-factless mint as an orphan (§11 I7)', () => {
    const helix = ent('Helix');
    const helix2 = ent('Helix Robotics'); // merges with helix → same entity
    const loop = fact(helix.handle, 'partner_of', { objectHandle: helix2.handle });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix, helix2], facts: [loop] });
    expect(plan.droppedSelfLoops).toContain(loop.stagedFactId);
    expect(plan.factsToInsert).toHaveLength(0);
    // The merged cluster's only fact was the dropped self-loop → no surviving fact,
    // so promotion drops the mint rather than create a factless orphan.
    expect(plan.entitiesToMint).toHaveLength(0);
    expect(plan.droppedOrphanEntities).toHaveLength(1);
  });

  it('keeps a minted entity that survives only via an inactive (superseded) fact', () => {
    // An entity whose facts all LOST group supersession is still referenced by the
    // inserted (inactive) facts — it is NOT an orphan.
    const helix = ent('Helix');
    const boston = fact(helix.handle, 'headquartered_in', { objectValue: 'Boston', validAt: new Date('2020-01-01'), exclusiveGroup: 'location' });
    const austin = fact(helix.handle, 'relocated_to', { objectValue: 'Austin', validAt: new Date('2023-01-01'), exclusiveGroup: 'location' });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix], facts: [boston, austin] });
    expect(plan.entitiesToMint).toHaveLength(1);
    expect(plan.droppedOrphanEntities).toHaveLength(0);
  });

  it('keeps a minted entity referenced ONLY as a fact object (objectRef.kind===cluster)', () => {
    // The orphan oracle reads BOTH subjectRef and objectRef (promotion-plan.ts:793-794).
    // The objectRef clause is load-bearing: an entity whose sole appearance is as the
    // OBJECT of a surviving fact must NOT be pruned. Mint Helix (subject) + Ada (object
    // only) via `Helix employs Ada`; both must survive, nothing dropped. Removing the
    // objectRef clause would drop Ada and fail this — a direct mutation-kill.
    const helix = ent('Helix');
    const ada = ent('Ada', 'person');
    const employs = fact(helix.handle, 'employs', { objectHandle: ada.handle });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix, ada], facts: [employs] });
    expect(plan.factsToInsert).toHaveLength(1);
    expect(plan.entitiesToMint).toHaveLength(2);
    expect(plan.droppedOrphanEntities).toHaveLength(0);
  });

  it('drops a fresh mint proposed with NO fact at all as an orphan (§11 I7, bare path)', () => {
    // The simplest and most common orphan trigger (promotion-plan.ts:783 "proposed with
    // no fact at all"): a fresh, non-anchored, non-merging entity staged with zero facts
    // is minted then pruned. Asserted directly here rather than only via the self-loop
    // sub-case above.
    const plan = planPromotion(EMPTY_PRIOR, { entities: [ent('Orphan')], facts: [] });
    expect(plan.entitiesToMint).toHaveLength(0);
    expect(plan.droppedOrphanEntities).toHaveLength(1);
  });
});

describe('planPromotion — chunk_index ordering (E4, doc 41 §5c)', () => {
  it('undated facts in an exclusive group order by chunkIndex (later chunk wins)', () => {
    const helix = ent('Helix');
    // both undated (no validAt) — ordering must fall back to chunkIndex
    const early = fact(helix.handle, 'headquartered_in', { objectValue: 'Boston', chunkIndex: 0, exclusiveGroup: 'location' });
    const late = fact(helix.handle, 'relocated_to', { objectValue: 'Austin', chunkIndex: 3, exclusiveGroup: 'location' });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix], facts: [early, late] });
    const byId = new Map(plan.factsToInsert.map((f) => [f.stagedFactId, f]));
    expect(byId.get(late.stagedFactId)!.active).toBe(true); // higher chunkIndex = later narration
    expect(byId.get(early.stagedFactId)!.active).toBe(false);
  });

  it('a dated fact beats an undated peer regardless of chunk order', () => {
    const helix = ent('Helix');
    const undatedLater = fact(helix.handle, 'headquartered_in', { objectValue: 'Boston', chunkIndex: 9, exclusiveGroup: 'location' });
    const datedEarlier = fact(helix.handle, 'relocated_to', { objectValue: 'Austin', validAt: new Date('2010-01-01'), chunkIndex: 0, exclusiveGroup: 'location' });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix], facts: [undatedLater, datedEarlier] });
    const byId = new Map(plan.factsToInsert.map((f) => [f.stagedFactId, f]));
    expect(byId.get(datedEarlier.stagedFactId)!.active).toBe(true); // dated beats undated even from an earlier chunk
    expect(byId.get(undatedLater.stagedFactId)!.active).toBe(false);
  });

  it('dated facts order by valid_at, NOT by chunk order (ordering LOCKED)', () => {
    const helix = ent('Helix');
    // later valid_at sits in an EARLIER chunk — valid_at must still win
    const olderValid = fact(helix.handle, 'headquartered_in', { objectValue: 'Boston', validAt: new Date('2020-01-01'), chunkIndex: 9, exclusiveGroup: 'location' });
    const newerValid = fact(helix.handle, 'relocated_to', { objectValue: 'Austin', validAt: new Date('2023-01-01'), chunkIndex: 0, exclusiveGroup: 'location' });
    const plan = planPromotion(EMPTY_PRIOR, { entities: [helix], facts: [olderValid, newerValid] });
    const byId = new Map(plan.factsToInsert.map((f) => [f.stagedFactId, f]));
    expect(byId.get(newerValid.stagedFactId)!.active).toBe(true); // later valid_at wins despite earlier chunk
    expect(byId.get(olderValid.stagedFactId)!.active).toBe(false);
  });
});

describe('planPromotion — supersession hints (E4, doc 41 §4)', () => {
  it('records an AGREED hint when the deterministic order also expires the flagged prior fact', () => {
    const prior: PriorCanonical = {
      entities: [{ id: 'canon-helix', name: 'Helix', type: 'organization' }],
      activeFacts: [
        { id: 'prior-hq', subjectEntityId: 'canon-helix', predicate: 'headquartered_in', objectEntityId: null, objectValue: 'Boston', validAt: new Date('2019-01-01'), confidence: 1 },
      ],
    };
    const helix = ent('Helix', 'organization', 'canon-helix');
    const austin = fact(helix.handle, 'headquartered_in', {
      objectValue: 'Austin', validAt: new Date('2024-01-01'), exclusiveGroup: 'location', supersedesFactId: 'prior-hq',
    });
    const plan = planPromotion(prior, { entities: [helix], facts: [austin] });
    expect(plan.factsToExpire.map((e) => e.factId)).toContain('prior-hq');
    expect(plan.supersessionHints).toEqual([
      { stagedFactId: austin.stagedFactId, supersedesFactId: 'prior-hq', agreed: true },
    ]);
  });

  it('records a DISAGREED hint without overriding valid_at (the hint loses to the order)', () => {
    const prior: PriorCanonical = {
      entities: [{ id: 'canon-helix', name: 'Helix', type: 'organization' }],
      activeFacts: [
        { id: 'prior-hq', subjectEntityId: 'canon-helix', predicate: 'headquartered_in', objectEntityId: null, objectValue: 'Austin', validAt: new Date('2024-01-01'), confidence: 1 },
      ],
    };
    const helix = ent('Helix', 'organization', 'canon-helix');
    // The proposer claims to supersede the prior, but its fact is OLDER — valid_at wins.
    const boston = fact(helix.handle, 'headquartered_in', {
      objectValue: 'Boston', validAt: new Date('2019-01-01'), exclusiveGroup: 'location', supersedesFactId: 'prior-hq',
    });
    const plan = planPromotion(prior, { entities: [helix], facts: [boston] });
    expect(plan.factsToExpire.map((e) => e.factId)).not.toContain('prior-hq'); // prior stays active
    expect(plan.factsToInsert.find((f) => f.stagedFactId === boston.stagedFactId)!.active).toBe(false);
    expect(plan.supersessionHints).toEqual([
      { stagedFactId: boston.stagedFactId, supersedesFactId: 'prior-hq', agreed: false },
    ]);
  });
});

describe('planPromotion — order independence (doc 38 litmus, doc 41 §10)', () => {
  function scenario(): StagedProposals {
    seq = 0; // reset id counter so forward/reverse build IDENTICAL ids
    const elena = ent('Elena', 'person');
    const elenaV = ent('Dr. Elena Vasquez', 'person'); // → 'elena vasquez', merges with elena
    const helix = ent('Helix', 'organization');
    const helixR = ent('Helix Robotics', 'organization');
    const facts: StagedFact[] = [
      fact(elena.handle, 'works_at', { objectHandle: helix.handle, validAt: new Date('2021-06-01') }),
      fact(elena.handle, 'job_title', { objectValue: 'Engineer', validAt: new Date('2021-01-01'), exclusiveGroup: 'role_title' }),
      fact(elenaV.handle, 'has_role', { objectValue: 'CTO', validAt: new Date('2023-01-01'), exclusiveGroup: 'role_title' }),
      fact(helixR.handle, 'headquartered_in', { objectValue: 'Boston', validAt: new Date('2020-01-01'), exclusiveGroup: 'location' }),
      fact(helix.handle, 'relocated_to', { objectValue: 'Austin', validAt: new Date('2022-01-01'), exclusiveGroup: 'location' }),
      // duplicate triple (corroboration)
      fact(elena.handle, 'works_at', { objectHandle: helix.handle, validAt: new Date('2021-06-01') }),
    ];
    return { entities: [elena, elenaV, helix, helixR], facts };
  }

  it('plan(forward) deep-equals plan(reverse)', () => {
    const forward = scenario();
    const forwardPlan = planPromotion(EMPTY_PRIOR, forward);

    const reverseInput = scenario();
    reverseInput.entities.reverse();
    reverseInput.facts.reverse();
    const reversePlan = planPromotion(EMPTY_PRIOR, reverseInput);

    expect(reversePlan).toEqual(forwardPlan);
  });

  it('the settled graph has exactly one active role_title and one active location for the merged subjects', () => {
    const plan = planPromotion(EMPTY_PRIOR, scenario());
    const activeRole = plan.factsToInsert.filter((f) => f.exclusiveGroup === 'role_title' && f.active);
    const activeLoc = plan.factsToInsert.filter((f) => f.exclusiveGroup === 'location' && f.active);
    expect(activeRole).toHaveLength(1);
    expect(activeRole[0]!.objectValue).toBe('CTO'); // latest valid
    expect(activeLoc).toHaveLength(1);
    expect(activeLoc[0]!.objectValue).toBe('Austin'); // latest valid
  });
});

// ============================================
// E5 — verdict-aware re-plan (doc 41 §8a.5, §12 #4)
// ============================================

/** Two distinct priors a short cluster name word-prefixes → an identity escalation. */
const TWO_HELIX_PRIORS: PriorCanonical = {
  entities: [
    { id: 'canon-a', name: 'Helix Robotics', type: 'organization' },
    { id: 'canon-b', name: 'Helix Biosciences', type: 'organization' },
  ],
  activeFacts: [],
};

describe('planPromotion — identity verdicts (E5)', () => {
  it('MERGE: binds the cluster to the target and plans the other candidate as an entity merge', () => {
    const helix = ent('Helix');
    const someFact = fact(helix.handle, 'founded_in', { objectValue: '2015' });
    const staged: StagedProposals = { entities: [helix], facts: [someFact] };

    // Pass 1 surfaces the escalation; we derive the verdict against its key (the
    // exact round-trip a recorded verdict + replay use — criterion 3).
    const pass1 = planPromotion(TWO_HELIX_PRIORS, staged);
    const esc = pass1.escalations.find((e) => e.kind === 'identity')!;
    expect(esc).toBeDefined();
    expect(esc.kind === 'identity' && esc.candidateIds).toEqual(['canon-a', 'canon-b']);

    const verdict: IdentityVerdict = {
      kind: 'identity',
      escalationKey: escalationKey(esc),
      members: ['canon-a', 'canon-b'],
      decision: 'merge',
      canonicalTarget: 'canon-a',
      reasoning: 'Same org; Biosciences is a former name',
    };
    const pass2 = planPromotion(TWO_HELIX_PRIORS, staged, [verdict]);

    expect(pass2.escalations).toHaveLength(0); // resolved, not re-escalated
    expect(pass2.entitiesToMint).toHaveLength(0); // bound to canon-a, not minted fresh
    expect(pass2.entityMerges).toEqual([
      { sourceId: 'canon-b', targetId: 'canon-a', reason: verdict.reasoning },
    ]);
    expect(pass2.sameAsLinks).toHaveLength(0);
    // The cluster's fact now points at the survivor.
    expect(pass2.factsToInsert[0]!.subjectRef).toEqual({ kind: 'canonical', id: 'canon-a' });
  });

  it('SAME_AS: binds to the target and plans a same_as link, no merge', () => {
    const helix = ent('Helix');
    const staged: StagedProposals = { entities: [helix], facts: [] };
    const pass1 = planPromotion(TWO_HELIX_PRIORS, staged);
    const esc = pass1.escalations.find((e) => e.kind === 'identity')!;
    const verdict: IdentityVerdict = {
      kind: 'identity',
      escalationKey: escalationKey(esc),
      members: ['canon-a', 'canon-b'],
      decision: 'same_as',
      canonicalTarget: 'canon-a',
      reasoning: 'Closely related but kept as separate rows',
    };
    const pass2 = planPromotion(TWO_HELIX_PRIORS, staged, [verdict]);
    expect(pass2.escalations).toHaveLength(0);
    expect(pass2.entityMerges).toHaveLength(0);
    expect(pass2.sameAsLinks).toEqual([
      { entityAId: 'canon-a', entityBId: 'canon-b', reason: verdict.reasoning },
    ]);
  });

  it('DISTINCT: suppresses the escalation and keeps the cluster fresh (mints a new entity)', () => {
    const helix = ent('Helix');
    const staged: StagedProposals = {
      entities: [helix],
      facts: [fact(helix.handle, 'founded_in', { objectValue: '2015' })],
    };
    const pass1 = planPromotion(TWO_HELIX_PRIORS, staged);
    const esc = pass1.escalations.find((e) => e.kind === 'identity')!;
    const verdict: IdentityVerdict = {
      kind: 'identity',
      escalationKey: escalationKey(esc),
      members: ['canon-a', 'canon-b'],
      decision: 'distinct',
      canonicalTarget: null,
      reasoning: 'A genuinely new third Helix',
    };
    const pass2 = planPromotion(TWO_HELIX_PRIORS, staged, [verdict]);
    expect(pass2.escalations).toHaveLength(0); // verdict consumed it
    expect(pass2.entitiesToMint).toHaveLength(1); // minted distinct
    expect(pass2.entityMerges).toHaveLength(0);
    expect(pass2.sameAsLinks).toHaveLength(0);
  });
});

describe('planPromotion — conflict verdicts (E5)', () => {
  /** Equal valid_at + both undated chunkIndex, different object → an unbreakable conflict. */
  function equalValidConflict(): { staged: StagedProposals; boston: StagedFact; austin: StagedFact } {
    const helix = ent('Helix');
    const sameDay = new Date('2022-01-01');
    const boston = fact(helix.handle, 'headquartered_in', { objectValue: 'Boston', validAt: sameDay, exclusiveGroup: 'location' });
    const austin = fact(helix.handle, 'headquartered_in', { objectValue: 'Austin', validAt: sameDay, exclusiveGroup: 'location' });
    return { staged: { entities: [helix], facts: [boston, austin] }, boston, austin };
  }

  it('pass 1 records a conflict escalation (co-equal facts, different objects)', () => {
    const { staged } = equalValidConflict();
    const plan = planPromotion(EMPTY_PRIOR, staged);
    const esc = plan.escalations.find((e) => e.kind === 'conflict');
    expect(esc).toBeDefined();
  });

  it('EXPIRE: the arbiter expires the loser, keeps the winner active, no re-escalation', () => {
    const { staged, boston, austin } = equalValidConflict();
    const esc = planPromotion(EMPTY_PRIOR, staged).escalations.find((e) => e.kind === 'conflict')!;
    const verdict: ConflictVerdict = {
      kind: 'conflict',
      escalationKey: escalationKey(esc),
      expire: [{ factId: boston.stagedFactId, reason: 'Austin is the current HQ per the source' }],
      correctedValidAt: null,
      notExclusive: false,
      reasoning: 'Austin wins',
    };
    const plan = planPromotion(EMPTY_PRIOR, staged, [verdict]);
    expect(plan.escalations).toHaveLength(0);
    const byId = new Map(plan.factsToInsert.map((f) => [f.stagedFactId, f]));
    expect(byId.get(austin.stagedFactId)!.active).toBe(true);
    expect(byId.get(boston.stagedFactId)!.active).toBe(false);
    expect(byId.get(boston.stagedFactId)!.expireReason).toContain('Austin is the current HQ');
  });

  it('NOT_EXCLUSIVE: the arbiter keeps BOTH facts active', () => {
    const { staged, boston, austin } = equalValidConflict();
    const esc = planPromotion(EMPTY_PRIOR, staged).escalations.find((e) => e.kind === 'conflict')!;
    const verdict: ConflictVerdict = {
      kind: 'conflict',
      escalationKey: escalationKey(esc),
      expire: [],
      correctedValidAt: null,
      notExclusive: true,
      reasoning: 'Two simultaneous offices — not mutually exclusive',
    };
    const plan = planPromotion(EMPTY_PRIOR, staged, [verdict]);
    expect(plan.escalations).toHaveLength(0);
    const byId = new Map(plan.factsToInsert.map((f) => [f.stagedFactId, f]));
    expect(byId.get(austin.stagedFactId)!.active).toBe(true);
    expect(byId.get(boston.stagedFactId)!.active).toBe(true); // both kept
  });

  it('CORRECTED_VALID_AT: a date correction is applied to the surviving fact', () => {
    const { staged, boston, austin } = equalValidConflict();
    const esc = planPromotion(EMPTY_PRIOR, staged).escalations.find((e) => e.kind === 'conflict')!;
    const corrected = '2024-06-01T00:00:00.000Z';
    const verdict: ConflictVerdict = {
      kind: 'conflict',
      escalationKey: escalationKey(esc),
      expire: [{ factId: boston.stagedFactId, reason: 'Boston predates the move' }],
      correctedValidAt: { [austin.stagedFactId]: corrected },
      notExclusive: false,
      reasoning: 'Austin move was actually mid-2024',
    };
    const plan = planPromotion(EMPTY_PRIOR, staged, [verdict]);
    const austinPlanned = plan.factsToInsert.find((f) => f.stagedFactId === austin.stagedFactId)!;
    expect(austinPlanned.active).toBe(true);
    expect(austinPlanned.validAt!.toISOString()).toBe(corrected);
  });
});

describe('planPromotion — verdict re-plan stays order-independent (litmus)', () => {
  it('plan(forward, verdicts) deep-equals plan(reverse, verdicts)', () => {
    const verdict: IdentityVerdict = {
      kind: 'identity',
      escalationKey: 'identity|organization|helix',
      members: ['canon-a', 'canon-b'],
      decision: 'merge',
      canonicalTarget: 'canon-a',
      reasoning: 'same',
    };
    const build = (): StagedProposals => {
      seq = 0; // identical handle ids forward vs reverse
      return { entities: [ent('Helix'), ent('Acme'), ent('Helix')], facts: [] };
    };
    const fwd = planPromotion(TWO_HELIX_PRIORS, build(), [verdict]);
    const rev = build();
    rev.entities.reverse();
    const revPlan = planPromotion(TWO_HELIX_PRIORS, rev, [verdict]);
    expect(revPlan).toEqual(fwd);
  });
});
