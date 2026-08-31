/**
 * The fact-vector READ end (bead nmemo-vga) and the filtered-vector-search
 * defect found while fixing it.
 *
 * `searchFacts` is the only reader of `facts.fact_embedding` and had zero callers
 * anywhere in the tree, so three defects had never been exercised: no corpus
 * predicate (a cross-graph read-path leak), no `invalid_at` filter, and no
 * predicate filter. On top of that, the query shape itself — a b-tree-able WHERE
 * plus `ORDER BY embedding <=> $1 LIMIT k` — is a POST-filter on an HNSW index
 * scan, which silently drops every candidate the filter rejects instead of
 * resuming the walk. Migration 058 sets `hnsw.iterative_scan = strict_order` to
 * fix that; `iterative-scan is on` below is the regression guard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, isMLServiceAvailable } from '../setup.js';
import { searchFacts } from '../../services/facts.js';
import { embedForWrite } from '../../services/embed.js';

const TAG = 'factvec';
const CA = 'factvec-corpus-a';
const CB = 'factvec-corpus-b';

// Distinct topics so the two corpora are separable by cosine, and each corpus's
// own text is the nearer match for its own query.
const TEXT_A = 'Diffusion models generate images by iteratively denoising latents';
const TEXT_B = 'Parliamentary procedure requires a quorum before a binding vote';

async function clean(): Promise<void> {
  for (const c of [CA, CB]) {
    await testDb.unsafe(`DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE corpus_id = '${c}')`);
    await testDb.unsafe(`DELETE FROM causal_events WHERE fact_id IN (SELECT id FROM facts WHERE corpus_id = '${c}')`);
    await testDb.unsafe(`DELETE FROM facts WHERE corpus_id = '${c}'`);
    await testDb.unsafe(`DELETE FROM entities WHERE corpus_id = '${c}'`);
  }
}

/** Insert one embedded fact directly — this suite tests the READ path, so it
 *  writes the substrate itself rather than driving promote(). */
async function seedFact(corpusId: string, text: string, predicate: string): Promise<string> {
  const subjectId = randomUUID();
  await testDb`
    INSERT INTO entities (id, canonical_name, entity_type, corpus_id)
    VALUES (${subjectId}::uuid, ${`${TAG} ${corpusId} ${predicate}`}, 'organization', ${corpusId})
  `;
  const factId = randomUUID();
  const vec = await embedForWrite(text);
  await testDb`
    INSERT INTO facts (id, subject_entity_id, predicate, object_value, source_text, confidence, corpus_id)
    VALUES (${factId}::uuid, ${subjectId}::uuid, ${predicate}, 'v', ${text}, 0.9, ${corpusId})
  `;
  await testDb.unsafe(
    `UPDATE facts SET fact_embedding = '[${vec.join(',')}]'::vector WHERE id = '${factId}'`,
  );
  return factId;
}

describe('searchFacts — the fact-vector read end (nmemo-vga)', () => {
  let mlUp = false;
  let factA = '';
  let factB = '';

  beforeAll(async () => {
    mlUp = await isMLServiceAvailable();
    if (!mlUp) return;
    await clean();
    factA = await seedFact(CA, TEXT_A, 'uses_technique');
    factB = await seedFact(CB, TEXT_B, 'requires');
  });

  afterAll(async () => {
    if (mlUp) await clean();
  });

  it('iterative-scan is on, so a filtered vector search is not truncated (migration 058)', async () => {
    // The guard for the systemic defect. Without strict_order the HNSW walk
    // returns the ef_search (default 40) nearest candidates GLOBALLY and the
    // corpus filter discards them, so a corpus-scoped search returns fewer rows
    // than exist — measured recall@10 0.715 with 6 of 60 queries returning ZERO.
    const rows = await testDb.unsafe(
      `SELECT current_setting('hnsw.iterative_scan', true) AS setting`,
    );
    expect((rows[0] as unknown as { setting: string | null }).setting).toBe('strict_order');
  });

  it('finds a fact by semantic similarity within its own corpus', async () => {
    if (!mlUp) return;
    const hits = await searchFacts('denoising diffusion image generation', { corpusId: CA, threshold: 0.3 });
    expect(hits.map((h) => h.fact.id)).toContain(factA);
  });

  it('does NOT return facts from another corpus (the read-path leak this closes)', async () => {
    if (!mlUp) return;
    // Query text is corpus A's topic; corpus B must come back empty rather than
    // returning A's fact. Before the corpus predicate existed it returned both.
    const hits = await searchFacts('denoising diffusion image generation', { corpusId: CB, threshold: 0.3 });
    expect(hits.map((h) => h.fact.id)).not.toContain(factA);
    for (const h of hits) expect(h.fact.corpusId).toBe(CB);
  });

  it('searches every corpus only when corpusId is explicitly null', async () => {
    if (!mlUp) return;
    const scoped = await searchFacts(TEXT_B, { corpusId: CA, threshold: 0.3 });
    expect(scoped.map((h) => h.fact.id)).not.toContain(factB);
    const open = await searchFacts(TEXT_B, { corpusId: null, threshold: 0.3 });
    expect(open.map((h) => h.fact.id)).toContain(factB);
  });

  it('applies the predicate filter', async () => {
    if (!mlUp) return;
    const match = await searchFacts(TEXT_A, { corpusId: CA, threshold: 0.0, predicate: 'uses_technique' });
    expect(match.map((h) => h.fact.id)).toContain(factA);
    const miss = await searchFacts(TEXT_A, { corpusId: CA, threshold: 0.0, predicate: 'requires' });
    expect(miss.map((h) => h.fact.id)).not.toContain(factA);
  });

  it('excludes a fact whose validity window has closed (invalid_at in the past)', async () => {
    if (!mlUp) return;
    // The bi-temporal filter searchFacts was missing: it checked expired_at only,
    // so a logically-invalid fact still ranked.
    await testDb.unsafe(`UPDATE facts SET invalid_at = NOW() - interval '1 day' WHERE id = '${factA}'`);
    try {
      const hits = await searchFacts('denoising diffusion image generation', { corpusId: CA, threshold: 0.3 });
      expect(hits.map((h) => h.fact.id)).not.toContain(factA);
    } finally {
      await testDb.unsafe(`UPDATE facts SET invalid_at = NULL WHERE id = '${factA}'`);
    }
  });
});
