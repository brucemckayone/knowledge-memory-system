/**
 * Concept-layer symbolic-JOIN recall (bead nmemo-uhp.23).
 *
 * recallByConcept walks  code --exhibits--> concept <--addresses-- rule  over the
 * bridge_edges family and returns the rules sharing >=1 concept with a code
 * element, ranked by shared-concept count. This suite seeds a small 2-corpus
 * concept graph DIRECTLY (raw bridge_edges inserts — endpoints are validated at
 * disposal, not by FK, so no promotion round-trip is needed) and asserts the
 * JOIN's ranking, its concept-provenance array, expired-edge exclusion, the
 * rule-corpus filter, and the empty (pre-extraction) case.
 *
 * Spec: docs/architecture/cross-corpus-audit/19-concept-layer-design.md §3.3.
 * Reuses the shared harness (src/test/setup.ts). Migration 057 (bridge entity
 * kind + exhibits/addresses relations) is applied by global-setup.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { testDb } from './setup.js';
import { recallByConcept } from '../services/element-catalogs.js';

// Corpora owned exclusively by this suite. '_concepts' is the reserved shared
// concept corpus (mig 057) — no other suite populates it, so a full wipe is safe.
const CODE = 'cr_code';
const RULES = 'cr_rules';
const RULES_ALT = 'cr_rules_alt';
const CONCEPTS = '_concepts';

/** Insert an entity in a corpus (embedding omitted — the JOIN never reads it). */
async function ent(name: string, corpusId: string, entityType: string): Promise<string> {
  const rows = await testDb`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id)
    VALUES (${name}, ${entityType}, ${corpusId})
    RETURNING id::text AS id
  `;
  return (rows[0] as { id: string }).id;
}

/** Insert a bridge edge (element --relation--> concept). expiredAt !== null expires it. */
async function bridge(
  aRef: string,
  relation: 'exhibits' | 'addresses',
  conceptRef: string,
  sourceCorpusId: string,
  expiredAt: Date | null = null,
): Promise<void> {
  await testDb`
    INSERT INTO public.bridge_edges
      (a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation,
       reasoning, source_references, expired_at)
    VALUES
      ('entity', ${aRef}::uuid, 'entity', ${conceptRef}::uuid, ${sourceCorpusId}, ${CONCEPTS}, ${relation},
       ${relation + ' (test edge)'},
       ${testDb.json([{ type: 'code_element', id: aRef }])}::jsonb, ${expiredAt})
  `;
}

async function clean(): Promise<void> {
  for (const c of [CODE, RULES, RULES_ALT]) {
    await testDb`DELETE FROM public.bridge_edges WHERE source_corpus_id = ${c}`;
    await testDb`DELETE FROM public.entities WHERE corpus_id = ${c}`;
  }
  // Any bridge pointing at a concept + the concept entities themselves.
  await testDb`DELETE FROM public.bridge_edges WHERE target_corpus_id = ${CONCEPTS}`;
  await testDb`DELETE FROM public.entities WHERE corpus_id = ${CONCEPTS}`;
}

describe('recallByConcept — symbolic-JOIN cross-corpus recall (nmemo-uhp.23, doc-19 §3.3)', () => {
  beforeAll(async () => {
    // Fail loud if mig 057 did not land: bridge_edges must accept relation='exhibits'.
    const def = await testDb`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conname = 'valid_bridge_relation'
    `;
    const text = (def[0] as { def: string } | undefined)?.def ?? '';
    if (!text.includes('exhibits') || !text.includes('addresses')) {
      throw new Error('migration 057 not applied to the test DB (valid_bridge_relation lacks exhibits/addresses)');
    }
  });

  beforeEach(clean);

  it('ranks rules by shared-concept count and returns the shared concept ids', async () => {
    const codeA = await ent('codeA', CODE, 'code_element');
    const ruleX = await ent('ruleX', RULES, 'rule_element');
    const ruleY = await ent('ruleY', RULES, 'rule_element');
    const ruleZ = await ent('ruleZ', RULES, 'rule_element'); // shares nothing with codeA
    const heap = await ent('heap-allocation', CONCEPTS, 'concept');
    const owner = await ent('ownership-transfer', CONCEPTS, 'concept');
    const lock = await ent('lock-discipline', CONCEPTS, 'concept');

    // codeA exhibits {heap, owner}
    await bridge(codeA, 'exhibits', heap, CODE);
    await bridge(codeA, 'exhibits', owner, CODE);
    // ruleX addresses {heap}; ruleY addresses {heap, owner}; ruleZ addresses {lock}
    await bridge(ruleX, 'addresses', heap, RULES);
    await bridge(ruleY, 'addresses', heap, RULES);
    await bridge(ruleY, 'addresses', owner, RULES);
    await bridge(ruleZ, 'addresses', lock, RULES);

    const hits = await recallByConcept(codeA);

    // ruleY (2 shared) ranks above ruleX (1 shared); ruleZ absent (0 shared).
    expect(hits.map((h) => h.ruleElementRef)).toEqual([ruleY, ruleX]);
    expect(hits[0]!.sharedConcepts).toBe(2);
    expect(hits[1]!.sharedConcepts).toBe(1);
    // provenance: ruleY shares both concepts, ruleX shares only heap.
    expect([...hits[0]!.conceptRefs].sort()).toEqual([heap, owner].sort());
    expect(hits[1]!.conceptRefs).toEqual([heap]);
  });

  it('returns [] for a code element with no exhibits edges (pre-extraction)', async () => {
    const codeBare = await ent('codeBare', CODE, 'code_element');
    expect(await recallByConcept(codeBare)).toEqual([]);
  });

  it('excludes expired edges from the JOIN', async () => {
    const codeA = await ent('codeA', CODE, 'code_element');
    const ruleY = await ent('ruleY', RULES, 'rule_element');
    const heap = await ent('heap-allocation', CONCEPTS, 'concept');
    const owner = await ent('ownership-transfer', CONCEPTS, 'concept');

    await bridge(codeA, 'exhibits', heap, CODE);
    await bridge(codeA, 'exhibits', owner, CODE, new Date()); // EXPIRED exhibits
    await bridge(ruleY, 'addresses', heap, RULES);
    await bridge(ruleY, 'addresses', owner, RULES);

    // Only the live heap link contributes ⇒ 1 shared concept, not 2.
    const hits = await recallByConcept(codeA);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ruleElementRef).toBe(ruleY);
    expect(hits[0]!.sharedConcepts).toBe(1);
    expect(hits[0]!.conceptRefs).toEqual([heap]);
  });

  it('scopes to opts.ruleCorpusId when given', async () => {
    const codeA = await ent('codeA', CODE, 'code_element');
    const ruleStd = await ent('ruleStd', RULES, 'rule_element');
    const ruleAlt = await ent('ruleAlt', RULES_ALT, 'rule_element');
    const heap = await ent('heap-allocation', CONCEPTS, 'concept');

    await bridge(codeA, 'exhibits', heap, CODE);
    await bridge(ruleStd, 'addresses', heap, RULES);
    await bridge(ruleAlt, 'addresses', heap, RULES_ALT);

    // Unfiltered: both rule corpora match.
    const all = await recallByConcept(codeA);
    expect(all.map((h) => h.ruleElementRef).sort()).toEqual([ruleStd, ruleAlt].sort());

    // Filtered to RULES: only ruleStd.
    const scoped = await recallByConcept(codeA, { ruleCorpusId: RULES });
    expect(scoped.map((h) => h.ruleElementRef)).toEqual([ruleStd]);
  });

  it('honours opts.k as a row cap', async () => {
    const codeA = await ent('codeA', CODE, 'code_element');
    const heap = await ent('heap-allocation', CONCEPTS, 'concept');
    await bridge(codeA, 'exhibits', heap, CODE);
    for (let i = 0; i < 3; i++) {
      const rule = await ent(`rule${i}`, RULES, 'rule_element');
      await bridge(rule, 'addresses', heap, RULES);
    }
    expect(await recallByConcept(codeA, { k: 2 })).toHaveLength(2);
    expect(await recallByConcept(codeA)).toHaveLength(3);
  });
});
