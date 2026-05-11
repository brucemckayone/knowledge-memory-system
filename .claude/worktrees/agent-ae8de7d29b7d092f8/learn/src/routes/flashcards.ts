import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, flashcards, flashcardReviews } from '../db/index.js';
import { recordFact, getEntityById } from '../services/nmemo-client.js';

export const flashcardRoutes = new Hono();

/** POST /api/flashcards/:id/review — record knew/didn't-know review and feed graph. */
flashcardRoutes.post('/:id/review', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ knew: boolean }>();
  if (typeof body.knew !== 'boolean') {
    return c.json({ error: 'knew must be a boolean' }, 400);
  }

  const [card] = await db.select().from(flashcards).where(eq(flashcards.id, id));
  if (!card) return c.json({ error: 'Flashcard not found' }, 404);

  const reviewId = randomUUID();
  const reviewedAt = new Date().toISOString();
  await db.insert(flashcardReviews).values({
    id: reviewId,
    flashcardId: id,
    learnerId: 'default',
    knew: body.knew ? 1 : 0,
    reviewedAt,
  });

  const confidence = body.knew ? 0.8 : 0.3;
  let graphUpdate: { factId: string; confidence: number } | null = null;
  try {
    const entity = await getEntityById(card.conceptEntityId);
    if (!entity) {
      console.warn(`flashcard review: concept entity ${card.conceptEntityId} not found`);
    } else {
      const result = await recordFact({
        subjectName: 'Learner',
        subjectType: 'person',
        predicate: 'understands',
        objectName: entity.canonicalName,
        objectType: entity.entityType || 'concept',
        confidence,
        sourceText: `flashcard review: ${card.frontText}`,
      });
      graphUpdate = { factId: result.factId, confidence };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`flashcard review: graph update failed: ${msg}`);
  }

  return c.json({ ok: true, reviewId, reviewedAt, graphUpdate });
});
