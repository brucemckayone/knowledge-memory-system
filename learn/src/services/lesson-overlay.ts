/**
 * Lesson Overlay Service — per-learner edit layer on top of section.lessonBlocks.
 *
 * Canonical course content (sections.lessonBlocks / sections.lessonContent) is
 * never mutated. Each call to applyEditOp creates a new lesson_overlays row
 * with version = max(version) + 1 for the (learner_id, section_id) pair.
 * The UNIQUE(learner_id, section_id, version) constraint catches concurrent
 * writes — callers should treat that as a 409 race.
 */
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, lessonOverlays, sections } from '../db/index.js';

// Whitelist mirrors LessonRenderer.js KNOWN_KINDS / lesson-generator.ts ALLOWED_KINDS.
// Duplicated rather than imported because lesson-generator's set is not exported
// and the renderer is browser-only — both diverging would be a bug to fix at once.
const ALLOWED_COMPONENT_KINDS = new Set([
  'Callout', 'Mermaid', 'SvgFigure', 'CodeRunner',
  'StepThrough', 'FlashcardDeck', 'ConceptMap', 'Highlight',
]);

export type LessonBlock =
  | { type: 'markdown'; content: string }
  | { type: 'component'; kind: string; props: Record<string, unknown>; children?: string };

export type EditOp =
  | { kind: 'insert_block'; afterIndex: number; block: LessonBlock }
  | { kind: 'replace_block'; index: number; block: LessonBlock }
  | { kind: 'append_clarification'; markdown: string }
  | { kind: 'add_example'; block: LessonBlock };

export interface OverlayRow {
  id: string;
  learnerId: string;
  sectionId: string;
  blocks: LessonBlock[];
  version: number;
  createdAt: string;
}

export class OverlayError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'OverlayError';
  }
}

/**
 * Validate a block payload coming from an MCP/HTTP client. Returns the
 * normalized block or throws OverlayError(400) with a learner-friendly
 * message.
 */
export function validateBlock(b: unknown): LessonBlock {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new OverlayError('Block must be a non-null object', 400);
  }
  const o = b as Record<string, unknown>;
  if (o.type === 'markdown') {
    if (typeof o.content !== 'string') {
      throw new OverlayError('markdown block requires string `content`', 400);
    }
    return { type: 'markdown', content: o.content };
  }
  if (o.type === 'component') {
    if (typeof o.kind !== 'string' || !ALLOWED_COMPONENT_KINDS.has(o.kind)) {
      throw new OverlayError(
        `component block has invalid kind "${String(o.kind)}". Allowed: ${[...ALLOWED_COMPONENT_KINDS].join(', ')}`,
        400,
      );
    }
    const props = (o.props && typeof o.props === 'object' && !Array.isArray(o.props))
      ? (o.props as Record<string, unknown>)
      : {};
    const out: LessonBlock = { type: 'component', kind: o.kind, props };
    if (typeof o.children === 'string') out.children = o.children;
    return out;
  }
  throw new OverlayError(`Block type must be "markdown" or "component", got ${String(o.type)}`, 400);
}

function rowToOverlay(row: typeof lessonOverlays.$inferSelect): OverlayRow {
  let blocks: LessonBlock[] = [];
  try {
    const parsed = JSON.parse(row.blocks);
    if (Array.isArray(parsed)) blocks = parsed as LessonBlock[];
  } catch { /* corrupt row — return empty */ }
  return {
    id: row.id,
    learnerId: row.learnerId,
    sectionId: row.sectionId,
    blocks,
    version: row.version,
    createdAt: row.createdAt,
  };
}

/**
 * Latest overlay for (sectionId, learnerId), or null if none exists yet.
 */
export async function getLatestOverlay(
  sectionId: string,
  learnerId: string = 'default',
): Promise<OverlayRow | null> {
  const rows = await db.select().from(lessonOverlays)
    .where(and(eq(lessonOverlays.sectionId, sectionId), eq(lessonOverlays.learnerId, learnerId)))
    .orderBy(desc(lessonOverlays.version))
    .limit(1);
  return rows[0] ? rowToOverlay(rows[0]) : null;
}

/**
 * Full overlay history (newest first). Each row is a complete snapshot of
 * the blocks at that version — reverts copy from one of these directly.
 */
export async function getOverlayHistory(
  sectionId: string,
  learnerId: string = 'default',
): Promise<OverlayRow[]> {
  const rows = await db.select().from(lessonOverlays)
    .where(and(eq(lessonOverlays.sectionId, sectionId), eq(lessonOverlays.learnerId, learnerId)))
    .orderBy(desc(lessonOverlays.version));
  return rows.map(rowToOverlay);
}

/**
 * Read the current effective blocks for a section: latest overlay if one
 * exists, else the canonical section.lessonBlocks, else section.lessonContent
 * wrapped as a single markdown block, else [].
 */
async function loadCurrentBlocks(
  sectionId: string,
  learnerId: string,
): Promise<LessonBlock[]> {
  const latest = await getLatestOverlay(sectionId, learnerId);
  if (latest) return latest.blocks;

  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId));
  if (!section) throw new OverlayError(`Section ${sectionId} not found`, 404);

  if (section.lessonBlocks) {
    try {
      const parsed = JSON.parse(section.lessonBlocks);
      if (Array.isArray(parsed)) return parsed as LessonBlock[];
      // Some legacy rows stored a {blocks: [...]} envelope.
      if (parsed && Array.isArray((parsed as { blocks?: unknown }).blocks)) {
        return (parsed as { blocks: LessonBlock[] }).blocks;
      }
    } catch { /* fall through */ }
  }
  if (typeof section.lessonContent === 'string' && section.lessonContent.trim()) {
    return [{ type: 'markdown', content: section.lessonContent }];
  }
  return [];
}

function applyOpToBlocks(blocks: LessonBlock[], op: EditOp): LessonBlock[] {
  const next = blocks.slice();
  switch (op.kind) {
    case 'insert_block': {
      const block = validateBlock(op.block);
      const after = Number.isFinite(op.afterIndex) ? op.afterIndex : -1;
      const insertAt = after < 0 ? 0 : Math.min(after + 1, next.length);
      next.splice(insertAt, 0, block);
      return next;
    }
    case 'replace_block': {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= next.length) {
        throw new OverlayError(
          `replace_block index ${op.index} out of range (0..${next.length - 1})`,
          400,
        );
      }
      const block = validateBlock(op.block);
      next[op.index] = block;
      return next;
    }
    case 'append_clarification': {
      if (typeof op.markdown !== 'string' || op.markdown.length === 0) {
        throw new OverlayError('append_clarification requires non-empty `markdown` string', 400);
      }
      next.push({ type: 'markdown', content: op.markdown });
      return next;
    }
    case 'add_example': {
      const block = validateBlock(op.block);
      next.push(block);
      return next;
    }
    default: {
      const _exhaustive: never = op;
      throw new OverlayError(`Unknown edit op kind: ${(op as { kind: string }).kind}`, 400);
    }
  }
}

/**
 * Core entry point: load current blocks, apply op, insert a new overlay row
 * with version = current_max + 1. Returns the new row.
 *
 * Concurrency: max(version) is computed server-side; if two writers race they
 * may both attempt to insert the same version and one will hit the UNIQUE
 * constraint — that surfaces as a 409 in the route handler.
 */
export async function applyEditOp(
  sectionId: string,
  op: EditOp,
  learnerId: string = 'default',
): Promise<OverlayRow> {
  const current = await loadCurrentBlocks(sectionId, learnerId);
  const nextBlocks = applyOpToBlocks(current, op);

  const maxRow = await db.select({ maxV: sql<number>`max(${lessonOverlays.version})` })
    .from(lessonOverlays)
    .where(and(eq(lessonOverlays.sectionId, sectionId), eq(lessonOverlays.learnerId, learnerId)));
  const nextVersion = (maxRow[0]?.maxV ?? 0) + 1;

  const id = randomUUID();
  try {
    await db.insert(lessonOverlays).values({
      id,
      learnerId,
      sectionId,
      blocks: JSON.stringify(nextBlocks),
      version: nextVersion,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toUpperCase().includes('UNIQUE')) {
      throw new OverlayError(
        `Concurrent overlay write: version ${nextVersion} already exists for section ${sectionId}`,
        409,
      );
    }
    throw err;
  }

  // Read back the row to get authoritative createdAt.
  const [row] = await db.select().from(lessonOverlays).where(eq(lessonOverlays.id, id));
  if (!row) throw new Error(`Overlay row ${id} disappeared after insert`);
  return rowToOverlay(row);
}

/**
 * Revert by copying blocks from version N into a new (latest+1) row.
 * Throws OverlayError(404) if version N does not exist.
 */
export async function revertToVersion(
  sectionId: string,
  toVersion: number,
  learnerId: string = 'default',
): Promise<OverlayRow> {
  if (!Number.isInteger(toVersion) || toVersion < 1) {
    throw new OverlayError(`to_version must be a positive integer, got ${toVersion}`, 400);
  }

  const [target] = await db.select().from(lessonOverlays)
    .where(and(
      eq(lessonOverlays.sectionId, sectionId),
      eq(lessonOverlays.learnerId, learnerId),
      eq(lessonOverlays.version, toVersion),
    ));
  if (!target) {
    throw new OverlayError(
      `No overlay version ${toVersion} for section ${sectionId} (learner ${learnerId})`,
      404,
    );
  }

  const maxRow = await db.select({ maxV: sql<number>`max(${lessonOverlays.version})` })
    .from(lessonOverlays)
    .where(and(eq(lessonOverlays.sectionId, sectionId), eq(lessonOverlays.learnerId, learnerId)));
  const nextVersion = (maxRow[0]?.maxV ?? 0) + 1;

  const id = randomUUID();
  try {
    await db.insert(lessonOverlays).values({
      id,
      learnerId,
      sectionId,
      blocks: target.blocks,
      version: nextVersion,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toUpperCase().includes('UNIQUE')) {
      throw new OverlayError(
        `Concurrent overlay write during revert: version ${nextVersion} already exists`,
        409,
      );
    }
    throw err;
  }

  const [row] = await db.select().from(lessonOverlays).where(eq(lessonOverlays.id, id));
  if (!row) throw new Error(`Reverted overlay row ${id} disappeared after insert`);
  return rowToOverlay(row);
}

/**
 * Build an EditOp from a flat tool-call payload. Used by both the MCP handler
 * and the HTTP edit route to share validation. Throws OverlayError(400) on
 * malformed payloads.
 */
export function buildEditOp(payload: {
  op_kind?: unknown;
  after_index?: unknown;
  index?: unknown;
  block?: unknown;
  markdown?: unknown;
}): EditOp {
  const opKind = payload.op_kind;
  if (typeof opKind !== 'string') {
    throw new OverlayError('op_kind is required', 400);
  }
  switch (opKind) {
    case 'insert_block': {
      if (typeof payload.after_index !== 'number') {
        throw new OverlayError('insert_block requires numeric `after_index`', 400);
      }
      return {
        kind: 'insert_block',
        afterIndex: payload.after_index,
        block: validateBlock(payload.block),
      };
    }
    case 'replace_block': {
      if (typeof payload.index !== 'number') {
        throw new OverlayError('replace_block requires numeric `index`', 400);
      }
      return {
        kind: 'replace_block',
        index: payload.index,
        block: validateBlock(payload.block),
      };
    }
    case 'append_clarification': {
      if (typeof payload.markdown !== 'string' || payload.markdown.length === 0) {
        throw new OverlayError('append_clarification requires non-empty `markdown`', 400);
      }
      return { kind: 'append_clarification', markdown: payload.markdown };
    }
    case 'add_example': {
      // add_example accepts either an explicit block, or a markdown shorthand
      // (the bead description allows "markdown_or_component"). If a block was
      // provided we use it; otherwise we wrap markdown in a markdown block.
      if (payload.block !== undefined) {
        return { kind: 'add_example', block: validateBlock(payload.block) };
      }
      if (typeof payload.markdown === 'string' && payload.markdown.length > 0) {
        return {
          kind: 'add_example',
          block: { type: 'markdown', content: payload.markdown },
        };
      }
      throw new OverlayError('add_example requires either `block` or `markdown`', 400);
    }
    default:
      throw new OverlayError(
        `Unknown op_kind "${opKind}". Allowed: insert_block, replace_block, append_clarification, add_example`,
        400,
      );
  }
}
