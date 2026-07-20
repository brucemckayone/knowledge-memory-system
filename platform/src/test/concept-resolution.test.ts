/**
 * Concept resolution (bead nmemo-uhp.22, doc-19 §3.5).
 *
 * Trigram candidate-discovery + an (injectable) equivalence judge + mergeEntities.
 * Verifies: lexical variants of one mechanism merge to a single node; a trigram
 * lookalike the judge REJECTS stays separate; and the mergeEntities bridge
 * re-point (extended for .22) carries exhibits/addresses edges to the survivor
 * with dedup-before-repoint (nmemo-9vk discipline) — no partial-unique throw — so
 * the concept JOIN stays intact end to end.
 *
 * Judge + generator are stubbed → no LLM. Migration 057 applied by global-setup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb } from './setup.js';
import { findOrCreateConcept, CONCEPT_CORPUS } from '../services/concept-extraction.js';
import { discoverConceptCandidates, resolveConcepts } from '../services/concept-resolution.js';
import { recallByConcept } from '../services/element-catalogs.js';

const CODE = 'cres_code';
const RULES = 'cres_rules';

/** Stub judge: strip hyphens/spaces and compare — merges format variants, rejects
 *  trigram-lookalikes that differ substantively (buffer-overflow vs -underflow). */
const stripJudge = async (a: string, b: string): Promise<boolean> =>
  a.replace(/[\s-]/g, '') === b.replace(/[\s-]/g, '');

async function ent(name: string, corpusId: string, entityType: string): Promise<string> {
  const r = await testDb`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id)
    VALUES (${name}, ${entityType}, ${corpusId}) RETURNING id::text AS id
  `;
  return (r[0] as { id: string }).id;
}

async function exhibits(elementId: string, conceptId: string, corpusId: string, relation: 'exhibits' | 'addresses'): Promise<void> {
  await testDb`
    INSERT INTO public.bridge_edges
      (a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
    VALUES ('entity', ${elementId}::uuid, 'entity', ${conceptId}::uuid, ${corpusId}, ${CONCEPT_CORPUS}, ${relation},
            ${relation + ' (test)'}, ${testDb.json([{ type: 'entity', id: elementId }])}::jsonb)
  `;
}

async function conceptCount(name: string): Promise<number> {
  const r = await testDb`
    SELECT count(*)::int AS n FROM public.entities
    WHERE corpus_id = ${CONCEPT_CORPUS} AND entity_type = 'concept' AND canonical_name = ${name}
  `;
  return (r[0] as { n: number }).n;
}

async function clean(): Promise<void> {
  // Clear merge/alias audit that a prior resolveConcepts merge left on the concept
  // entities (entity_merges.target_entity_id FK is RESTRICT — a raw entity DELETE is
  // blocked otherwise; production re-points these via mergeEntities, not raw delete).
  await testDb`
    DELETE FROM public.entity_merges
    WHERE source_entity_id IN (SELECT id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS})
       OR target_entity_id IN (SELECT id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS})
  `;
  for (const c of [CODE, RULES]) {
    await testDb`DELETE FROM public.bridge_edges WHERE source_corpus_id = ${c}`;
    await testDb`DELETE FROM public.entities WHERE corpus_id = ${c}`;
  }
  await testDb`DELETE FROM public.bridge_edges WHERE target_corpus_id = ${CONCEPT_CORPUS}`;
  await testDb`DELETE FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS}`;
}

describe('concept resolution (nmemo-uhp.22, doc-19 §3.5)', () => {
  beforeEach(clean);

  it('discovers lexically-similar concept pairs, ignores dissimilar', async () => {
    await findOrCreateConcept('heap-allocation');
    await findOrCreateConcept('heap allocation');
    await findOrCreateConcept('recursion'); // lexically unrelated

    const pairs = await discoverConceptCandidates(0.3, 100);
    const names = pairs.map((p) => [p.aName, p.bName].sort().join('|'));
    expect(names).toContain(['heap allocation', 'heap-allocation'].sort().join('|'));
    // 'recursion' shares no trigrams with the heap names ⇒ never paired.
    expect(pairs.some((p) => p.aName === 'recursion' || p.bName === 'recursion')).toBe(false);
  });

  it('merges judge-confirmed variants, rejects judge-declined lookalikes, keeps the JOIN intact', async () => {
    const heapHyphen = await findOrCreateConcept('heap-allocation');
    const heapSpace = await findOrCreateConcept('heap allocation'); // same mechanism, format variant
    await findOrCreateConcept('buffer-overflow');
    await findOrCreateConcept('buffer-underflow'); // trigram-close but DIFFERENT

    // A code element exhibits BOTH heap variants (→ post-merge dedup must collapse
    // to one live edge); a rule addresses one of them.
    const code = await ent('alloc_fn', CODE, 'code_element');
    const rule = await ent('Rule 22.1', RULES, 'rule_element');
    await exhibits(code, heapHyphen, CODE, 'exhibits');
    await exhibits(code, heapSpace, CODE, 'exhibits');
    await exhibits(rule, heapSpace, RULES, 'addresses');

    const res = await resolveConcepts({ threshold: 0.3, judge: stripJudge });

    // Exactly one heap merge; buffer pair surfaced but rejected.
    expect(res.merged).toBe(1);
    expect(res.judgedSame).toBe(1);
    expect(res.pairsConsidered).toBeGreaterThanOrEqual(2); // heap pair + buffer pair

    // One heap-* node survives; buffer-overflow and buffer-underflow both remain.
    const heapHyphenLeft = await conceptCount('heap-allocation');
    const heapSpaceLeft = await conceptCount('heap allocation');
    expect(heapHyphenLeft + heapSpaceLeft).toBe(1); // exactly one survivor
    expect(await conceptCount('buffer-overflow')).toBe(1);
    expect(await conceptCount('buffer-underflow')).toBe(1);

    // The survivor is whichever heap id still exists.
    const survivorRows = await testDb`
      SELECT id::text AS id FROM public.entities
      WHERE corpus_id = ${CONCEPT_CORPUS} AND canonical_name IN ('heap-allocation', 'heap allocation')
    `;
    expect(survivorRows).toHaveLength(1);
    const survivor = (survivorRows[0] as { id: string }).id;

    // mergeEntities bridge re-point + dedup: the code's TWO exhibits edges (to the
    // two heap variants) collapse to ONE live edge pointing at the survivor.
    const codeEdges = await testDb`
      SELECT b_ref::text AS b_ref FROM public.bridge_edges
      WHERE a_ref = ${code}::uuid AND relation = 'exhibits' AND expired_at IS NULL
    `;
    expect(codeEdges).toHaveLength(1);
    expect((codeEdges[0] as { b_ref: string }).b_ref).toBe(survivor);

    // END-TO-END: the JOIN still connects code → rule through the survivor concept.
    const hits = await recallByConcept(code, { ruleCorpusId: RULES });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ruleElementRef).toBe(rule);
    expect(hits[0]!.conceptRefs).toEqual([survivor]);
  });

  it('no candidates ⇒ no merges', async () => {
    await findOrCreateConcept('recursion');
    await findOrCreateConcept('lock-discipline');
    const res = await resolveConcepts({ threshold: 0.4, judge: stripJudge });
    expect(res).toMatchObject({ merged: 0, judgedSame: 0 });
  });
});
