import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, chatSessions, chatMessages, sections } from '../db/index.js';
import { applyEditOp, validateBlock, OverlayError } from '../services/lesson-overlay.js';
import type { LessonBlock } from '../services/lesson-overlay.js';

export const lessonPinRoutes = new Hono();

interface PinBody {
  sessionId?: unknown;
  messageId?: unknown;
  blockIndex?: unknown;
  sectionId?: unknown;
}

/**
 * POST /api/lesson-pin — pin a chat-bubble component block into the section's
 * lesson overlay. Target section comes from chatSessions.sectionId, falling
 * back to body.sectionId for non-section-scoped chats.
 */
lessonPinRoutes.post('/', async (c) => {
  let body: PinBody = {};
  try {
    body = await c.req.json<PinBody>();
  } catch {
    return c.json({ ok: false, errorText: 'invalid JSON body' }, 400);
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  const blockIndex = typeof body.blockIndex === 'number' && Number.isInteger(body.blockIndex)
    ? body.blockIndex
    : -1;
  if (!sessionId) return c.json({ ok: false, errorText: 'sessionId is required' }, 400);
  if (!messageId) return c.json({ ok: false, errorText: 'messageId is required' }, 400);
  if (blockIndex < 0) return c.json({ ok: false, errorText: 'blockIndex must be a non-negative integer' }, 400);

  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return c.json({ ok: false, errorText: 'chat session not found' }, 404);

  const explicitSectionId = typeof body.sectionId === 'string' && body.sectionId.length > 0
    ? body.sectionId
    : null;
  const targetSectionId = session.sectionId ?? explicitSectionId;
  if (!targetSectionId) {
    return c.json(
      { ok: false, errorText: 'no section context — section-scoped chat or explicit sectionId required' },
      400,
    );
  }

  const [section] = await db.select({ id: sections.id })
    .from(sections).where(eq(sections.id, targetSectionId));
  if (!section) return c.json({ ok: false, errorText: 'section not found' }, 404);

  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
  if (!message) return c.json({ ok: false, errorText: 'chat message not found' }, 404);
  if (message.sessionId !== sessionId) {
    return c.json({ ok: false, errorText: 'message does not belong to session' }, 400);
  }

  let blocks: unknown;
  try {
    blocks = message.responseBlocks ? JSON.parse(message.responseBlocks) : null;
  } catch {
    return c.json({ ok: false, errorText: 'message responseBlocks is not valid JSON' }, 400);
  }
  if (!Array.isArray(blocks)) {
    return c.json({ ok: false, errorText: 'message has no structured response blocks to pin' }, 400);
  }
  if (blockIndex >= blocks.length) {
    return c.json({ ok: false, errorText: `blockIndex ${blockIndex} out of range (0..${blocks.length - 1})` }, 400);
  }

  const raw = blocks[blockIndex] as { type?: unknown } | null;
  if (!raw || raw.type !== 'component') {
    return c.json({ ok: false, errorText: 'only component blocks are pinnable' }, 400);
  }

  let block: LessonBlock;
  try {
    block = validateBlock(raw);
  } catch (err) {
    if (err instanceof OverlayError) {
      return c.json({ ok: false, errorText: err.message }, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, errorText: msg }, 500);
  }

  try {
    const overlay = await applyEditOp(
      targetSectionId,
      { kind: 'insert_block', afterIndex: 9_999_999, block },
      'default',
    );
    return c.json({
      ok: true,
      overlay: {
        id: overlay.id,
        version: overlay.version,
        sectionId: overlay.sectionId,
        blockCount: overlay.blocks.length,
        createdAt: overlay.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof OverlayError) {
      const code = (err.status === 400 || err.status === 404 || err.status === 409 ? err.status : 500) as 400 | 404 | 409 | 500;
      return c.json({ ok: false, errorText: err.message }, code);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, errorText: msg }, 500);
  }
});
