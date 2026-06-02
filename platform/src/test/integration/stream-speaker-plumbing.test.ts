/**
 * Stream + speaker plumbing through ingest -> store -> extract -> graph agent
 * (nmemo-3f9.2).
 *
 * Acceptance:
 * - A request carrying stream_id propagates it to store (Qdrant payload),
 *   extract, and the EXTRACTION CONTEXT (the /graph-agent POST body).
 * - The resolved default speaker entity id(s) appear in the prompt Participants
 *   block: USER always; ASSISTANT only when assistant-role labels appear.
 * - Omitting stream_id still works (implicit single stream, back-compat).
 * - No participants array is ever required on the way in.
 *
 * Strategy: store() + extract() are real (Qdrant + the deterministic
 * findOrCreateSpeaker DB path). The /graph-agent ML call is intercepted at the
 * global-fetch boundary so we can assert the request body that extract() built
 * without running the (slow, model-backed) agent.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import {
  testDb,
  isMLServiceAvailable,
  isQdrantAvailable,
  skipCtx,
} from '../setup.js';
import {
  store,
  extract,
  resolveStreamParticipants,
  textHasAssistantTurns,
} from '../../pipeline.js';
import { getMemory } from '../../services/qdrant.js';

const RUN = `test-3f9-2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// stream_participants is NOT in the deleteFromTables allowlist. Deleting the
// participant rows we created (and the entities they point at, ON DELETE
// CASCADE clears the participant rows) keeps the shared DB otherwise untouched.
async function cleanupStream(streamId: string): Promise<void> {
  await testDb`
    DELETE FROM public.entities
    WHERE id IN (SELECT entity_id FROM public.stream_participants WHERE stream_id = ${streamId})`;
  await testDb`DELETE FROM public.stream_participants WHERE stream_id = ${streamId}`;
}

const touchedStreams: string[] = [];
afterEach(async () => {
  for (const s of touchedStreams.splice(0)) await cleanupStream(s);
});

// Capture the /graph-agent POST body without running the real agent.
function interceptGraphAgent(): { calls: Array<{ url: string; body: any }>; restore: () => void } {
  const calls: Array<{ url: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/graph-agent')) {
      let body: any;
      try {
        body = JSON.parse(init?.body ?? '{}');
      } catch {
        body = undefined;
      }
      calls.push({ url, body });
      return new Response(JSON.stringify({ result: 'mocked-report' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

describe('assistant-label detection (nmemo-3f9.2)', () => {
  it('detects ASSISTANT:/AI:/BOT: turn labels case-insensitively', () => {
    expect(textHasAssistantTurns('USER: hi\nASSISTANT: hello')).toBe(true);
    expect(textHasAssistantTurns('ai: sure thing')).toBe(true);
    expect(textHasAssistantTurns('Bot: ok')).toBe(true);
  });

  it('returns false for narrative prose with no role labels (Frankenstein path)', () => {
    expect(textHasAssistantTurns('Victor assembled the creature from disparate parts.')).toBe(false);
    // "assistant" as a plain word (not a turn label) must not trip the detector.
    expect(textHasAssistantTurns('She hired an assistant last spring.')).toBe(false);
  });
});

describe('resolveStreamParticipants (nmemo-3f9.2)', () => {
  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable())) skipCtx(ctx);
  });

  it('seeds only USER for narrative text and emits its resolved entity id', async () => {
    const stream = `${RUN}-prose`;
    touchedStreams.push(stream);
    const p = await resolveStreamParticipants(stream, 'A purely narrative chunk with no turns.');
    expect(p.userEntityId).toBeTruthy();
    expect(p.assistantEntityId).toBeUndefined();
    expect(p.block).toContain('## Participants in this stream');
    expect(p.block).toContain(`USER -> entity ${p.userEntityId}`);
    expect(p.block).not.toContain('ASSISTANT ->');
  });

  it('seeds USER + ASSISTANT when assistant turns are present', async () => {
    const stream = `${RUN}-chat`;
    touchedStreams.push(stream);
    const p = await resolveStreamParticipants(stream, 'USER: hey\nASSISTANT: hi there');
    expect(p.userEntityId).toBeTruthy();
    expect(p.assistantEntityId).toBeTruthy();
    expect(p.userEntityId).not.toBe(p.assistantEntityId);
    expect(p.block).toContain(`USER -> entity ${p.userEntityId}`);
    expect(p.block).toContain(`ASSISTANT -> entity ${p.assistantEntityId}`);
    // The assistant speaker is the 'assistant' entity type (3f9.1 schema).
    const rows = await testDb`SELECT entity_type FROM public.entities WHERE id = ${p.assistantEntityId!}`;
    expect(rows[0]?.entity_type).toBe('assistant');
  });

  it('is stable per stream — re-resolving returns the same speaker ids', async () => {
    const stream = `${RUN}-stable`;
    touchedStreams.push(stream);
    const a = await resolveStreamParticipants(stream, 'USER: x\nASSISTANT: y');
    const b = await resolveStreamParticipants(stream, 'USER: again\nASSISTANT: still');
    expect(b.userEntityId).toBe(a.userEntityId);
    expect(b.assistantEntityId).toBe(a.assistantEntityId);
  });
});

describe('store persists stream_id in the Qdrant payload (nmemo-3f9.2)', () => {
  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) skipCtx(ctx);
  });

  it('persists the provided stream_id', async () => {
    const stream = `${RUN}-store`;
    const id = await store('hello stream world', { streamId: stream, source: 'test' });
    const mem = await getMemory(id);
    expect(mem?.payload?.stream_id).toBe(stream);
  });

  it("defaults to 'default' when stream_id is omitted (back-compat)", async () => {
    const id = await store('hello default stream', { source: 'test' });
    const mem = await getMemory(id);
    expect(mem?.payload?.stream_id).toBe('default');
  });
});

describe('extract threads stream_id + participants to /graph-agent (nmemo-3f9.2)', () => {
  let intercept: ReturnType<typeof interceptGraphAgent>;
  afterEach(() => intercept?.restore());

  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) skipCtx(ctx);
  });

  it('propagates the explicit stream_id and a Participants block with resolved ids', async () => {
    const stream = `${RUN}-extract`;
    touchedStreams.push(stream);
    // Real store (embeds + Qdrant write). Then intercept the agent call so we
    // assert the request body extract() builds.
    const id = await store('USER: what is the plan?\nASSISTANT: ship it', {
      streamId: stream,
      source: 'test',
    });
    intercept = interceptGraphAgent();
    await extract(id);

    const call = intercept.calls.find((c) => c.url.includes('/graph-agent'));
    expect(call, 'extract() must POST to /graph-agent').toBeTruthy();
    expect(call!.body.stream_id).toBe(stream);
    expect(call!.body.participants).toContain('## Participants in this stream');
    // The resolved USER + ASSISTANT entity ids are present in the block.
    const seeded = await testDb`
      SELECT entity_id, speaker_key FROM public.stream_participants WHERE stream_id = ${stream}`;
    expect(seeded.length).toBe(2);
    for (const row of seeded) {
      expect(call!.body.participants).toContain(row.entity_id);
    }
  });

  it("uses the 'default' stream and seeds only USER when stream_id was omitted (back-compat)", async () => {
    // The shared 'default' stream user is idempotent (findOrCreateSpeaker keys
    // on (stream_id, speaker_key)), so we leave it seeded rather than deleting a
    // row other suites may rely on.
    const id = await store('A narrative chunk. No turn labels here.', { source: 'test' });
    intercept = interceptGraphAgent();
    await extract(id);

    const call = intercept.calls.find((c) => c.url.includes('/graph-agent'));
    expect(call!.body.stream_id).toBe('default');
    expect(call!.body.participants).toContain('USER -> entity');
    expect(call!.body.participants).not.toContain('ASSISTANT ->');
  });
});
