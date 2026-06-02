/**
 * q[0] convergence retest — the success metric spanning BOTH epics
 * (nmemo-yxj.5; proves nmemo-3f9 speaker-aware extraction + nmemo-yxj
 * small-unit embeddings end-to-end).
 *
 * Origin: nmemo-eue (LongMemEval baseline). The needle is the degree session
 * for question e47becba ("What degree did I graduate with?" -> "Business
 * Administration"), answer_session_id answer_280352e9. The user states
 * "I graduated with a degree in Business Administration..." in a first-person
 * chat. The whole-window baseline buried that sentence (degree-needle cosine
 * 0.471, below noise — epic nmemo-yxj evidence). This test re-ingests the real
 * session through the production pipeline and asserts the two convergence
 * outcomes:
 *
 *   F1 (3f9): a fact exists with subject = the stream's USER speaker entity
 *             (resolved DETERMINISTICALLY via findOrCreateSpeaker, NOT by
 *             name), predicate ~ graduated_with / degree, object ~ "Business
 *             Administration". Subject-anchored to the anonymous user, not a
 *             named entity.
 *
 *   F2 (yxj): searchMemoriesByUnit for "What degree did I graduate with?"
 *             returns the parent window of the degree chunk in the top-k, with
 *             the best unit score in the 0.7+ band (yxj.1 recommendation
 *             unit_size=128/overlap=64 measured 0.738 for this exact needle).
 *
 * Isolation: runs as a vitest integration test, so QDRANT_COLLECTION=
 * memories_test + DATABASE_URL=cognitive_test (bead nmemo-wow) — it touches
 * ONLY the test collection + test DB, never production memories/cognitive. It
 * uses the real ml-services / Ollama for embedding + the Haiku graph agent
 * (acceptable load). Gates on isMLServiceAvailable()/isQdrantAvailable() and
 * SKIPS cleanly when services are down.
 *
 * Fixture: src/test/fixtures/q0-degree-session.json — the real session, chunked
 * exactly as benchmarks/longmemeval/run.py chunk_session() does (turn-boundary
 * split at max_ingest_chars=6000, session-date header repeated). The degree
 * sentence lands in chunk index 1 (the 5895-char window from the epic
 * evidence). We ingest each chunk through ingest() directly (NOT the off-limits
 * harness) with content_type='conversational' and a per-run stream_id.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  testDb,
  isMLServiceAvailable,
  isQdrantAvailable,
  skipCtx,
} from '../setup.js';
import { ingest, store } from '../../pipeline.js';
import { findOrCreateSpeaker } from '../../services/entities.js';
import { ml } from '../../services/ml-client.js';
import { searchMemoriesByUnit } from '../../services/qdrant.js';

interface Fixture {
  question_id: string;
  question: string;
  answer: string;
  answer_session_id: string;
  session_date: string | null;
  chunks: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/q0-degree-session.json'), 'utf-8'),
);

// Per-run stream so re-running the suite never collides with prior speaker
// entities or memory points (the suite is its own clean slate within the
// shared test DB/collection).
const STREAM = `q0-yxj5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Ingest results for assertions (entities + facts created per chunk).
type IngestResult = Awaited<ReturnType<typeof ingest>>;
const ingested: IngestResult[] = [];
const memoryIds: string[] = [];
let userEntityId: string;

// The degree-window parent memory id (chunk index 1 carries the needle).
let degreeMemoryId: string | undefined;

describe('q[0] degree convergence retest (nmemo-yxj.5)', () => {
  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }

    // Resolve the stream's USER speaker DETERMINISTICALLY up front (3f9.1).
    // This is the same entity ingest()->extract()->resolveStreamParticipants
    // seeds; pre-seeding here gives us the id to anchor the F1 assertion to,
    // and findOrCreateSpeaker is idempotent so the pipeline reuses it.
    userEntityId = (await findOrCreateSpeaker(STREAM, 'user', 'user')).id;

    // Ingest each chunk through the REAL pipeline (store units + Haiku graph
    // agent), conversational + stream-scoped. Serial — the agent writes the
    // shared graph and we want deterministic ordering. This is slow (real
    // Haiku ~1-2 min/chunk); the suite-level timeout below covers it.
    // Only the degree-bearing chunk needs the (slow ~5-8min) Haiku graph agent —
    // that is what F1 asserts. The other chunks are realistic retrieval
    // distractors for F2, so they only need store() (embed parent window + unit
    // satellites into memories_test, NO agent extract). This keeps the whole
    // beforeAll to ONE real-agent run instead of four — the 4-ingest version
    // blew the 20-min hookTimeout even though the degree fact extracted fine.
    for (let i = 0; i < fixture.chunks.length; i++) {
      const chunk = fixture.chunks[i]!;
      const opts = {
        source: `q0-retest:${fixture.answer_session_id}`,
        contentType: 'conversational' as const,
        streamId: STREAM,
      };
      if (chunk.includes('Business Administration')) {
        const res = await ingest(chunk, opts);
        ingested.push(res);
        memoryIds.push(res.memoryId);
        degreeMemoryId = res.memoryId;
      } else {
        memoryIds.push(await store(chunk, opts));
      }
    }
  }, 20 * 60 * 1000);

  afterAll(async () => {
    // Clean up ONLY what this run created (test DB/collection, but stay tidy):
    // facts + memory_entities cascade off the entities we delete; the speaker
    // entity + its stream_participants row cascade too. Qdrant points in
    // memories_test are left for the global test teardown.
    try {
      const ids = [...new Set(ingested.flatMap((r) => r.entities.map((e) => e.id)))];
      if (userEntityId) ids.push(userEntityId);
      if (ids.length > 0) {
        await testDb`DELETE FROM public.entities WHERE id = ANY(${ids})`;
      }
      await testDb`DELETE FROM public.stream_participants WHERE stream_id = ${STREAM}`;
    } catch {
      // best-effort cleanup; never fail the run on teardown
    }
  });

  it('ingested all chunks and located the degree window', () => {
    expect(memoryIds.length).toBe(fixture.chunks.length);
    expect(degreeMemoryId, 'the Business Administration chunk must have a memoryId').toBeTruthy();
  });

  it('F1: a degree fact exists, subject-anchored to the stream USER speaker', async () => {
    // Query facts directly so we assert against the canonical Graph S row, not
    // the per-chunk ExtractResult projection. Subject MUST be the deterministic
    // user speaker entity (NOT a named entity); predicate/object matched with
    // tolerant patterns because Haiku extraction normalises predicates
    // variably (graduated_with / has_degree / degree_in / studied ...).
    const rows = await testDb`
      SELECT f.id, f.predicate, f.object_value, f.subject_entity_id, f.source_text,
             e.canonical_name AS subject_name, e.entity_type AS subject_type
      FROM public.facts f
      JOIN public.entities e ON e.id = f.subject_entity_id
      WHERE f.subject_entity_id = ${userEntityId}`;

    // The degree fact: object mentions Business Administration OR the
    // predicate is degree/graduate-shaped with the object naming the degree.
    const objHasBA = (v: string | null) =>
      !!v && /business\s+administration/i.test(v);
    const predIsDegree = (p: string) =>
      /(graduat|degree|major|studied|education|qualif)/i.test(p);

    const degreeFacts = rows.filter(
      (r) =>
        objHasBA(r.object_value) ||
        (predIsDegree(r.predicate) &&
          /business|administration/i.test(r.object_value ?? '')),
    );

    // Diagnostic dump so a miss is debuggable from the run log.
    if (degreeFacts.length === 0) {
      console.error(
        '[q0.F1] no degree fact on user. user facts =',
        JSON.stringify(rows.map((r) => ({ p: r.predicate, o: r.object_value })), null, 2),
      );
    }

    expect(degreeFacts.length, 'a Business-Administration degree fact on the user').toBeGreaterThan(0);

    const f = degreeFacts[0]!;
    // Subject anchored to the ANONYMOUS user speaker (3f9 invariant): its
    // canonical name is the synthetic "User (stream ...)" label, NOT a person's
    // proper name parsed out of the text.
    expect(f.subject_entity_id).toBe(userEntityId);
    expect(String(f.subject_name)).toContain('stream');
    console.log(
      `[q0.F1] PASS predicate="${f.predicate}" object="${f.object_value}" subject="${f.subject_name}"`,
    );
  });

  it('F2: searchMemoriesByUnit retrieves the degree window in the 0.7+ band', async () => {
    // Embed the natural question and search the UNIT index (undiluted vectors),
    // deduped to parent windows — the read path yxj.3 built. The degree window
    // must surface in the top-k, scored by its best unit. yxj.1 measured 0.738
    // for this needle at 128/64; we assert a conservative >=0.7 band and allow
    // a small slack for query-phrasing variance.
    // Embed with the QUERY prefix (1cp / nmemo-awi): stored window+unit vectors
    // use the search_document: prefix, so the question must use search_query: to
    // match — mirrors the production search_memories tool. Raw ml.embed here
    // would mismatch the prefixed corpus and depress the score.
    const { vector } = await ml.embedQuery(fixture.question);
    const hits = await searchMemoriesByUnit(vector, { limit: 5, streamId: STREAM });

    expect(hits.length, 'unit search returned results').toBeGreaterThan(0);
    // The fallback path (matchedUnits=0) would mean units were missing — units
    // MUST exist for this freshly-ingested data, so the hit is unit-grained.
    expect(hits[0]!.matchedUnits, 'top hit must be unit-grained, not window-fallback').toBeGreaterThan(0);

    const degreeHit = hits.find((h) => h.id === degreeMemoryId);
    if (!degreeHit) {
      console.error(
        '[q0.F2] degree window not in top-k. hits =',
        JSON.stringify(
          hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(3)), best: h.bestUnitText?.slice(0, 80) })),
          null,
          2,
        ),
      );
    }
    expect(degreeHit, 'the degree window must be retrievable in the top-k').toBeTruthy();
    console.log(
      `[q0.F2] degree window score=${degreeHit!.score.toFixed(3)} matchedUnits=${degreeHit!.matchedUnits} bestUnit="${degreeHit!.bestUnitText?.slice(0, 80)}"`,
    );
    // The convergence target: above noise, in the 0.7+ band (was 0.471).
    expect(degreeHit!.score).toBeGreaterThanOrEqual(0.7);
  });
});
