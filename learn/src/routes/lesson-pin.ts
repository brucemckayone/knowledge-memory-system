import { Hono } from 'hono';

export const lessonPinRoutes = new Hono();

// Soft-parsed body shape for POST /api/lesson-pin. The real handler lands with
// the lesson-overlay feature in v0.3 and will validate strictly; this stub just
// echoes whatever fields the frontend sent so devs can see what learners try
// to pin pre-launch.
type PinBody = {
  sessionId?: unknown;
  messageId?: unknown;
  blockIndex?: unknown;
  sectionId?: unknown;
};

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * POST /api/lesson-pin — STUB. Always responds 501. The real handler arrives
 * with the lesson-overlay feature in v0.3; for now we accept any body, log
 * what we got, and return a clear "not implemented yet" reason so the
 * frontend can surface a "Coming soon" toast. We do not 400 on bad input —
 * the goal of this stub is to make the "not yet" signal unambiguous.
 */
lessonPinRoutes.post('/', async (c) => {
  let raw: PinBody = {};
  try {
    const parsed = await c.req.json<PinBody>();
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch {
    // Body was missing or not JSON — fine for a stub. Just log and stub-respond.
  }

  const sessionId = asString(raw.sessionId);
  const messageId = asString(raw.messageId);
  const blockIndex = asInt(raw.blockIndex);
  const sectionId = asString(raw.sectionId);

  console.log(
    `[lesson-pin stub] session=${sessionId ?? '-'} message=${messageId ?? '-'} block=${blockIndex ?? '-'}${sectionId ? ` section=${sectionId}` : ''}`,
  );

  return c.json(
    {
      ok: false,
      reason: 'lesson_overlays not yet implemented (phase 5)',
      received: { sessionId, messageId, blockIndex, sectionId },
    },
    501,
  );
});
