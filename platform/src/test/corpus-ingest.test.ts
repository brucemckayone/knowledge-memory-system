/**
 * Integration suite for cross-corpus element ingest (bead nmemo-uhp.17.3).
 *
 * Facet authoring is FAKED (a deterministic generator, no LLM) so the test is stable
 * and cheap, but embeddings are REAL (ml.embed / :8000) — the cross-corpus recall
 * smoke is only meaningful with real aligned vectors. Requires DB (:5433) + ML
 * (:8000), both wired by vitest.config.ts.
 *
 * Proves the plumbing doc 13 §5 promises: an ingested element becomes a
 * corpus-partitioned entity whose description IS the authored faceted text and whose
 * vector embeds name\ndescription; ingest is idempotent and corpus-SCOPED (no
 * cross-corpus fusion, unlike createEntity's global dedup); and the re-embed pass
 * recomputes vectors from current descriptions.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb } from './setup.js';
import {
  ingestCodeElement,
  ingestRuleElement,
  reembedCorpusDescriptions,
  upsertCorpusElementEntity,
} from '../services/corpus-ingest.js';
import { recallCrossCorpusCandidates } from '../services/audit-pass.js';
import type { FacetGenerator } from '../services/element-authoring.js';

// Corpus ids exclusive to this suite.
const CODE = 'ci_code';
const CODE2 = 'ci_code2';
const STD = 'ci_std';
const ALL = [CODE, CODE2, STD];

/** Deterministic fake generator returning a fixed JSON object (ignores the prompt). */
const gen = (json: unknown): FacetGenerator => () => Promise.resolve(json);

async function wipe(): Promise<void> {
  for (const c of ALL) await testDb`DELETE FROM public.entities WHERE corpus_id = ${c}`;
}

async function rowsInCorpus(corpusId: string): Promise<Array<{ id: string; canonical_name: string; entity_type: string; description: string | null; has_embedding: boolean }>> {
  return (await testDb`
    SELECT id::text AS id, canonical_name, entity_type, description, (embedding IS NOT NULL) AS has_embedding
    FROM public.entities WHERE corpus_id = ${corpusId} ORDER BY canonical_name
  `) as unknown as Array<{ id: string; canonical_name: string; entity_type: string; description: string | null; has_embedding: boolean }>;
}

beforeEach(wipe);
afterAll(wipe);

describe('ingestCodeElement', () => {
  it('creates a corpus-partitioned entity whose description is the faceted text, with an embedding', async () => {
    const result = await ingestCodeElement({
      corpusId: CODE,
      name: 'parseNumber',
      code: 'template<class T> bool parseNumber(std::string_view, T&);',
      generate: gen({
        operation: 'parses a text buffer into an arithmetic value',
        dataTypes: 'std::string_view, std::from_chars_result',
        concepts: ['std::from_chars', 'full-input consumption'],
      }),
    });

    expect(result.existed).toBe(false);
    expect(result.leakedReferences).toEqual([]);
    expect(result.description).toContain('operation: parses a text buffer');
    expect(result.description).toContain('concepts: std::from_chars, full-input consumption');

    const rows = await rowsInCorpus(CODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonical_name).toBe('parseNumber');
    expect(rows[0]!.entity_type).toBe('code_element');
    expect(rows[0]!.description).toBe(result.description);
    expect(rows[0]!.has_embedding).toBe(true);
  });

  it('is idempotent + corpus-scoped: re-ingest updates in place, never a duplicate', async () => {
    const first = await ingestCodeElement({
      corpusId: CODE, name: 'foo', code: 'int foo();',
      generate: gen({ operation: 'returns an int' }),
    });
    expect(first.existed).toBe(false);

    const second = await ingestCodeElement({
      corpusId: CODE, name: 'foo', code: 'int foo();',
      generate: gen({ operation: 'returns an int and logs a warning' }),
    });
    expect(second.existed).toBe(true);
    expect(second.entityId).toBe(first.entityId);

    const rows = await rowsInCorpus(CODE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toContain('logs a warning'); // refreshed
  });

  it('does NOT fuse two DISTINCT same-named elements in ONE corpus (nmemo-uhp.17.4 defect)', async () => {
    // Six ES.45 gate items literally shared the symbol name INITIAL_VARIANCE_SCALAR;
    // name-keyed dedup fused them to one entity and corrupted the recall gate. Identity
    // is the CODE CONTENT, so same name + different code must stay two entities.
    const a = await ingestCodeElement({
      corpusId: CODE, name: 'INITIAL_VARIANCE_SCALAR', code: 'constexpr double INITIAL_VARIANCE_SCALAR = 1.0e6; // position filter',
      generate: gen({ operation: 'position filter variance seed' }),
    });
    const b = await ingestCodeElement({
      corpusId: CODE, name: 'INITIAL_VARIANCE_SCALAR', code: 'constexpr double INITIAL_VARIANCE_SCALAR = 50.0; // clock filter',
      generate: gen({ operation: 'clock filter variance seed' }),
    });
    expect(b.existed).toBe(false);
    expect(b.entityId).not.toBe(a.entityId);
    expect(await rowsInCorpus(CODE)).toHaveLength(2);

    // …but re-ingesting the SAME code is still idempotent (content key stable).
    const aAgain = await ingestCodeElement({
      corpusId: CODE, name: 'INITIAL_VARIANCE_SCALAR', code: 'constexpr double INITIAL_VARIANCE_SCALAR = 1.0e6; // position filter',
      generate: gen({ operation: 'position filter variance seed' }),
    });
    expect(aAgain.existed).toBe(true);
    expect(aAgain.entityId).toBe(a.entityId);
    expect(await rowsInCorpus(CODE)).toHaveLength(2);
  });

  it('does NOT fuse a same-named element across corpora (createEntity dedup is global; this is not)', async () => {
    const a = await ingestCodeElement({
      corpusId: CODE, name: 'shared', code: 'void shared();',
      generate: gen({ operation: 'variant A' }),
    });
    const b = await ingestCodeElement({
      corpusId: CODE2, name: 'shared', code: 'void shared();',
      generate: gen({ operation: 'variant B' }),
    });
    expect(b.entityId).not.toBe(a.entityId);
    expect(await rowsInCorpus(CODE)).toHaveLength(1);
    expect(await rowsInCorpus(CODE2)).toHaveLength(1);
  });
});

describe('ingestRuleElement', () => {
  it('creates a rule entity in the target corpus; a same-named code element stays distinct', async () => {
    await ingestCodeElement({
      corpusId: CODE, name: 'C.12', code: 'struct S { const int id; };',
      generate: gen({ operation: 'a struct with a const member' }),
    });
    const rule = await ingestRuleElement({
      corpusId: STD, ruleId: 'C.12', ruleText: 'Do not make data members const in a copyable type.',
      generate: gen({ rationale: 'A const member deletes copy/move assignment.', concepts: ['const member'] }),
    });

    expect(rule.existed).toBe(false);
    const codeRows = await rowsInCorpus(CODE);
    const stdRows = await rowsInCorpus(STD);
    expect(codeRows).toHaveLength(1);
    expect(stdRows).toHaveLength(1);
    expect(codeRows[0]!.entity_type).toBe('code_element');
    expect(stdRows[0]!.entity_type).toBe('rule');
    expect(codeRows[0]!.id).not.toBe(stdRows[0]!.id);
  });
});

describe('reembedCorpusDescriptions', () => {
  it('recomputes embeddings for described entities and skips description-less rows', async () => {
    // A described entity (via the corpus-scoped upsert) …
    await upsertCorpusElementEntity({ corpusId: CODE, name: 'described', type: 'code_element', description: 'operation: does a thing' });
    // … and a name-only entity with no description (nothing to re-embed).
    await testDb`
      INSERT INTO public.entities (canonical_name, entity_type, corpus_id, confidence)
      VALUES ('nameonly', 'code_element', ${CODE}, 1.0)
    `;

    const result = await reembedCorpusDescriptions(CODE);
    expect(result.reembedded).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

describe('cross-corpus recall smoke (real embeddings)', () => {
  it('recallCrossCorpusCandidates surfaces the aligned code→rule pair', async () => {
    await ingestCodeElement({
      corpusId: CODE, name: 'derefPtr',
      code: 'int derefPtr(int* p){ return *p; }',
      generate: gen({
        operation: 'dereferences a raw pointer and returns the pointee',
        memoryPointers: 'dereferences a raw int pointer without a null check',
        errorHandling: 'none; undefined behaviour if the pointer is null',
        concepts: ['raw pointer', 'null pointer dereference', 'undefined behaviour'],
      }),
    });
    const rule = await ingestRuleElement({
      corpusId: STD, ruleId: 'PTR.null',
      ruleText: 'A raw pointer must be checked for null before it is dereferenced.',
      generate: gen({
        rationale: 'Dereferencing a null raw pointer is undefined behaviour.',
        watchFor: 'A raw pointer dereferenced without a preceding null check.',
        concepts: ['raw pointer', 'null pointer dereference', 'undefined behaviour'],
      }),
    });

    const candidates = await recallCrossCorpusCandidates(CODE, STD, { k: 5, threshold: 0.4 });
    const hit = candidates.find((c) => c.ruleId === rule.entityId);
    expect(hit, `expected the pointer rule in the recall set; got ${JSON.stringify(candidates)}`).toBeTruthy();
  });
});
