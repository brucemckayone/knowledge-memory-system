/**
 * Graph-anchored fallback retrieval — END-TO-END RECALL UPLIFT EVAL (bead
 * nmemo-0wq.4; design doc 38 §6/§8.3).
 *
 * This is the EVAL bead: it must DEMONSTRATE that the §6 failure-triggered graph
 * fallback (recallViaGraph / expandFromAnchors, beads .2/.3) recovers an answer
 * window that FLAT unit retrieval misses — i.e. recallWithFallback must EXCEED
 * recallWithoutFallback, with the recovered window attributed to the fallback
 * alone.
 *
 * WHY THE FIRST NEEDLE WAS WRONG (the nmemo-0wq.4 lesson). The original "two
 * hobbies" needle could never show uplift: flat retrieval surfaced ONE hobby
 * window ABOVE the floor, so flatRetrievalFailed() returned false and the
 * fallback never fired. The §6 trigger fires on flat FAILURE (top score < floor,
 * or empty), NOT on flat INCOMPLETENESS — so a needle where flat partially
 * succeeds can never exercise the fallback. The needle must make flat FAIL.
 *
 * THE ANCHOR-WALK NEEDLE (fixtures/fallback-anchor-walk.json). Two first-person
 * sessions under the SAME stream user:
 *   - Session A establishes a distinctive named anchor entity, the dog "Atlas"
 *     (adoption, daily runs) — NO mention of food.
 *   - Session B (the ANSWER) is topically dominated by chest-freezer / delivery
 *     logistics, and states the answer fact in passing: "Atlas is fed Kintaro".
 * The QUESTION — "What does Atlas eat?" — is phrased so that:
 *   1. FLAT FAILS: no unit in the corpus clears the 0.5 trigger floor. B reads
 *      as freezer-rotation prose, not "what Atlas eats", so a vector search on
 *      the question scores B below the floor; A is about runs, not food.
 *   2. The query still REACHES the Atlas anchor — via query-side entity match
 *      (findSimilarEntities over the question, which names "Atlas") and/or the
 *      entities in the weak below-floor flat hit on A (§4.1).
 *   3. Atlas is GRAPH-CONNECTED to the answer: the real agent extracts the
 *      Atlas->Kintaro (fed/eats) fact from B, whose fact_units point back to B's
 *      evidence window. So the fallback walks Atlas -> the diet fact -> B's unit,
 *      recovering the window flat missed.
 *
 * ACCEPTANCE (bd show nmemo-0wq.4 + the .4 correction): the fallback must
 * recover >=1 answer window flat MISSED — recoveredByFallbackOnly NON-EMPTY,
 * recallWithFallback > recallWithoutFallback — with NO regression (no flat hit
 * dropped). If the real pipeline cannot produce this (flat unexpectedly clears
 * the floor, the Atlas->Kintaro edge does not form, or expansion does not reach
 * B), the test HALTS by failing with the measured numbers rather than shipping a
 * vacuous pass; that finding is itself recorded as the bead's honest outcome.
 *
 * ISOLATION (mandatory): runs as a vitest integration test, so
 * QDRANT_COLLECTION=memories_test + DATABASE_URL=cognitive_test (setup.ts /
 * bead nmemo-wow). The real ml-services / Ollama embeddings + the real Haiku
 * graph agent are used ONLY for the TWO needle ingests; the three distractors
 * are store()-only embed noise (NO agent), keeping the suite to two real-agent
 * runs to stay under the hookTimeout (the q0 pattern). Gates on
 * isMLServiceAvailable()/isQdrantAvailable() and SKIPS cleanly when down. Never
 * touches production.
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
import { findOrCreateSpeaker, findSimilarEntities } from '../../services/entities.js';
import { ml } from '../../services/ml-client.js';
import { searchMemoriesByUnit } from '../../services/qdrant.js';
import {
  flatRetrievalFailed,
  recallViaGraph,
  type FlatHit,
} from '../../services/graph-fallback.js';

interface Needle {
  session_id: string;
  hobby: string;
  date: string | null;
  text: string;
}
interface Distractor {
  session_id: string;
  date: string | null;
  text: string;
}
interface Fixture {
  question_id: string;
  question: string;
  answer: string;
  answer_hobby_key: string;
  needles: Needle[];
  distractors: Distractor[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/fallback-anchor-walk.json'), 'utf-8'),
);

// Per-run stream so re-running the suite never collides with prior speaker
// entities or memory points (clean slate within the shared test DB/collection).
const STREAM = `fallback-0wq4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

type IngestResult = Awaited<ReturnType<typeof ingest>>;
const ingested: IngestResult[] = [];
const distractorMemoryIds: string[] = [];
let userEntityId: string;

// session role-key (anchor | diet) -> the parent window memory id of its chunk.
const sessionWindow: Record<string, string> = {};

describe('fallback recall eval — anchor-walk needle (nmemo-0wq.4)', () => {
  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }

    // Resolve the stream USER speaker up front (idempotent; the pipeline reuses
    // it). Both first-person sessions anchor onto this single entity.
    userEntityId = (await findOrCreateSpeaker(STREAM, 'user', 'user')).id;

    const opts = {
      source: `fallback-eval:${fixture.question_id}`,
      contentType: 'conversational' as const,
      streamId: STREAM,
    };

    // Distractors first: embed-only (store()), NO agent — pure retrieval noise.
    for (const d of fixture.distractors) {
      distractorMemoryIds.push(await store(d.text, opts));
    }

    // Needles: the anchor session (A) + the answer session (B) through the REAL
    // agent so entities + facts + AGE edges + fact_units exist for the graph walk.
    // Two real-agent ingests only — within the hookTimeout (q0 pattern).
    for (const n of fixture.needles) {
      const res = await ingest(n.text, opts);
      ingested.push(res);
      sessionWindow[n.hobby] = res.memoryId;
    }
  }, 20 * 60 * 1000);

  afterAll(async () => {
    try {
      const ids = [...new Set(ingested.flatMap((r) => r.entities.map((e) => e.id)))];
      if (userEntityId) ids.push(userEntityId);
      if (ids.length > 0) {
        await testDb`DELETE FROM public.entities WHERE id = ANY(${ids})`;
      }
      await testDb`DELETE FROM public.stream_participants WHERE stream_id = ${STREAM}`;
    } catch {
      // best-effort; never fail the run on teardown
    }
  });

  it('ingested the anchor + answer sessions and seeded the user entity', () => {
    expect(sessionWindow.anchor, 'anchor (Atlas) session ingested').toBeTruthy();
    expect(sessionWindow.diet, 'answer (Kintaro) session ingested').toBeTruthy();
    expect(userEntityId).toBeTruthy();
    expect(sessionWindow.anchor).not.toBe(sessionWindow.diet);
  });

  it('EVAL: graph fallback recovers the flat-missed answer window (recall uplift)', async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) return skipCtx(ctx);

    // The ANSWER lives in session B (the diet window). That is the window flat
    // must miss and the fallback must recover.
    const answerWindow = sessionWindow.diet!;
    const windowLabel = new Map<string, string>([
      [sessionWindow.anchor!, 'anchor(Atlas)'],
      [sessionWindow.diet!, 'answer(Kintaro)'],
    ]);

    // ---- FLAT path (mirrors computeQueryFallbackEvidence in src/index.ts) ----
    const { vector: queryVector } = await ml.embedQuery(fixture.question);
    const flat = await searchMemoriesByUnit(queryVector, { limit: 5, streamId: STREAM });
    const flatHits: FlatHit[] = flat.map((m) => ({ id: m.id, score: m.score }));

    const FLOOR = Number(process.env.FALLBACK_TRIGGER_MIN_SCORE) || 0.5;
    // Which answer window(s) did flat surface ABOVE the floor? (Below-floor hits
    // are a "miss" per §6.1 — they seed anchors but do not count as recovered.)
    const flatRecovered = new Set<string>();
    for (const m of flat) {
      if (m.id === answerWindow && m.score >= FLOOR) flatRecovered.add(m.id);
    }

    const triggered = flatRetrievalFailed(flatHits);

    // ---- FALLBACK path (only fires on flat FAILURE — the §6 cost guard) ----
    const fallbackRecovered = new Set<string>();
    let recoveredUnitCount = 0;
    let anchorCount = 0;
    if (triggered) {
      // Same anchor seeding as the /api/reason/query boundary: entities in the
      // weak flat hits (§4.1.1) + a query-side entity match (§4.1.2).
      const seedEntities = await findSimilarEntities((await ml.embed(fixture.question)).vector, {
        threshold: 0.5,
        limit: 5,
      });
      anchorCount = seedEntities.length;
      const ranked = await recallViaGraph(queryVector, flatHits, {
        seedEntityIds: seedEntities.map((e) => e.id),
        limit: 10,
      });
      recoveredUnitCount = ranked.length;
      // A fallback unit RECOVERS the answer window if its parentWindowId is the
      // answer window. Provenance stays the parent window (§7).
      for (const r of ranked) {
        if (r.parentWindowId === answerWindow) fallbackRecovered.add(answerWindow);
      }
    }

    // ---- recall WITH vs WITHOUT fallback ----
    const withoutFallback = new Set(flatRecovered);
    const withFallback = new Set([...flatRecovered, ...fallbackRecovered]);

    const report = {
      question: fixture.question,
      answer: fixture.answer,
      floor: FLOOR,
      flatTopScore: flatHits.length ? Number(Math.max(...flatHits.map((h) => h.score)).toFixed(3)) : 0,
      flatHitWindows: flat.map((m) => ({
        id: m.id,
        label: windowLabel.get(m.id) ?? 'distractor',
        score: Number(m.score.toFixed(3)),
      })),
      triggerFired: triggered,
      querySideAnchors: anchorCount,
      fallbackUnitsReturned: recoveredUnitCount,
      recallWithoutFallback: withoutFallback.size,
      recallWithFallback: withFallback.size,
      recoveredByFallbackOnly: [...fallbackRecovered]
        .filter((w) => !flatRecovered.has(w))
        .map((w) => windowLabel.get(w)),
    };
    console.log('[0wq.4 EVAL]', JSON.stringify(report, null, 2));

    // ---- ACCEPTANCE: REQUIRE the uplift (no vacuous pass) ----
    // 1. Flat must genuinely FAIL on this needle, or the fallback never fires
    //    and there is nothing to demonstrate. The needle is designed for this;
    //    if flat clears the floor the needle has drifted and we HALT.
    expect(
      triggered,
      `flat retrieval must FAIL to exercise the fallback — flat top score ` +
        `${report.flatTopScore} should be < floor ${FLOOR}`,
    ).toBe(true);

    // 2. The query must reach >=1 anchor (else §4.2 no-anchor ceiling — the
    //    fallback cannot recover anything). The Atlas-named question is built to
    //    entity-match the Atlas anchor.
    expect(
      report.querySideAnchors,
      'query must reach >=1 anchor entity (Atlas) for the walk to start',
    ).toBeGreaterThanOrEqual(1);

    // 3. No regression: the fallback never drops a window flat surfaced.
    for (const w of flatRecovered) expect(withFallback.has(w)).toBe(true);

    // 4. THE UPLIFT: the fallback recovers the answer window flat missed.
    expect(
      report.recoveredByFallbackOnly.length,
      'fallback must recover the answer window flat missed (recoveredByFallbackOnly non-empty)',
    ).toBeGreaterThanOrEqual(1);
    expect(
      report.recallWithFallback,
      'recall WITH fallback must exceed recall WITHOUT',
    ).toBeGreaterThan(report.recallWithoutFallback);
  }, 5 * 60 * 1000);
});
