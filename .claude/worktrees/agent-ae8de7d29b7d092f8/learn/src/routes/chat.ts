import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db, chatSessions, chatMessages, courses, sections } from '../db/index.js';
import { eq, and, desc, asc } from 'drizzle-orm';
import { processChatMessage } from '../agents/chat-tutor.js';

export const chatRoutes = new Hono();

chatRoutes.get('/sessions', async (c) => {
  const sessions = await db.select().from(chatSessions).orderBy(desc(chatSessions.createdAt));
  return c.json(sessions);
});

chatRoutes.post('/sessions', async (c) => {
  const body = await c.req.json<{ courseId?: string; sectionId?: string; title?: string }>();
  const id = randomUUID();
  await db.insert(chatSessions).values({
    id,
    courseId: body.courseId ?? null,
    sectionId: body.sectionId ?? null,
    learnerId: 'default',
    title: body.title ?? null,
  });
  return c.json({ id }, 201);
});

// Section-scoped thread lookup. Returns the (learner, section) thread, creating
// it on first call so the section view can mount the chat sidebar idempotently.
// The courseId is denormalised onto the session for cheap filtering.
chatRoutes.get('/sections/:sectionId/session', async (c) => {
  const sectionId = c.req.param('sectionId');
  const learnerId = 'default';

  const [existing] = await db.select().from(chatSessions)
    .where(and(eq(chatSessions.sectionId, sectionId), eq(chatSessions.learnerId, learnerId)))
    .orderBy(desc(chatSessions.createdAt))
    .limit(1);
  if (existing) return c.json({ id: existing.id });

  const [section] = await db.select({ courseId: sections.courseId })
    .from(sections).where(eq(sections.id, sectionId));
  if (!section) return c.json({ error: 'Section not found' }, 404);

  const id = randomUUID();
  await db.insert(chatSessions).values({
    id,
    courseId: section.courseId,
    sectionId,
    learnerId,
    title: null,
  });
  return c.json({ id }, 201);
});

chatRoutes.get('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const messages = await db.select().from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt));
  return c.json(messages);
});

chatRoutes.post('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const body = await c.req.json<{ content: string }>();
  if (!body.content?.trim()) return c.json({ error: 'content is required' }, 400);

  // Get session to find course/section context
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return c.json({ error: 'Session not found' }, 404);

  let courseTopic: string | undefined;
  if (session.courseId) {
    const [course] = await db.select({ topic: courses.topic })
      .from(courses).where(eq(courses.id, session.courseId));
    courseTopic = course?.topic ?? undefined;
  }

  let sectionTitle: string | undefined;
  let sectionExcerpt: string | undefined;
  if (session.sectionId) {
    const [section] = await db.select({
      title: sections.title,
      lessonContent: sections.lessonContent,
      lessonBlocks: sections.lessonBlocks,
    }).from(sections).where(eq(sections.id, session.sectionId));
    if (section) {
      sectionTitle = section.title;
      // Prefer plain markdown content for the excerpt; if only structured
      // blocks exist, collapse markdown blocks into a string for grounding.
      if (section.lessonContent) {
        sectionExcerpt = section.lessonContent;
      } else if (section.lessonBlocks) {
        try {
          const blocks = JSON.parse(section.lessonBlocks);
          if (Array.isArray(blocks)) {
            sectionExcerpt = blocks
              .filter((b) => b && b.type === 'markdown' && typeof b.content === 'string')
              .map((b) => b.content as string)
              .join('\n\n');
          }
        } catch { /* malformed; skip excerpt */ }
      }
    }
  }

  // Store user message
  const userMsgId = randomUUID();
  await db.insert(chatMessages).values({
    id: userMsgId,
    sessionId,
    role: 'user',
    content: body.content,
  });

  // Get recent history for context
  const history = await db.select().from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(12);

  const orderedHistory = history.reverse().filter(m => m.id !== userMsgId);

  // Run tutor agent
  const result = await processChatMessage({
    message: body.content,
    history: orderedHistory.map(m => ({ role: m.role, content: m.content })),
    courseTopic,
    sectionTitle,
    sectionExcerpt,
  });

  // Store assistant response. When the tutor returned structured blocks, the
  // canonical render-target is response_blocks; content holds a plain-text
  // collapse so legacy clients still see something sensible.
  const assistantMsgId = randomUUID();
  const responseBlocksJson = result.blocks && result.blocks.length > 0
    ? JSON.stringify(result.blocks)
    : null;
  await db.insert(chatMessages).values({
    id: assistantMsgId,
    sessionId,
    role: 'assistant',
    content: result.response,
    nmemoUpdates: result.nmemoUpdates.length > 0 ? JSON.stringify(result.nmemoUpdates) : null,
    responseBlocks: responseBlocksJson,
  });

  return c.json({
    id: assistantMsgId,
    role: 'assistant',
    content: result.response,
    responseBlocks: result.blocks ?? null,
  });
});
