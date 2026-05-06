import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, notes, sections } from '../db/index.js';
import { recordFact, getEntityById } from '../services/nmemo-client.js';

export const noteRoutes = new Hono();

type NoteRow = typeof notes.$inferSelect;

function shapeNote(row: NoteRow) {
  return {
    id: row.id,
    learnerId: row.learnerId,
    sectionId: row.sectionId,
    anchorText: row.anchorText,
    contentMd: row.contentMd,
    promotedToGraph: row.promotedToGraph === 1,
    factId: row.factId,
    createdAt: row.createdAt,
  };
}

/**
 * POST /api/notes
 * Body: { sectionId, anchorText, contentMd }
 * Creates a new note. Returns the created row.
 */
noteRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    sectionId?: string;
    anchorText?: string;
    contentMd?: string;
  }>();

  const sectionId = (body.sectionId || '').trim();
  const anchorText = (body.anchorText || '').trim();
  const contentMd = (body.contentMd || '').trim();

  if (!sectionId) return c.json({ error: 'sectionId is required' }, 400);
  if (!anchorText) return c.json({ error: 'anchorText is required' }, 400);
  if (!contentMd) return c.json({ error: 'contentMd is required' }, 400);

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.insert(notes).values({
    id,
    learnerId: 'default',
    sectionId,
    anchorText,
    contentMd,
    promotedToGraph: 0,
    factId: null,
    createdAt,
  });

  const [row] = await db.select().from(notes).where(eq(notes.id, id));
  return c.json(shapeNote(row), 200);
});

/**
 * GET /api/notes?section_id=…&include_promoted=true|false
 * Default include_promoted=true. Filter optional.
 */
noteRoutes.get('/', async (c) => {
  const sectionId = c.req.query('section_id');
  const includePromoted = c.req.query('include_promoted') !== 'false';

  const conds: ReturnType<typeof eq>[] = [];
  if (sectionId) conds.push(eq(notes.sectionId, sectionId));
  if (!includePromoted) conds.push(eq(notes.promotedToGraph, 0));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db.select().from(notes)
    .where(where)
    .orderBy(desc(notes.createdAt));

  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)` })
    .from(notes)
    .where(where);

  return c.json({
    notes: rows.map(shapeNote),
    total: Number(total),
  });
});

/**
 * PATCH /api/notes/:id
 * Body: { contentMd }
 * Updates note content. 404 if missing.
 */
noteRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ contentMd?: string }>();
  const contentMd = (body.contentMd || '').trim();
  if (!contentMd) return c.json({ error: 'contentMd is required' }, 400);

  const [existing] = await db.select().from(notes).where(eq(notes.id, id));
  if (!existing) return c.json({ error: 'Note not found' }, 404);

  await db.update(notes).set({ contentMd }).where(eq(notes.id, id));
  const [row] = await db.select().from(notes).where(eq(notes.id, id));
  return c.json(shapeNote(row));
});

/** DELETE /api/notes/:id — 404 if missing. */
noteRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const [existing] = await db.select().from(notes).where(eq(notes.id, id));
  if (!existing) return c.json({ error: 'Note not found' }, 404);
  await db.delete(notes).where(eq(notes.id, id));
  return c.json({ ok: true, id });
});

/**
 * POST /api/notes/:id/promote
 * Body: { kind: 'understanding' | 'confusion', conceptName?: string }
 * Promotes the note to the Nmemo graph as a learner fact.
 *
 * Concept resolution: explicit conceptName wins. Otherwise falls back to the
 * first concept on the note's section (sections.conceptEntityIds[0]) and
 * resolves its canonicalName. Returns 400 if no concept can be determined.
 *
 * Already-promoted notes return 409 with the existing fact_id.
 * Graph-update failure returns 502 and DOES NOT mark the note as promoted
 * (so the learner can retry).
 */
noteRoutes.post('/:id/promote', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    kind?: 'understanding' | 'confusion';
    conceptName?: string;
  }>();

  const kind = body.kind;
  if (kind !== 'understanding' && kind !== 'confusion') {
    return c.json({ error: "kind must be 'understanding' or 'confusion'" }, 400);
  }

  const [note] = await db.select().from(notes).where(eq(notes.id, id));
  if (!note) return c.json({ error: 'Note not found' }, 404);

  if (note.promotedToGraph === 1) {
    return c.json(
      { error: 'note already promoted', factId: note.factId },
      409,
    );
  }

  // Resolve concept name.
  let conceptName = (body.conceptName || '').trim();
  if (!conceptName) {
    // Fall back to the section's first concept entity.
    const [section] = await db.select().from(sections).where(eq(sections.id, note.sectionId));
    if (!section) {
      return c.json({ error: 'note section missing; cannot resolve concept' }, 400);
    }
    let conceptIds: string[] = [];
    try {
      const parsed = JSON.parse(section.conceptEntityIds || '[]');
      if (Array.isArray(parsed)) conceptIds = parsed as string[];
    } catch { /* empty array */ }
    const firstId = conceptIds[0];
    if (!firstId) {
      return c.json(
        { error: 'no conceptName provided and section has no concepts' },
        400,
      );
    }
    try {
      const entity = await getEntityById(firstId);
      if (!entity) {
        return c.json(
          { error: `section's first concept (${firstId}) not found in graph` },
          400,
        );
      }
      conceptName = entity.canonicalName;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'graph lookup failed', detail: msg }, 502);
    }
  }

  // Build the record_understanding / record_confusion call.
  const isUnderstanding = kind === 'understanding';
  const params = {
    subjectName: 'Learner',
    subjectType: 'person',
    predicate: isUnderstanding ? 'understands' : 'confused_by',
    objectName: conceptName,
    objectType: 'concept',
    confidence: isUnderstanding ? 0.7 : 0.5,
    sourceText: isUnderstanding
      ? `note: ${note.contentMd}`
      : `note (confusion): ${note.contentMd}`,
  };

  let factId: string;
  try {
    const result = await recordFact(params);
    factId = result.factId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`note promote: graph update failed: ${msg}`);
    return c.json({ error: 'graph update failed', detail: msg }, 502);
  }

  await db.update(notes)
    .set({ promotedToGraph: 1, factId })
    .where(eq(notes.id, id));
  const [updated] = await db.select().from(notes).where(eq(notes.id, id));
  return c.json({ ...shapeNote(updated), factId, conceptName, kind });
});
