/**
 * Two-signal fusion read path (bead nmemo-u8j.1).
 *
 * recallEntitiesFused = RRF-60(dense-over-names, dense-over-facts). The point of
 * fusion — confirmed in R4 — is that the fact signal surfaces target entities the
 * NAME signal alone misses. This suite constructs exactly that: an entity whose
 * name is unrelated to the query but which owns a fact that matches it, and proves
 * fusion returns it (fact-surfaced). Also locks the fact primitive's MAX
 * aggregation, corpus scoping, and the empty-embedding guard.
 *
 * Writes its own substrate (READ-path suite), corpus-scoped like fact-vector-recall.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, isMLServiceAvailable } from '../setup.js';
import { embedForWrite, embedForQuery } from '../../services/embed.js';
import { findSimilarEntities } from '../../services/entities.js';
import { recallEntitiesFused, recallEntitiesByFactSimilarity } from '../../services/retrieval.js';

const CA = 'fuse-corpus-a';
const CB = 'fuse-corpus-b';
const DIFFUSION = 'Diffusion models generate images by iteratively denoising latents';
const PARLIAMENT = 'Parliamentary procedure requires a quorum before a binding vote';
const QUERY = 'denoising diffusion image generation';

async function clean(): Promise<void> {
  for (const c of [CA, CB]) {
    await testDb.unsafe(`DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE corpus_id = '${c}')`);
    await testDb.unsafe(`DELETE FROM causal_events WHERE fact_id IN (SELECT id FROM facts WHERE corpus_id = '${c}')`);
    await testDb.unsafe(`DELETE FROM facts WHERE corpus_id = '${c}'`);
    await testDb.unsafe(`DELETE FROM entities WHERE corpus_id = '${c}'`);
  }
}

async function seedEntity(corpusId: string, name: string): Promise<string> {
  const id = randomUUID();
  await testDb`
    INSERT INTO entities (id, canonical_name, entity_type, corpus_id)
    VALUES (${id}::uuid, ${name}, 'organization', ${corpusId})
  `;
  const vec = await embedForWrite(name);
  await testDb.unsafe(`UPDATE entities SET embedding = '[${vec.join(',')}]'::vector WHERE id = '${id}'`);
  return id;
}

async function seedFact(corpusId: string, subjectId: string, text: string, predicate: string): Promise<void> {
  const id = randomUUID();
  await testDb`
    INSERT INTO facts (id, subject_entity_id, predicate, object_value, source_text, confidence, corpus_id)
    VALUES (${id}::uuid, ${subjectId}::uuid, ${predicate}, 'v', ${text}, 0.9, ${corpusId})
  `;
  const vec = await embedForWrite(text);
  await testDb.unsafe(`UPDATE facts SET fact_embedding = '[${vec.join(',')}]'::vector WHERE id = '${id}'`);
}

describe('recallEntitiesFused — two-signal fusion read path (nmemo-u8j.1)', () => {
  let mlUp = false;
  let factOnly = ''; // name unrelated to the query; owns a matching fact
  let maxProbe = ''; // strong + weak fact -> tests MAX aggregation
  let singleStrong = ''; // strong fact only -> reference for the MAX assertion

  beforeAll(async () => {
    mlUp = await isMLServiceAvailable();
    if (!mlUp) return;
    await clean();
    factOnly = await seedEntity(CA, 'Zenith Holdings Ltd'); // name unrelated to the query
    await seedFact(CA, factOnly, DIFFUSION, 'studies');
    // Distractors whose NAMES match the query far better than factOnly's, so the
    // name signal alone ranks factOnly below a small top-k and the fact signal is
    // the only thing that can surface it (the real fusion claim).
    await seedEntity(CA, 'Diffusion Imaging Group');
    await seedEntity(CA, 'Image Generation Systems');
    await seedEntity(CA, 'Latent Denoising Research');
    await seedEntity(CA, 'Generative Vision Models Lab');
    maxProbe = await seedEntity(CA, 'Umbra Systems');
    await seedFact(CA, maxProbe, DIFFUSION, 'studies'); // strong for QUERY
    await seedFact(CA, maxProbe, PARLIAMENT, 'notes'); // weak for QUERY
    singleStrong = await seedEntity(CA, 'Vertex Labs');
    await seedFact(CA, singleStrong, DIFFUSION, 'studies');
    // corpus B: a matching entity that must never leak into a corpus-A query
    const bId = await seedEntity(CB, 'Borealis Diffusion Institute');
    await seedFact(CB, bId, DIFFUSION, 'studies');
  });

  afterAll(async () => {
    if (mlUp) await clean();
  });

  it('fusion surfaces a target the NAME signal alone would miss (fact-surfaced)', async () => {
    if (!mlUp) return;
    // Name signal alone, same breadth, small top-k: the query-themed distractors
    // outrank factOnly on name, so it is NOT in the top 3.
    const embedding = await embedForQuery(QUERY);
    const nameOnly = await findSimilarEntities(embedding, { corpusId: CA, limit: 3, threshold: 0 });
    expect(nameOnly.map((e) => e.id)).not.toContain(factOnly);
    // Fusion at the same top-k pulls it in — only the fact signal can do that.
    const fused = await recallEntitiesFused(QUERY, { corpusId: CA, threshold: 0, limit: 3 });
    expect(fused.map((e) => e.id)).toContain(factOnly);
    const t = fused.find((e) => e.id === factOnly)!;
    expect(t.factSimilarity).toBeGreaterThan(0.3); // the fact signal is what put it here
    expect(t.nameSimilarity === null || t.nameSimilarity < 0.5).toBe(true); // not a strong name match
  });

  it('fact-primitive aggregates a query to an entity by MAX, not mean', async () => {
    if (!mlUp) return;
    const embedding = await embedForQuery(QUERY);
    const ranked = await recallEntitiesByFactSimilarity(embedding, { corpusId: CA });
    const probe = ranked.find((r) => r.entityId === maxProbe)!;
    const single = ranked.find((r) => r.entityId === singleStrong)!;
    expect(probe).toBeTruthy();
    expect(single).toBeTruthy();
    // MAX: the weak PARLIAMENT fact must not drag the score down — the two-fact
    // entity scores the SAME as the one-strong-fact entity. (mean would be lower.)
    expect(probe.similarity).toBeCloseTo(single.similarity, 5);
  });

  it('is corpus-scoped: a corpus-A query never returns a corpus-B entity', async () => {
    if (!mlUp) return;
    const fused = await recallEntitiesFused(QUERY, { corpusId: CA, threshold: 0, limit: 25 });
    for (const e of fused) expect(e.corpusId).toBe(CA);
  });

  it('the fact primitive returns [] on an empty (failed) query embedding — the null-vector guard', async () => {
    const ranked = await recallEntitiesByFactSimilarity([], { corpusId: CA });
    expect(ranked).toEqual([]);
  });
});
