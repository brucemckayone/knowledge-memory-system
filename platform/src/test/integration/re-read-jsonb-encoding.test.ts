/**
 * MNEMO-1f4 regression — re-read jsonb columns must persist as real jsonb
 * OBJECTS/ARRAYS, not JSON string scalars.
 *
 * The bug: `${JSON.stringify(x)}::jsonb` makes postgres-js bind the JS string
 * under a jsonb cast as a JSON *string scalar* (jsonb_typeof = 'string'). The
 * read path tolerated it (parseJsonb JSON.parses a string), so /current,/all read
 * fine — but selectThreadsWorthALetter arm (b) indexes `prev_reply->>'recordedAt'`,
 * which is NULL on a scalar, so a replied thread was NEVER selected and the
 * responding letter NEVER composed. The fix writes `${JSON.stringify(x)}::text::jsonb`
 * at every site (recordReply.prev_reply + composeReReadLetter.annotations/thread_focus_entity_ids).
 *
 * This suite exercises recordReply (the prev_reply site) end-to-end against the
 * live test DB and asserts BOTH the storage type (jsonb_typeof = 'object') and the
 * functional outcome (arm (b) now selects the replied thread). composeReReadLetter's
 * array sites use the identical `::text::jsonb` pattern (needs ml-services to
 * exercise; covered by the same fix).
 *
 * Runs against testDb (vitest.config.ts global setup → cognitive_test). No ML/LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recordReply, selectThreadsWorthALetter, getLetterByThread } from '../../services/re-read.js';
import { testDb, randomUUID } from '../setup.js';

const compositionId = randomUUID();
const threadEntityId = randomUUID();
const replyMemoryId = randomUUID();
// composed_at strictly in the past so a now() reply lands AFTER it (arm (b)).
const composedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe('re-read jsonb encoding (MNEMO-1f4)', () => {
  beforeAll(async () => {
    // A current, non-intro letter on a fresh thread, no reply yet. annotations /
    // thread_focus_entity_ids seeded as real jsonb literals (not under test here).
    await testDb`
      INSERT INTO public.re_read_letters (
        composition_id, user_id, thread_entity_id, thread_focus_entity_ids,
        eyebrow, body, annotations, is_intro_letter, is_hard_topic, is_current, composed_at, prev_reply
      ) VALUES (
        ${compositionId}::uuid, 'v1', ${threadEntityId}::uuid, '[]'::jsonb,
        'mnemo-1f4 · regression', 'a body for the regression letter.', '[]'::jsonb,
        FALSE, FALSE, TRUE, ${composedAt}::timestamptz, NULL
      )
    `;
  });

  afterAll(async () => {
    await testDb`DELETE FROM public.re_read_letters WHERE composition_id = ${compositionId}::uuid`;
  });

  it('recordReply persists prev_reply as a jsonb OBJECT, not a string scalar', async () => {
    await recordReply({
      letterCompositionId: compositionId,
      replyMemoryId,
      transcript: 'a reply that should land as a jsonb object.',
      recordedAt: new Date().toISOString(),
      threadFocusEntityIds: [], // no entity link → no FK requirement
    });

    const rows = (await testDb`
      SELECT jsonb_typeof(prev_reply) AS t
        FROM public.re_read_letters
       WHERE composition_id = ${compositionId}::uuid
    `) as unknown as Array<{ t: string }>;
    // The bug stored 'string'; the fix stores 'object'.
    expect(rows[0]?.t).toBe('object');

    // And the in-SQL key index the patrol relies on must resolve (NULL on a scalar).
    const recAt = (await testDb`
      SELECT (prev_reply->>'recordedAt') AS rec_at
        FROM public.re_read_letters
       WHERE composition_id = ${compositionId}::uuid
    `) as unknown as Array<{ rec_at: string | null }>;
    expect(recAt[0]?.rec_at).toBeTruthy();
  });

  it('read path surfaces the reply (object decodes to PrevReply)', async () => {
    const letter = await getLetterByThread(threadEntityId);
    expect(letter?.prevReply?.replyMemoryId).toBe(replyMemoryId);
    expect(letter?.prevReply?.transcript).toContain('jsonb object');
  });

  it('selectThreadsWorthALetter selects the replied thread via arm (b)', async () => {
    const picked = await selectThreadsWorthALetter();
    expect(picked.map((p) => p.entityId)).toContain(threadEntityId);
  });
});
