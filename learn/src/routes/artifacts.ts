/**
 * /api/artifacts — direct artifact generation endpoints.
 *
 * The chat tutor and lesson generator use the MCP tool generate_artifact;
 * this route provides a non-MCP path for two surfaces:
 *   POST /preview           — smoke test: generate and return spec, no DB write.
 *   POST /sections/:id/at-highlight — generate + insert at highlight position
 *                                     in the section's lesson overlay.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, sections, courses } from '../db/index.js';
import {
  generateArtifact,
  verifyArtifact,
  parseCheckInlineScripts,
  type ArtifactIntent,
  type ArtifactSpec,
  ARTIFACT_LIBRARIES,
} from '../agents/artifact-generator.js';
import type { LessonBlock } from '../agents/lesson-generator.js';
import {
  applyEditOp,
  getLatestOverlay,
  OverlayError,
  type EditOp,
} from '../services/lesson-overlay.js';

export const artifactRoutes = new Hono();

const VALID_INTENTS: ReadonlySet<ArtifactIntent> = new Set([
  'diagram', 'animate', 'plot', 'walkthrough', 'free',
]);

function isIntent(v: unknown): v is ArtifactIntent {
  return typeof v === 'string' && (VALID_INTENTS as Set<string>).has(v);
}

interface PreviewBody {
  intent?: unknown;
  context?: unknown;
  lessonContext?: unknown;
  sectionId?: unknown;
}

artifactRoutes.post('/preview', async (c) => {
  let body: PreviewBody = {};
  try {
    body = await c.req.json<PreviewBody>();
  } catch {
    return c.json({ ok: false, errorText: 'invalid JSON body' }, 400);
  }

  if (!isIntent(body.intent)) {
    return c.json({ ok: false, errorText: `intent must be one of: ${Array.from(VALID_INTENTS).join(', ')}` }, 400);
  }
  const context = typeof body.context === 'string' ? body.context.trim() : '';
  if (!context) return c.json({ ok: false, errorText: 'context is required' }, 400);

  // Optional grounding: hydrate lesson context from a section if requested.
  let lessonContext: string | undefined;
  if (typeof body.lessonContext === 'string') lessonContext = body.lessonContext;
  if (typeof body.sectionId === 'string' && body.sectionId.length > 0) {
    try {
      const [section] = await db.select({
        title: sections.title,
        lessonContent: sections.lessonContent,
        lessonBlocks: sections.lessonBlocks,
      }).from(sections).where(eq(sections.id, body.sectionId));
      if (section) {
        lessonContext = lessonContext ?? section.lessonContent ?? collapseBlocks(section.lessonBlocks);
      }
    } catch (err) {
      console.warn('[artifacts/preview] section hydration failed:', err);
    }
  }

  const result = await generateArtifact({
    intent: body.intent,
    context,
    lessonContext,
  });

  if (result.ok) {
    return c.json({ ok: true, spec: result.spec, libraries: ARTIFACT_LIBRARIES });
  }
  return c.json({ ok: false, errorText: result.errorText, raw: result.raw }, 500);
});

interface AtHighlightBody {
  intent?: unknown;
  selectedText?: unknown;
  /** Optional — when omitted, the artifact is appended at the end of the lesson. */
  afterIndex?: unknown;
  /** Optional — extra context the learner wants to nudge the agent with. */
  hint?: unknown;
}

artifactRoutes.post('/sections/:sectionId/at-highlight', async (c) => {
  const sectionId = c.req.param('sectionId');
  let body: AtHighlightBody = {};
  try {
    body = await c.req.json<AtHighlightBody>();
  } catch {
    return c.json({ ok: false, errorText: 'invalid JSON body' }, 400);
  }

  if (!isIntent(body.intent)) {
    return c.json({ ok: false, errorText: `intent must be one of: ${Array.from(VALID_INTENTS).join(', ')}` }, 400);
  }
  const selectedText = typeof body.selectedText === 'string' ? body.selectedText.trim() : '';
  if (!selectedText) return c.json({ ok: false, errorText: 'selectedText is required' }, 400);
  const afterIndex = typeof body.afterIndex === 'number' && Number.isFinite(body.afterIndex)
    ? Math.floor(body.afterIndex)
    : -1; // -1 = append at end (handled by buildEditOp/applyEditOp)
  const hint = typeof body.hint === 'string' ? body.hint.trim() : '';

  // Hydrate lesson context for grounding.
  let lessonContext: string | undefined;
  let courseTitle: string | undefined;
  try {
    const [section] = await db.select({
      title: sections.title,
      lessonContent: sections.lessonContent,
      lessonBlocks: sections.lessonBlocks,
      courseId: sections.courseId,
    }).from(sections).where(eq(sections.id, sectionId));
    if (!section) return c.json({ ok: false, errorText: 'Section not found' }, 404);
    lessonContext = section.lessonContent ?? collapseBlocks(section.lessonBlocks);
    if (section.courseId) {
      const [course] = await db.select({ title: courses.title }).from(courses).where(eq(courses.id, section.courseId));
      courseTitle = course?.title;
    }
  } catch (err) {
    console.warn('[artifacts/at-highlight] section hydration failed:', err);
  }

  const contextLines: string[] = [];
  if (courseTitle) contextLines.push(`Course: ${courseTitle}`);
  contextLines.push(`Selected lesson text: "${selectedText}"`);
  if (hint) contextLines.push(`Learner hint: ${hint}`);
  const context = contextLines.join('\n');

  const result = await generateArtifact({
    intent: body.intent,
    context,
    lessonContext,
    learnerState: { sectionId },
  });
  if (!result.ok) {
    return c.json({ ok: false, errorText: result.errorText }, 500);
  }

  // Insert as a new component block right after the highlight position.
  const block: LessonBlock = {
    type: 'component',
    kind: 'Artifact',
    props: {
      title: result.spec.title,
      html: result.spec.html,
      libraries: result.spec.libraries,
      height: result.spec.height,
    },
  };

  // afterIndex semantics in lesson-overlay: -1 inserts at start; we want the
  // artifact to land AFTER the highlighted block. The frontend computes the
  // block index of the highlight; if it can't, it omits afterIndex and the
  // artifact appends at the end (we use a large index for that).
  const op: EditOp = afterIndex >= 0
    ? { kind: 'insert_block', afterIndex, block }
    : { kind: 'insert_block', afterIndex: 9_999_999, block };

  try {
    const overlay = await applyEditOp(sectionId, op, 'default');
    return c.json({
      ok: true,
      spec: result.spec,
      overlay: {
        id: overlay.id,
        version: overlay.version,
        sectionId: overlay.sectionId,
        learnerId: overlay.learnerId,
        blockCount: overlay.blocks.length,
        createdAt: overlay.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof OverlayError) {
      // OverlayError.status is the HTTP status code (typed loosely); narrow for Hono.
      const code = (err.status === 400 || err.status === 404 || err.status === 409 ? err.status : 500) as 400 | 404 | 409 | 500;
      return c.json({ ok: false, errorText: err.message, status: code }, code);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, errorText: msg }, 500);
  }
});

interface RepairBlockBody {
  blockIndex?: unknown;
  errors?: unknown;
}

// Learner-driven repair: re-runs the verify pass on an already-rendered
// artifact, optionally seeded with concrete runtime errors the iframe
// reported. Up to 2 verify passes (matches generateArtifact's budget).
artifactRoutes.post('/sections/:sectionId/repair-block', async (c) => {
  const sectionId = c.req.param('sectionId');
  let body: RepairBlockBody = {};
  try {
    body = await c.req.json<RepairBlockBody>();
  } catch {
    return c.json({ ok: false, errorText: 'invalid JSON body' }, 400);
  }

  if (typeof body.blockIndex !== 'number' || !Number.isInteger(body.blockIndex) || body.blockIndex < 0) {
    return c.json({ ok: false, errorText: 'blockIndex must be a non-negative integer' }, 400);
  }
  const blockIndex = body.blockIndex;
  const errors: string[] = Array.isArray(body.errors)
    ? body.errors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).slice(0, 20)
    : [];

  const overlay = await getLatestOverlay(sectionId, 'default');
  if (!overlay) {
    return c.json({ ok: false, errorText: `No overlay exists for section ${sectionId}` }, 404);
  }
  if (blockIndex >= overlay.blocks.length) {
    return c.json({ ok: false, errorText: `blockIndex ${blockIndex} out of range (overlay has ${overlay.blocks.length} block(s))` }, 404);
  }
  const target = overlay.blocks[blockIndex];
  if (!target || target.type !== 'component' || target.kind !== 'Artifact') {
    return c.json({ ok: false, errorText: `Block at index ${blockIndex} is not an Artifact component` }, 400);
  }

  const props = (target.props && typeof target.props === 'object') ? target.props as Record<string, unknown> : {};
  const html = typeof props.html === 'string' ? props.html : '';
  if (!html) {
    return c.json({ ok: false, errorText: 'Artifact block has no html to repair' }, 400);
  }
  const libraries = Array.isArray(props.libraries)
    ? (props.libraries.filter((l: unknown) => typeof l === 'string') as ArtifactSpec['libraries'])
    : [];
  const height = typeof props.height === 'number' ? props.height : 360;
  const title = typeof props.title === 'string' ? props.title : 'Artifact';
  const spec: ArtifactSpec = { title, html, libraries, height };

  // Hydrate section title for verifier context.
  let sectionTitle = '';
  try {
    const [section] = await db.select({ title: sections.title }).from(sections).where(eq(sections.id, sectionId));
    if (section?.title) sectionTitle = section.title;
  } catch (err) {
    console.warn('[artifacts/repair-block] section hydration failed:', err);
  }

  const contextLines: string[] = [];
  if (sectionTitle) contextLines.push(`Section: ${sectionTitle}`);
  if (errors.length > 0) {
    contextLines.push('Repair pass: artifact reported the following runtime errors at render time:');
    for (const e of errors) contextLines.push(`  - ${e}`);
  } else {
    contextLines.push('Repair pass: learner requested a regeneration. Run the general bug-checklist.');
  }
  const context = contextLines.join('\n');

  // Up to 2 verify passes — same budget as generateArtifact's fix loop.
  let current = spec;
  let fixed = await verifyArtifact(current, 'free', context, errors);
  if (fixed) current = fixed;
  let postErrors = parseCheckInlineScripts(current.html);
  if (postErrors.length > 0) {
    fixed = await verifyArtifact(current, 'free', context, postErrors);
    if (fixed) current = fixed;
    postErrors = parseCheckInlineScripts(current.html);
  }
  if (postErrors.length > 0) {
    return c.json({
      ok: false,
      errorText: `repair could not produce valid JS after 2 passes: ${postErrors.join('; ')}`,
    }, 500);
  }

  const newBlock: LessonBlock = {
    type: 'component',
    kind: 'Artifact',
    props: {
      title: current.title,
      html: current.html,
      libraries: current.libraries,
      height: current.height,
    },
  };
  const op: EditOp = { kind: 'replace_block', index: blockIndex, block: newBlock };

  try {
    const next = await applyEditOp(sectionId, op, 'default');
    return c.json({
      ok: true,
      overlay: {
        id: next.id,
        version: next.version,
        sectionId: next.sectionId,
        blockCount: next.blocks.length,
        createdAt: next.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof OverlayError) {
      const code = (err.status === 400 || err.status === 404 || err.status === 409 ? err.status : 500) as 400 | 404 | 409 | 500;
      return c.json({ ok: false, errorText: err.message, status: code }, code);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, errorText: msg }, 500);
  }
});

function collapseBlocks(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const blocks = JSON.parse(raw);
    if (!Array.isArray(blocks)) return undefined;
    return blocks
      .filter((b) => b && b.type === 'markdown' && typeof b.content === 'string')
      .map((b) => b.content as string)
      .join('\n\n');
  } catch {
    return undefined;
  }
}
