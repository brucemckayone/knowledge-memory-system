import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db, chatSessions, chatMessages, courses, sections } from '../db/index.js';
import { eq, and, desc, asc } from 'drizzle-orm';
import { processChatMessage } from '../agents/chat-tutor.js';
import {
  getEntityById,
  getConcept,
  getStruggleAreas,
  getSameAsConcepts,
  type StruggleArea,
  type SameAsConceptLink,
} from '../services/nmemo-client.js';

export const chatRoutes = new Hono();

// ── Pre-fetch helper ─────────────────────────────────────────────────────
//
// Compels learner-state reads at the route layer (Option A). Before spawning
// the tutor agent, fetch concept confidences for the section's concepts plus
// struggle areas plus cross-course overlaps in parallel. Compose a small
// markdown context block that gets injected into the tutor's user prompt.
//
// Cold-start: any of these may return empty. We just produce an empty (or
// near-empty) block; the tutor handles it gracefully. Errors are swallowed
// per-call (Promise.allSettled) so a single MCP outage cannot block chat.

interface ConceptConfidence {
  conceptName: string;
  confidence: number;
  predicate: string;
  evidence?: string | null;
}

export interface BuildLearnerContextResult {
  block: string;
  conceptCount: number;
  hasGaps: boolean;
  hasOverlaps: boolean;
}

const PREFETCH_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Resolve section conceptEntityIds → entity names → learner concept-confidence
 * facts. Best-effort: per-id failures are skipped silently. Returns empty when
 * the section has no conceptEntityIds (cold-start safe).
 */
async function fetchConceptConfidences(conceptEntityIds: string[]): Promise<ConceptConfidence[]> {
  if (conceptEntityIds.length === 0) return [];
  // Resolve entity names first (cap at 8 to avoid fan-out on giant sections).
  const ids = conceptEntityIds.slice(0, 8);
  const entitySettled = await Promise.allSettled(
    ids.map((id) => withTimeout(getEntityById(id), PREFETCH_TIMEOUT_MS, `getEntityById(${id})`)),
  );
  const names: string[] = [];
  for (const s of entitySettled) {
    if (s.status === 'fulfilled' && s.value && typeof s.value.canonicalName === 'string') {
      names.push(s.value.canonicalName);
    }
  }
  if (names.length === 0) return [];

  const conceptSettled = await Promise.allSettled(
    names.map((n) => withTimeout(getConcept(n), PREFETCH_TIMEOUT_MS, `getConcept(${n})`)),
  );
  const out: ConceptConfidence[] = [];
  for (let i = 0; i < conceptSettled.length; i++) {
    const r = conceptSettled[i];
    if (r.status !== 'fulfilled') continue;
    const facts = r.value.facts ?? [];
    // Pick the most-recent learner fact about this concept, prefer 'understands'.
    const understands = facts.find((f) => f.predicate === 'understands');
    const fact = understands ?? facts[0];
    if (!fact) continue;
    out.push({
      conceptName: names[i],
      confidence: fact.confidence ?? 0,
      predicate: fact.predicate,
      evidence: fact.sourceText ?? null,
    });
  }
  return out;
}

/**
 * Compose a compact learner-state block from pre-fetched signals. Returns
 * empty string when nothing is known (cold-start). Caller injects this into
 * the tutor prompt under the "Learner's current state in this section"
 * heading defined in chat-tutor's system prompt.
 */
export function composeLearnerContextBlock(input: {
  conceptConfidences: ConceptConfidence[];
  struggle: { weakAreas: StruggleArea[]; confusions: StruggleArea[] };
  overlaps: SameAsConceptLink[];
  sectionConceptNames: string[];
}): BuildLearnerContextResult {
  const lines: string[] = [];
  const { conceptConfidences, struggle, overlaps, sectionConceptNames } = input;

  if (conceptConfidences.length > 0) {
    lines.push('Concept confidences:');
    for (const c of conceptConfidences) {
      const ev = c.evidence && c.evidence.length > 0 ? ` — "${c.evidence.slice(0, 80)}"` : '';
      lines.push(`- ${c.conceptName}: ${c.confidence.toFixed(2)} (${c.predicate})${ev}`);
    }
  }

  // Struggle: cap to first 5 of each, only if non-empty.
  const weak = struggle.weakAreas.slice(0, 5);
  const conf = struggle.confusions.slice(0, 5);
  if (weak.length > 0 || conf.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Recent gaps / struggles:');
    for (const w of weak) {
      const obj = w.objectValue ?? '(unknown concept)';
      lines.push(`- weak: ${obj} (conf=${w.confidence.toFixed(2)})`);
    }
    for (const c of conf) {
      const obj = c.objectValue ?? '(unknown concept)';
      lines.push(`- confused: ${obj}`);
    }
  }

  // Cross-course overlaps relevant to this section's concepts.
  if (overlaps.length > 0 && sectionConceptNames.length > 0) {
    const lower = sectionConceptNames.map((n) => n.toLowerCase());
    const relevant = overlaps.filter((l) =>
      lower.includes(l.a_name.toLowerCase()) || lower.includes(l.b_name.toLowerCase()),
    ).slice(0, 5);
    if (relevant.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Cross-course overlaps:');
      for (const o of relevant) {
        lines.push(`- ${o.a_name} ↔ ${o.b_name} (conf=${o.confidence.toFixed(2)}): ${o.reasoning.slice(0, 120)}`);
      }
    }
  }

  return {
    block: lines.join('\n'),
    conceptCount: conceptConfidences.length,
    hasGaps: weak.length + conf.length > 0,
    hasOverlaps: overlaps.length > 0,
  };
}

/**
 * Run the pre-fetch in parallel with timeouts. Always returns a result —
 * partial failures degrade to a smaller block. Cold-start (no facts in graph)
 * yields an empty block.
 */
export async function buildLearnerContext(
  conceptEntityIds: string[],
): Promise<BuildLearnerContextResult> {
  const [confSettled, struggleSettled, overlapsSettled] = await Promise.allSettled([
    fetchConceptConfidences(conceptEntityIds),
    withTimeout(getStruggleAreas(), PREFETCH_TIMEOUT_MS, 'getStruggleAreas'),
    withTimeout(getSameAsConcepts(), PREFETCH_TIMEOUT_MS, 'getSameAsConcepts'),
  ]);

  const conceptConfidences = confSettled.status === 'fulfilled' ? confSettled.value : [];
  const struggle = struggleSettled.status === 'fulfilled'
    ? struggleSettled.value
    : { weakAreas: [], confusions: [] };
  const overlaps = overlapsSettled.status === 'fulfilled' ? overlapsSettled.value.links : [];

  if (confSettled.status === 'rejected') console.warn('[chat] prefetch concepts failed:', confSettled.reason);
  if (struggleSettled.status === 'rejected') console.warn('[chat] prefetch struggle failed:', struggleSettled.reason);
  if (overlapsSettled.status === 'rejected') console.warn('[chat] prefetch overlaps failed:', overlapsSettled.reason);

  return composeLearnerContextBlock({
    conceptConfidences,
    struggle,
    overlaps,
    sectionConceptNames: conceptConfidences.map((c) => c.conceptName),
  });
}

// Exposed for unit-style testing.
export const __test = {
  composeLearnerContextBlock,
  buildLearnerContext,
};


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
  let presentationMode = false;
  if (session.courseId) {
    const [course] = await db.select({ topic: courses.topic, presentationMode: courses.presentationMode })
      .from(courses).where(eq(courses.id, session.courseId));
    courseTopic = course?.topic ?? undefined;
    presentationMode = Boolean(course?.presentationMode);
  }

  let sectionTitle: string | undefined;
  let sectionExcerpt: string | undefined;
  let conceptEntityIds: string[] = [];
  if (session.sectionId) {
    const [section] = await db.select({
      title: sections.title,
      lessonContent: sections.lessonContent,
      lessonBlocks: sections.lessonBlocks,
      conceptEntityIds: sections.conceptEntityIds,
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
      try {
        const ids = JSON.parse(section.conceptEntityIds);
        if (Array.isArray(ids)) conceptEntityIds = ids.filter((x): x is string => typeof x === 'string');
      } catch { /* malformed conceptEntityIds; skip pre-fetch */ }
    }
  }

  // Pre-fetch learner state in parallel BEFORE spawning the agent. Cold-start
  // safe: empty section / empty graph yields an empty block, and the tutor's
  // system prompt teaches it to handle that gracefully.
  let learnerContextBlock = '';
  try {
    const ctx = await buildLearnerContext(conceptEntityIds);
    learnerContextBlock = ctx.block;
  } catch (e) {
    console.warn('[chat] buildLearnerContext threw, falling back to empty block:', e);
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
    learnerContextBlock,
    presentationMode,
  });

  // Store assistant response. When the tutor returned structured blocks, the
  // canonical render-target is response_blocks; content holds a plain-text
  // collapse so legacy clients still see something sensible.
  const assistantMsgId = randomUUID();
  const responseBlocksJson = result.blocks && result.blocks.length > 0
    ? JSON.stringify(result.blocks)
    : null;

  // Stamp recordedAt on each update for the UI / audit trail. Done at the
  // route layer (single source of truth for time) — agent's own value is kept
  // when it provided one.
  const stampedUpdates = result.nmemoUpdates.map((u) => ({
    ...u,
    recordedAt: u.recordedAt ?? new Date().toISOString(),
  }));
  const nmemoUpdatesJson = stampedUpdates.length > 0
    ? JSON.stringify(stampedUpdates)
    : null;

  await db.insert(chatMessages).values({
    id: assistantMsgId,
    sessionId,
    role: 'assistant',
    content: result.response,
    nmemoUpdates: nmemoUpdatesJson,
    responseBlocks: responseBlocksJson,
  });

  return c.json({
    id: assistantMsgId,
    role: 'assistant',
    content: result.response,
    responseBlocks: result.blocks ?? null,
    nmemoUpdates: stampedUpdates,
  });
});
