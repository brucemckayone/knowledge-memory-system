/**
 * Concept extraction (bead nmemo-uhp.21, doc-19 §3.4).
 *
 * Pure coercion/normalization + an integration case driven by a STUBBED generator
 * (no LLM): extract on both sides, verify exhibits/addresses bridges land on
 * concept nodes in '_concepts', find-or-create dedups a shared concept to ONE
 * node, reasoning + source_references are present (non-negotiable), and the whole
 * thing composes with recallByConcept (nmemo-uhp.23) — a code element and a rule
 * that name the same mechanism become JOIN-connected end to end.
 *
 * Reuses the shared harness (src/test/setup.ts). Migration 057 is applied by
 * global-setup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { testDb } from './setup.js';
import {
  coerceConceptLabels,
  normalizeConceptName,
  findOrCreateConcept,
  extractAndLinkConcepts,
  CONCEPT_CORPUS,
} from '../services/concept-extraction.js';
import { recallByConcept } from '../services/element-catalogs.js';

const CODE = 'ce_code';
const RULES = 'ce_rules';

/** A generator stub that returns a fixed concept set regardless of prompt. */
function stub(concepts: Array<{ name: string; reason?: string }>) {
  return async (): Promise<unknown> => ({ concepts });
}

async function ent(name: string, corpusId: string, entityType: string): Promise<string> {
  const r = await testDb`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id)
    VALUES (${name}, ${entityType}, ${corpusId})
    RETURNING id::text AS id
  `;
  return (r[0] as { id: string }).id;
}

/**
 * Cleanup, scoped to THIS test's corpora.
 *
 * It previously deleted every bridge targeting `_concepts` and every `_concepts` entity.
 * `_concepts` is a GLOBAL corpus shared by every other corpus (doc 19 D-C2), so that wiped
 * unrelated work in the same database — it destroyed the doc-20 concept graph (97 exhibits
 * + 51 addresses) that doc-33's substrate gate depends on, and the entity DELETE then threw
 * on an `entity_merges` FK, leaving the damage half-applied because each statement commits
 * on its own. Now: only bridges from this test's corpora, and only concept nodes left
 * orphaned by that (plus their merge-audit rows, which are what blocked the delete).
 */
async function clean(): Promise<void> {
  for (const c of [CODE, RULES]) {
    await testDb`DELETE FROM public.bridge_edges WHERE source_corpus_id = ${c}`;
    await testDb`DELETE FROM public.staging_bridge_edges WHERE source_corpus_id = ${c}`;
    await testDb`DELETE FROM public.entities WHERE corpus_id = ${c}`;
  }
  // Orphaned concepts only: no live bridge from ANY corpus still points at them.
  await testDb`
    DELETE FROM public.entity_merges
    WHERE target_entity_id IN (
            SELECT id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS}
            AND id NOT IN (SELECT b_ref FROM public.bridge_edges WHERE b_ref IS NOT NULL))
       OR source_entity_id IN (
            SELECT id FROM public.entities WHERE corpus_id = ${CONCEPT_CORPUS}
            AND id NOT IN (SELECT b_ref FROM public.bridge_edges WHERE b_ref IS NOT NULL))
  `;
  await testDb`
    DELETE FROM public.entities
    WHERE corpus_id = ${CONCEPT_CORPUS}
      AND id NOT IN (SELECT b_ref FROM public.bridge_edges WHERE b_ref IS NOT NULL)
      AND id NOT IN (SELECT target_entity_id FROM public.entity_merges WHERE target_entity_id IS NOT NULL)
      AND id NOT IN (SELECT source_entity_id FROM public.entity_merges WHERE source_entity_id IS NOT NULL)
  `;
}

describe('concept extraction (nmemo-uhp.21, doc-19 §3.4)', () => {
  beforeEach(clean);

  // ── pure helpers ─────────────────────────────────────────────────────────
  it('normalizeConceptName lowercases, trims, collapses whitespace', () => {
    expect(normalizeConceptName('  Heap   Allocation ')).toBe('heap allocation');
    expect(normalizeConceptName('Ownership-Transfer')).toBe('ownership-transfer');
  });

  it('coerceConceptLabels dedups by normalized name, drops empties, never throws', () => {
    const labels = coerceConceptLabels({
      concepts: [
        { name: 'heap-allocation', reason: 'calls new[]' },
        { name: 'Heap-Allocation', reason: 'dup, dropped' }, // dup after normalize
        { name: '', reason: 'no name, dropped' },
        { name: 'recursion' }, // no reason → empty string
        'garbage',
      ],
    });
    expect(labels.map((l) => l.name)).toEqual(['heap-allocation', 'recursion']);
    expect(labels[0]!.reason).toBe('calls new[]');
    expect(labels[1]!.reason).toBe('');
    expect(coerceConceptLabels(null)).toEqual([]);
    expect(coerceConceptLabels({ concepts: 'nope' })).toEqual([]);
  });

  // ── find-or-create ─────────────────────────────────────────────────────────
  it('findOrCreateConcept is idempotent by normalized name', async () => {
    const a = await findOrCreateConcept('Heap-Allocation');
    const b = await findOrCreateConcept('heap-allocation'); // same after normalize
    expect(b).toBe(a);
    const rows = await testDb`
      SELECT count(*)::int AS n FROM public.entities
      WHERE corpus_id = ${CONCEPT_CORPUS} AND entity_type = 'concept' AND lower(canonical_name) = 'heap-allocation'
    `;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  // ── extraction + linking, closing the loop with recallByConcept ─────────────
  it('links exhibits/addresses bridges to concepts; a shared concept JOIN-connects code↔rule', async () => {
    const code = await ent('vector_in_isr', CODE, 'code_element');
    const rule = await ent('Rule 22.1', RULES, 'rule_element');

    const codeRes = await extractAndLinkConcepts({
      elementEntityId: code, corpusId: CODE, side: 'code', name: 'vector_in_isr', text: 'std::vector<int> v; v.push_back(x);',
      generate: stub([
        { name: 'heap-allocation', reason: 'std::vector allocates on the heap' },
        { name: 'dynamic-container', reason: 'uses a growable container' },
      ]),
    });
    const ruleRes = await extractAndLinkConcepts({
      elementEntityId: rule, corpusId: RULES, side: 'rule', name: 'Rule 22.1', text: 'No dynamic memory allocation in safety-critical code.',
      generate: stub([{ name: 'Heap-Allocation', reason: 'the rule forbids heap use' }]), // same concept, different casing
    });

    expect(codeRes.linked).toBe(2);
    expect(ruleRes.linked).toBe(1);

    // find-or-create dedup: code's 'heap-allocation' and rule's 'Heap-Allocation'
    // resolve to the SAME concept node.
    const sharedConcept = ruleRes.conceptIds[0]!;
    expect(codeRes.conceptIds).toContain(sharedConcept);

    // exhibits edges from code, addresses edge from rule, all reasoned + sourced.
    const codeEdges = await testDb`
      SELECT relation, reasoning, source_references FROM public.bridge_edges
      WHERE a_ref = ${code}::uuid AND expired_at IS NULL
    `;
    expect(codeEdges).toHaveLength(2);
    for (const e of codeEdges as Array<{ relation: string; reasoning: string; source_references: unknown }>) {
      expect(e.relation).toBe('exhibits');
      expect(e.reasoning.length).toBeGreaterThan(0);
      expect(Array.isArray(e.source_references)).toBe(true);
      expect((e.source_references as unknown[]).length).toBeGreaterThanOrEqual(1);
    }
    const ruleEdges = await testDb`
      SELECT relation FROM public.bridge_edges WHERE a_ref = ${rule}::uuid AND expired_at IS NULL
    `;
    expect(ruleEdges).toHaveLength(1);
    expect((ruleEdges[0] as { relation: string }).relation).toBe('addresses');

    // END-TO-END: the symbolic JOIN now connects the code element to the rule.
    const hits = await recallByConcept(code, { ruleCorpusId: RULES });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ruleElementRef).toBe(rule);
    expect(hits[0]!.sharedConcepts).toBe(1);
    expect(hits[0]!.conceptRefs).toEqual([sharedConcept]);
  });

  it('synthesises reasoning when the model returns none (bridge CHECK never rejects)', async () => {
    const code = await ent('f', CODE, 'code_element');
    const res = await extractAndLinkConcepts({
      elementEntityId: code, corpusId: CODE, side: 'code', name: 'f', text: 'void f(){}',
      generate: stub([{ name: 'empty-body' }]), // no reason
    });
    expect(res.linked).toBe(1);
    const edges = await testDb`SELECT reasoning FROM public.bridge_edges WHERE a_ref = ${code}::uuid`;
    expect((edges[0] as { reasoning: string }).reasoning).toContain('empty-body');
  });

  it('no usable concepts ⇒ no bridges, no promotion', async () => {
    const code = await ent('g', CODE, 'code_element');
    const res = await extractAndLinkConcepts({
      elementEntityId: code, corpusId: CODE, side: 'code', name: 'g', text: 'void g(){}',
      generate: stub([]),
    });
    expect(res).toMatchObject({ linked: 0, conceptIds: [], labels: [] });
    const edges = await testDb`SELECT 1 FROM public.bridge_edges WHERE a_ref = ${code}::uuid`;
    expect(edges).toHaveLength(0);
  });
});
