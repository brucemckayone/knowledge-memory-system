/**
 * Cross-corpus Phase A acceptance suite (bead nmemo-uhp.11).
 *
 * Validates the committed Phase A implementation (migrations 052–055 +
 * services entities/facts/promotion/graph-meta/contradictions/element-catalogs/
 * bridge-promotion/corpus-policy) against docs/architecture/cross-corpus-audit/
 * 04-hardened-spec.md §5 (acceptance tests 3–7).
 *
 * Technique: embeddings are FORCED directly (identical / controlled vectors
 * written straight to pgvector), so no ML service / Ollama is required. Similarity
 * is verified with cosineSimilarity from the shared harness.
 *
 * Reuses the shared harness (src/test/setup.ts): testDb, normalizeVector,
 * randomEmbedding, cosineSimilarity, randomUUID. Migrations 052–055 are applied
 * by global-setup (it runs every *.sql in src/db/migrations in order).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  testDb,
  randomEmbedding,
  normalizeVector,
  cosineSimilarity,
  randomUUID,
  hasVectorExtension,
} from './setup.js';
import { findSimilarEntities } from '../services/entities.js';
import { detectMergeCandidates } from '../services/graph-meta.js';
import { upsertCodeElement, upsertRuleElement } from '../services/element-catalogs.js';
import { applyBridgePromotion } from '../services/bridge-promotion.js';
import { getCorpusPolicy, setCorpusPolicy } from '../services/corpus-policy.js';

// Corpus ids owned exclusively by this suite (no other test file uses them).
// 'default' is left alone — mig 055 seeds it assimilating.
const CORPORA = ['code', 'std', 'cmp'] as const;

/**
 * Dig the Postgres SQLSTATE out of an error regardless of whether it is a raw
 * postgres.js PostgresError (testDb path) or a drizzle-wrapped error (service
 * `db.execute` path, which may nest the driver error under `.cause`).
 */
function pgCode(e: unknown): string | undefined {
  const anyE = e as { code?: string; cause?: { code?: string } };
  return anyE?.code ?? anyE?.cause?.code;
}

function pgText(e: unknown): string {
  const anyE = e as { detail?: string; message?: string; cause?: { detail?: string; message?: string } };
  return anyE?.detail ?? anyE?.cause?.detail ?? anyE?.message ?? anyE?.cause?.message ?? String(e);
}

/** Insert an entity in a specific corpus with a forced embedding. */
async function createCorpusEntity(
  name: string,
  corpusId: string,
  embedding: number[],
  entityType = 'concept',
): Promise<string> {
  const embStr = `[${embedding.join(',')}]`;
  const rows = await testDb`
    INSERT INTO public.entities (canonical_name, entity_type, corpus_id, embedding)
    VALUES (${name}, ${entityType}, ${corpusId}, ${embStr}::vector)
    RETURNING id
  `;
  return (rows[0] as { id: string }).id;
}

/** Seed entity_meta so an entity is eligible for detectMergeCandidates. */
async function seedEntityMeta(entityId: string, centroid: number[]): Promise<void> {
  const cStr = `[${centroid.join(',')}]`;
  await testDb`
    INSERT INTO public.entity_meta (entity_id, mention_count, source_memory_count, fact_count, centroid)
    VALUES (${entityId}::uuid, 3, 2, 0, ${cStr}::vector)
    ON CONFLICT (entity_id) DO UPDATE SET
      centroid = EXCLUDED.centroid,
      mention_count = EXCLUDED.mention_count
  `;
}

/** Wipe every cross-corpus artefact this suite creates, FK-order-respecting. */
async function cleanCrossCorpus(): Promise<void> {
  // bridge family first (bridge_source_refs cascade from bridge_edges). These
  // tables are exclusive to this suite, so a full wipe is safe.
  await testDb`DELETE FROM public.bridge_source_refs`;
  await testDb`DELETE FROM public.bridge_edges`;
  await testDb`DELETE FROM public.staging_bridge_edges`;
  for (const c of CORPORA) {
    await testDb`DELETE FROM public.merge_candidates WHERE corpus_id = ${c}`;
    await testDb`DELETE FROM public.entity_meta WHERE entity_id IN (SELECT id FROM public.entities WHERE corpus_id = ${c})`;
    // merge_candidates written by upsertScoredCandidates default corpus_id='default'
    // even for non-default entities (see the writer-bug finding) — wipe those by
    // entity membership too so a bugged prior run doesn't leak into the next test.
    await testDb`DELETE FROM public.merge_candidates WHERE entity_a_id IN (SELECT id FROM public.entities WHERE corpus_id = ${c}) OR entity_b_id IN (SELECT id FROM public.entities WHERE corpus_id = ${c})`;
    await testDb`DELETE FROM public.facts WHERE corpus_id = ${c}`;
    await testDb`DELETE FROM public.code_elements WHERE corpus_id = ${c}`;
    await testDb`DELETE FROM public.rule_elements WHERE corpus_id = ${c}`;
    await testDb`DELETE FROM public.element_embeddings WHERE corpus_id = ${c}`;
    await testDb`DELETE FROM public.corpus_policies WHERE corpus_id = ${c}`;
    await testDb`DELETE FROM public.entities WHERE corpus_id = ${c}`;
  }
}

describe('cross-corpus Phase A acceptance (nmemo-uhp.11, spec §5 tests 3–7)', () => {
  beforeAll(async () => {
    if (!hasVectorExtension) {
      throw new Error('pgvector required for the cross-corpus suite (embeddings are forced directly)');
    }
    // Fail loud & clear if migrations 052–055 did not land in the test DB.
    const present = await testDb`
      SELECT
        (SELECT count(*) FROM information_schema.columns WHERE table_name='entities' AND column_name='corpus_id') AS entities_corpus,
        (SELECT count(*) FROM information_schema.tables  WHERE table_name='code_elements')   AS code_elements,
        (SELECT count(*) FROM information_schema.tables  WHERE table_name='bridge_edges')    AS bridge_edges,
        (SELECT count(*) FROM information_schema.tables  WHERE table_name='corpus_policies') AS corpus_policies,
        (SELECT count(*) FROM information_schema.columns WHERE table_name='merge_candidates' AND column_name='corpus_id') AS mc_corpus
    `;
    const p = present[0] as Record<string, number>;
    const missing = Object.entries(p).filter(([, v]) => Number(v) === 0).map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `cross-corpus migrations 052–055 not applied to the test DB (missing: ${missing.join(', ')}). ` +
        `Ensure global-setup ran the migration dir.`,
      );
    }
  });

  beforeEach(cleanCrossCorpus);

  // ── Case 1 (spec test 3) — printf cross-corpus non-fusion ────────────────

  it('1a. guard #1: findSimilarEntities is corpus-scoped; same-corpus still fuses', async () => {
    const emb = normalizeVector(randomEmbedding());
    // Identical vectors ⇒ cosine 1.0 (trivially > the 0.92 fusion-demo bar).
    expect(cosineSimilarity(emb, emb)).toBeGreaterThan(0.92);

    const codeId = await createCorpusEntity('printf', 'code', emb);
    const stdId = await createCorpusEntity('printf', 'std', emb);
    const code3Id = await createCorpusEntity('printf', 'code', emb); // same-corpus dup

    // corpusId='code' returns ONLY code entities — the std printf is absent (guard #1).
    const codeHits = await findSimilarEntities(emb, { corpusId: 'code', limit: 20, threshold: 0.5 });
    const codeIds = codeHits.map((h) => h.id);
    expect(codeIds).toContain(codeId);
    expect(codeIds).toContain(code3Id); // same-corpus duplicate still fuses (regression)
    expect(codeIds).not.toContain(stdId); // cross-corpus std NOT returned

    // corpusId='std' returns ONLY the std printf.
    const stdHits = await findSimilarEntities(emb, { corpusId: 'std', limit: 20, threshold: 0.5 });
    const stdIds = stdHits.map((h) => h.id);
    expect(stdIds).toContain(stdId);
    expect(stdIds).not.toContain(codeId);
    expect(stdIds).not.toContain(code3Id);
  });

  it('1b. guard #3: detectMergeCandidates never enumerates a cross-corpus pair', async () => {
    const emb = normalizeVector(randomEmbedding());
    const codeId = await createCorpusEntity('printf', 'code', emb);
    const stdId = await createCorpusEntity('printf', 'std', emb);
    const code3Id = await createCorpusEntity('printf', 'code', emb);

    // Make the same-corpus 'code' pair AND the std entity all merge-eligible.
    await seedEntityMeta(codeId, emb);
    await seedEntityMeta(code3Id, emb);
    await seedEntityMeta(stdId, emb);

    let threw: unknown = null;
    let written = 0;
    try {
      written = await detectMergeCandidates([codeId, stdId], 'code');
    } catch (e) {
      threw = e;
    }

    // GUARD #3 (primary — always holds): the gardener NEVER proposes a candidate
    // that pairs the code entity with the std entity. The eligibility query is
    // corpus-scoped, so the cross-corpus pair is never even enumerated.
    const cross = await testDb`
      SELECT 1 FROM public.merge_candidates
      WHERE (entity_a_id=${codeId}::uuid AND entity_b_id=${stdId}::uuid)
         OR (entity_a_id=${stdId}::uuid  AND entity_b_id=${codeId}::uuid)
    `;
    expect(cross).toHaveLength(0);

    // NON-VACUITY + FINDING: the gardener DID reach the same-corpus (code,code3)
    // pair. Either it persisted that candidate (guard scopes correctly AND the
    // writer sets corpus_id) OR it hit the composite-FK 23503 — because
    // upsertScoredCandidates omits corpus_id, so a non-default merge_candidates
    // row defaults corpus_id='default' and the (entity, 'default') FK rejects it.
    // Both prove the cross pair was excluded (the error is about the code pair,
    // never stdId). A silent no-op would fail here.
    if (threw) {
      expect(pgCode(threw)).toBe('23503');
      expect(pgText(threw)).not.toContain(stdId); // FK error is about the code pair
    } else {
      expect(written).toBeGreaterThanOrEqual(1);
      const same = await testDb`
        SELECT 1 FROM public.merge_candidates
        WHERE (entity_a_id=${codeId}::uuid AND entity_b_id=${code3Id}::uuid)
           OR (entity_a_id=${code3Id}::uuid AND entity_b_id=${codeId}::uuid)
      `;
      expect(same).toHaveLength(1);
    }
  });

  // ── Case 2 (spec test 3) — composite-FK backstop ─────────────────────────

  it('2. composite-FK rejects a cross-corpus merge_candidates insert (23503)', async () => {
    const emb = normalizeVector(randomEmbedding());
    const codeId = await createCorpusEntity('foo', 'code', emb);
    const stdId = await createCorpusEntity('foo', 'std', emb);

    // LEAST/GREATEST satisfies the entity_a_id < entity_b_id CHECK (per Postgres's
    // own uuid ordering) so it is the composite FK — not the ordering CHECK — that
    // fails. With corpus_id='code', the std entity's (id,'code') is absent ⇒ 23503.
    let threw: unknown = null;
    try {
      await testDb`
        INSERT INTO public.merge_candidates (entity_a_id, entity_b_id, combined_score, corpus_id)
        VALUES (LEAST(${codeId}::uuid, ${stdId}::uuid), GREATEST(${codeId}::uuid, ${stdId}::uuid), 0.9, 'code')
      `;
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    expect(pgCode(threw)).toBe('23503');
  });

  // ── Case 3 (spec test 3, D9) — corpus immutability ───────────────────────

  it('3. D9: UPDATE entities SET corpus_id is rejected by the immutability trigger', async () => {
    const emb = normalizeVector(randomEmbedding());
    const codeId = await createCorpusEntity('bar', 'code', emb);

    let threw: unknown = null;
    try {
      await testDb`UPDATE public.entities SET corpus_id = 'std' WHERE id = ${codeId}::uuid`;
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    // Trigger raises with ERRCODE = 'check_violation' (23514).
    expect(pgCode(threw)).toBe('23514');

    // corpus_id is unchanged.
    const after = await testDb`SELECT corpus_id FROM public.entities WHERE id = ${codeId}::uuid`;
    expect((after[0] as { corpus_id: string }).corpus_id).toBe('code');
  });

  // ── Case 4 (spec test 4) — bridge round-trip ─────────────────────────────

  it('4. bridge round-trip: stage → apply → query → expire; empty reasoning rejected', async () => {
    const invocationId = randomUUID();
    const codeRef = (await upsertCodeElement({ corpusId: 'code', scipSymbol: 'scip:printf#', filePath: 'a.c', lineStart: 1, lineEnd: 2 })).elementRef;
    const ruleRef = await upsertRuleElement({ corpusId: 'std', ruleId: 'C.printf.format' });

    await testDb`
      INSERT INTO public.staging_bridge_edges
        (invocation_id, a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
      VALUES
        (${invocationId}::uuid, 'code_element', ${codeRef}::uuid, 'rule_element', ${ruleRef}::uuid,
         'code', 'std', 'violates', 'printf format string is attacker-controlled',
         ${testDb.json([{ type: 'code_element', id: codeRef }])}::jsonb)
    `;

    const res = await applyBridgePromotion(invocationId);
    expect(res.created).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
    const edgeId = res.created[0]!.edgeId;

    // one canonical bridge_edges row with matching endpoints
    const edges = await testDb`
      SELECT id::text AS id, a_ref::text AS a_ref, b_ref::text AS b_ref, relation
      FROM public.bridge_edges WHERE id = ${edgeId}::uuid
    `;
    expect(edges).toHaveLength(1);
    expect((edges[0] as { a_ref: string }).a_ref).toBe(codeRef);
    expect((edges[0] as { b_ref: string }).b_ref).toBe(ruleRef);
    expect((edges[0] as { relation: string }).relation).toBe('violates');

    // source_references denormalised into bridge_source_refs
    const refs = await testDb`
      SELECT ref_type, ref_id FROM public.bridge_source_refs WHERE bridge_edge_id = ${edgeId}::uuid
    `;
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some((r) => r.ref_type === 'code_element' && r.ref_id === codeRef)).toBe(true);

    // Partial-unique index is ACTIVE: a 2nd LIVE row on the same (a_ref,b_ref,relation) fails.
    let dupThrew: unknown = null;
    try {
      await testDb`
        INSERT INTO public.bridge_edges (a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
        VALUES ('code_element', ${codeRef}::uuid, 'rule_element', ${ruleRef}::uuid, 'code', 'std', 'violates', 'dup', ${testDb.json([{ type: 'code_element', id: codeRef }])}::jsonb)
      `;
    } catch (e) {
      dupThrew = e;
    }
    expect(pgCode(dupThrew)).toBe('23505'); // unique_violation while original is live

    // Expire the original ⇒ the partial-unique index frees the key.
    await testDb`UPDATE public.bridge_edges SET expired_at = NOW() WHERE id = ${edgeId}::uuid`;
    const reinserted = await testDb`
      INSERT INTO public.bridge_edges (a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
      VALUES ('code_element', ${codeRef}::uuid, 'rule_element', ${ruleRef}::uuid, 'code', 'std', 'violates', 're-added after expiry', ${testDb.json([{ type: 'code_element', id: codeRef }])}::jsonb)
      RETURNING id
    `;
    expect(reinserted).toHaveLength(1);

    // Empty (whitespace-only) reasoning rejected at the staging boundary CHECK.
    let chkThrew: unknown = null;
    try {
      await testDb`
        INSERT INTO public.staging_bridge_edges
          (invocation_id, a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
        VALUES (${randomUUID()}::uuid, 'code_element', ${codeRef}::uuid, 'rule_element', ${ruleRef}::uuid, 'code', 'std', 'violates', '   ', ${testDb.json([{ type: 'code_element', id: codeRef }])}::jsonb)
      `;
    } catch (e) {
      chkThrew = e;
    }
    expect(pgCode(chkThrew)).toBe('23514'); // valid_staging_bridge_reasoning
  });

  // ── Case 5 (spec test 5) — hallucinated endpoint dropped ─────────────────

  it('5. hallucinated endpoint is dropped at disposal (never written to canonical)', async () => {
    const invocationId = randomUUID();
    const ruleRef = await upsertRuleElement({ corpusId: 'std', ruleId: 'C.rule.real' });
    const bogusRef = randomUUID(); // not in any catalog

    const staged = await testDb`
      INSERT INTO public.staging_bridge_edges
        (invocation_id, a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
      VALUES (${invocationId}::uuid, 'code_element', ${bogusRef}::uuid, 'rule_element', ${ruleRef}::uuid,
              'code', 'std', 'violates', 'cites a code element that does not exist',
              ${testDb.json([{ type: 'rule_element', id: ruleRef }])}::jsonb)
      RETURNING id
    `;
    const stagedId = (staged[0] as { id: string }).id;

    const res = await applyBridgePromotion(invocationId);
    expect(res.created).toHaveLength(0);
    expect(res.dropped.some((d) => d.stagedEdgeId === stagedId && /unresolved endpoint/.test(d.reason))).toBe(true);

    const canonical = await testDb`SELECT 1 FROM public.bridge_edges WHERE a_ref = ${bogusRef}::uuid`;
    expect(canonical).toHaveLength(0);
  });

  // ── Case 6 (spec test 6, D4) — replay idempotency incl. counts ───────────

  it('6. D4: replaying the same invocation is idempotent incl. corroboration_count', async () => {
    const invocationId = randomUUID();
    const codeRef = (await upsertCodeElement({ corpusId: 'code', scipSymbol: 'scip:dupfn#' })).elementRef;
    const ruleRef = await upsertRuleElement({ corpusId: 'std', ruleId: 'C.rule.dup' });

    await testDb`
      INSERT INTO public.staging_bridge_edges
        (invocation_id, a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
      VALUES (${invocationId}::uuid, 'code_element', ${codeRef}::uuid, 'rule_element', ${ruleRef}::uuid,
              'code', 'std', 'violates', 'first assertion',
              ${testDb.json([{ type: 'code_element', id: codeRef }])}::jsonb)
    `;

    // Run 1 — fresh create.
    const run1 = await applyBridgePromotion(invocationId);
    expect(run1.created).toHaveLength(1);
    const edgeId = run1.created[0]!.edgeId;

    const after1 = await testDb`SELECT id::text AS id, corroboration_count FROM public.bridge_edges WHERE expired_at IS NULL`;
    expect(after1).toHaveLength(1);
    expect(Number((after1[0] as { corroboration_count: number }).corroboration_count)).toBe(1);

    // Run 2 — same invocation, same staging. Corroborate path, but the
    // invocation_id single-slot guard must NOT bump the count.
    const run2 = await applyBridgePromotion(invocationId);
    expect(run2.created).toHaveLength(0);
    expect(run2.corroborated.every((c) => c.bumped === false)).toBe(true);

    const after2 = await testDb`SELECT id::text AS id, corroboration_count FROM public.bridge_edges WHERE expired_at IS NULL`;
    expect(after2).toHaveLength(1); // identical row set
    expect((after2[0] as { id: string }).id).toBe(edgeId);
    expect(Number((after2[0] as { corroboration_count: number }).corroboration_count)).toBe(1); // UNCHANGED
  });

  // ── Case 7 (spec test 7, D5) — word-prefix policy accessor ───────────────

  it('7. D5: corpus policy accessor — comparative vs assimilating default', async () => {
    await setCorpusPolicy('cmp', 'comparative');
    expect(await getCorpusPolicy('cmp')).toBe('comparative');

    // 'default' is seeded assimilating by mig 055; a corpus with no row also
    // defaults to assimilating.
    expect(await getCorpusPolicy('default')).toBe('assimilating');
    expect(await getCorpusPolicy('corpus-with-no-row')).toBe('assimilating');

    // NOTE (per spec §5 test 7 / D5): the planner-level rule-3 → arbiter
    // escalation under 'comparative' (never an embedding gate, never touching
    // rule-4) is exercised by promotion-plan's unit behaviour and is NOT
    // re-driven end-to-end here — this case asserts the policy accessor only.
  });
});
