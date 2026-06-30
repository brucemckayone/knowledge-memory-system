/**
 * Streams-under-concurrency litmus (feat/cognitive-platform-v2 merge gate).
 *
 * The v2 merge makes the user-focused "streams" work (stream-scoped speaker
 * identity) run under the parallel ingestion arms (epoch/optimistic). The central
 * risk is the concurrency seam: when a whole batch ingests as ONE stream and the
 * arms fan out (up to `concurrency` chunks extracting at once), every chunk's
 * extract()/propose() calls resolveStreamParticipants(streamId) -> findOrCreateSpeaker
 * for the SAME (streamId,'user') and (streamId,'assistant') keys simultaneously.
 *
 * The invariant this proves: findOrCreateSpeaker's advisory lock + the
 * stream_participants (stream_id, speaker_key) PRIMARY KEY collapse those races to
 * EXACTLY one USER + one ASSISTANT entity per stream — no duplicate speakers — and
 * the resolved ids are STABLE across chunk order (forward vs reverse). This is the
 * offline, model-free form of the doc-38 determinism litmus: it does not need the
 * extraction agent to produce facts (the speaker resolution is platform-side and
 * runs before the agent call), so the /graph-agent call is mocked at the fetch
 * boundary and the test is fully reproducible without a live LLM.
 *
 * Made-up corpus on purpose — the property under test is structural (no duplicate
 * stream speakers under fan-out), independent of what any chunk says.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { testDb, isMLServiceAvailable, isQdrantAvailable, skipCtx } from '../setup.js';
import { ingestBatch } from '../../pipeline.js';
import type { IngestMode } from '../../services/batch.js';

const RUN = `test-v2-conc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Made-up, conversational (USER:/ASSISTANT:) chunks. Every chunk has an assistant
// turn, so each chunk independently wants to seed BOTH a USER and an ASSISTANT
// speaker — maximising the concurrent find-or-create races on the same two keys.
const CHUNKS: string[] = [
  'USER: I work as a data scientist at Acme Corporation.\nASSISTANT: How long have you been in that role?',
  'USER: I studied marine biology at the University of Lisbon.\nASSISTANT: A strong research background.',
  'USER: I live in Berlin now.\nASSISTANT: You mentioned you relocated recently.',
  'USER: My sister Maria is a doctor in Madrid.\nASSISTANT: Your family has a professional streak.',
  'USER: I am learning to sail on weekends.\nASSISTANT: Sailing is a great way to unwind.',
  'USER: I plan to visit Tokyo next spring.\nASSISTANT: Tokyo in spring is lovely.',
];

// Capture /graph-agent POST bodies without running the real (model-backed) agent.
function interceptGraphAgent(): { calls: Array<{ body: any }>; restore: () => void } {
  const calls: Array<{ body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/graph-agent')) {
      let body: any;
      try { body = JSON.parse(init?.body ?? '{}'); } catch { body = undefined; }
      calls.push({ body });
      return new Response(JSON.stringify({ result: 'mocked-report' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

async function speakers(streamId: string): Promise<Array<{ entity_id: string; speaker_key: string }>> {
  return (await testDb`
    SELECT entity_id, speaker_key FROM public.stream_participants
    WHERE stream_id = ${streamId} ORDER BY speaker_key`) as any;
}

// stream_participants is not in the shared deleteFromTables allowlist; clearing the
// speaker entities cascade-clears the participant rows, leaving the shared DB clean.
async function cleanupStream(streamId: string): Promise<void> {
  await testDb`
    DELETE FROM public.entities
    WHERE id IN (SELECT entity_id FROM public.stream_participants WHERE stream_id = ${streamId})`;
  await testDb`DELETE FROM public.stream_participants WHERE stream_id = ${streamId}`;
}

const touchedStreams: string[] = [];
let intercept: ReturnType<typeof interceptGraphAgent> | undefined;
afterEach(async () => {
  intercept?.restore();
  intercept = undefined;
  for (const s of touchedStreams.splice(0)) await cleanupStream(s);
});

describe('streams survive concurrent parallel ingestion (v2 merge gate)', () => {
  beforeAll(async (ctx) => {
    // Needs real embeddings (store) + Qdrant + Postgres. The agent is mocked.
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) skipCtx(ctx);
  });

  for (const mode of ['epoch', 'optimistic'] as IngestMode[]) {
    it(`${mode}: one stream -> exactly one USER + one ASSISTANT under concurrency, stable across order`, async () => {
      const stream = `${RUN}-${mode}`;
      touchedStreams.push(stream);
      intercept = interceptGraphAgent();

      // FORWARD — whole batch as one stream, fanned out at full concurrency so all
      // chunks race to resolve the same two speaker keys at once.
      await ingestBatch(CHUNKS, {
        mode,
        streamId: stream,
        contentType: 'conversational',
        concurrency: CHUNKS.length,
        source: 'v2-conc-litmus',
      });

      const fwd = await speakers(stream);
      // The invariant: no duplicate speakers despite N concurrent find-or-creates.
      expect(fwd.map((r) => r.speaker_key)).toEqual(['assistant', 'user']);
      const userId = fwd.find((r) => r.speaker_key === 'user')!.entity_id;
      const asstId = fwd.find((r) => r.speaker_key === 'assistant')!.entity_id;
      expect(userId).toBeTruthy();
      expect(asstId).toBeTruthy();
      expect(userId).not.toBe(asstId);

      // Exactly two speaker ENTITIES exist for this stream (a racing duplicate
      // would show up as a 3rd entity even if the PK kept stream_participants at 2).
      const entCount = (await testDb`
        SELECT COUNT(*)::int AS n FROM public.entities
        WHERE id IN (SELECT entity_id FROM public.stream_participants WHERE stream_id = ${stream})`) as any;
      expect(entCount[0].n).toBe(2);

      // The parallel arm fed the agent the per-stream speaker anchor on every chunk
      // (extract() for optimistic, propose() for epoch — both must carry it).
      const agentCalls = intercept.calls;
      expect(agentCalls.length).toBeGreaterThan(0);
      for (const c of agentCalls) {
        expect(c.body.stream_id).toBe(stream);
        expect(c.body.participants).toContain('## Participants in this stream');
        expect(c.body.participants).toContain(userId);
        expect(c.body.participants).toContain(asstId);
      }

      // REVERSE — same stream, chunks in opposite order. Speaker resolution is keyed
      // on (stream, role), so the ids MUST be identical regardless of arrival order:
      // order-independence of the stream-scoped identity (the doc-38 litmus property).
      await ingestBatch([...CHUNKS].reverse(), {
        mode,
        streamId: stream,
        contentType: 'conversational',
        concurrency: CHUNKS.length,
        source: 'v2-conc-litmus',
      });

      const rev = await speakers(stream);
      expect(rev.map((r) => r.speaker_key)).toEqual(['assistant', 'user']);
      expect(rev.find((r) => r.speaker_key === 'user')!.entity_id).toBe(userId);
      expect(rev.find((r) => r.speaker_key === 'assistant')!.entity_id).toBe(asstId);
    });
  }
});
