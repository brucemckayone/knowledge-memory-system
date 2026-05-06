import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db, chatSessions, chatMessages, courses } from '../db/index.js';
import { eq, desc, asc } from 'drizzle-orm';
import { processChatMessage } from '../agents/chat-tutor.js';

export const chatRoutes = new Hono();

chatRoutes.get('/sessions', async (c) => {
  const sessions = await db.select().from(chatSessions).orderBy(desc(chatSessions.createdAt));
  return c.json(sessions);
});

chatRoutes.post('/sessions', async (c) => {
  const body = await c.req.json<{ courseId?: string; title?: string }>();
  const id = randomUUID();
  await db.insert(chatSessions).values({
    id,
    courseId: body.courseId ?? null,
    learnerId: 'default',
    title: body.title ?? null,
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

  // Get session to find course topic
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) return c.json({ error: 'Session not found' }, 404);

  let courseTopic: string | undefined;
  if (session.courseId) {
    const [course] = await db.select({ topic: courses.topic })
      .from(courses).where(eq(courses.id, session.courseId));
    courseTopic = course?.topic ?? undefined;
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
  });

  // Store assistant response
  const assistantMsgId = randomUUID();
  await db.insert(chatMessages).values({
    id: assistantMsgId,
    sessionId,
    role: 'assistant',
    content: result.response,
    nmemoUpdates: result.nmemoUpdates.length > 0 ? JSON.stringify(result.nmemoUpdates) : null,
  });

  return c.json({
    id: assistantMsgId,
    role: 'assistant',
    content: result.response,
  });
});
