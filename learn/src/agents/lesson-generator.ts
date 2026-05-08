/**
 * Lesson Generator — multi-agent orchestrator.
 *
 * Pipeline:
 *   1. Outliner (Sonnet 4.6 max)        — one call, designs structure +
 *                                          tags every artifact moment.
 *   2. Prose writers (Sonnet 4.6 high)  — one call per prose item, in
 *                                          parallel.
 *   3. Artifact builders (Opus 4.7 max) — one per artifact, in bounded
 *                                          parallel batches. Reuses the
 *                                          existing artifact-generator and
 *                                          component-generator agents.
 *   4. Composer (pure code)             — interleaves outputs in outline
 *                                          order; assembles LessonBlock[].
 *
 * Quality of the resulting lesson is the priority — cost and wall-clock
 * are secondary. Typical wall-clock per section: outline (1-3 min) +
 * max(prose 1-3 min in parallel, artifacts 2-8 min in parallel) ≈ 4-12 min.
 *
 * Legacy path (single-shot Haiku) is preserved behind env
 * LEARN_LESSON_GENERATOR_LEGACY=1 for fallback during validation.
 */

import { eq } from 'drizzle-orm';
import { runAgent } from '../services/agent.js';
import { db, courses, sections } from '../db/index.js';
import {
  generateLessonOutline,
  type LessonOutline,
  type OutlineItem,
  type ProseItem,
  type ArtifactItem,
  type OutlineFixedKind,
  type OutlineArtifactIntent,
} from './lesson-outliner.js';
import { writeProseBlock } from './lesson-prose.js';
import { generateArtifact, type ArtifactSpec } from './artifact-generator.js';
import { generateComponent, type ComponentKindName } from './component-generator.js';
import {
  loadLearnerLessonContext,
  type LearnerLessonContext,
} from './learner-lesson-context.js';

// ---------------------------------------------------------------------------
// Public types — preserved from v0.2 so route layer doesn't change.
// ---------------------------------------------------------------------------

export interface GeneratedLesson {
  content: string;
  estimatedReadMinutes: number;
  keyTakeaways: string[];
}

export type LessonBlock =
  | { type: 'markdown'; content: string }
  | { type: 'component'; kind: string; props: Record<string, unknown>; children?: string };

export interface GeneratedLessonStructured {
  blocks: LessonBlock[];
  estimatedReadMinutes: number;
  keyTakeaways: string[];
}

export type GenerateLessonResult =
  | ({ format: 'markdown' } & GeneratedLesson)
  | ({ format: 'structured' } & GeneratedLessonStructured);

export type LessonStage = 'outlining' | 'writing_prose' | 'building_artifacts' | 'composing';

export interface GenerateLessonOpts {
  /** Called whenever the pipeline transitions to a new stage. Best-effort —
      callback failures must not abort generation. */
  onStage?: (stage: LessonStage) => void | Promise<void>;
}

const ALLOWED_KINDS = new Set([
  'Callout', 'Mermaid', 'SvgFigure', 'CodeRunner',
  'StepThrough', 'FlashcardDeck', 'ConceptMap', 'Highlight', 'Artifact',
]);

// ---------------------------------------------------------------------------
// Context loading — section + course + neighbour titles.
// ---------------------------------------------------------------------------

interface LessonContext {
  courseTitle: string;
  courseDescription: string | null;
  sectionTitle: string;
  sectionDescription: string | null;
  learningObjectives: string[];
  /** Nmemo entity IDs attached to this section by the course generator.
   *  Empty array when the section has no graph-aware concepts. */
  conceptEntityIds: string[];
  orderIndex: number;
  nextSectionTitle: string | null;
  prevSectionTitle: string | null;
}

async function buildContext(sectionId: string): Promise<LessonContext> {
  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId));
  if (!section) throw new Error(`Section ${sectionId} not found`);

  const [course] = await db.select().from(courses).where(eq(courses.id, section.courseId));
  if (!course) throw new Error(`Course ${section.courseId} not found`);

  const allSections = await db.select().from(sections)
    .where(eq(sections.courseId, section.courseId))
    .orderBy(sections.orderIndex);

  const idx = allSections.findIndex((s) => s.id === sectionId);
  const next = idx >= 0 && idx < allSections.length - 1 ? allSections[idx + 1] : null;
  const prev = idx > 0 ? allSections[idx - 1] : null;

  let conceptEntityIds: string[] = [];
  try {
    const parsed = JSON.parse(section.conceptEntityIds ?? '[]');
    if (Array.isArray(parsed)) {
      conceptEntityIds = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
  } catch (err) {
    console.warn(`[lesson-generator] could not parse conceptEntityIds for section ${sectionId}:`, err);
  }

  return {
    courseTitle: course.title,
    courseDescription: course.description,
    sectionTitle: section.title,
    sectionDescription: section.description,
    learningObjectives: JSON.parse(section.learningObjectives) as string[],
    conceptEntityIds,
    orderIndex: section.orderIndex,
    nextSectionTitle: next?.title ?? null,
    prevSectionTitle: prev?.title ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — artifact builders. Each artifact item maps to either the
// component-generator (fixed kinds) or the artifact-generator (freeform).
// ---------------------------------------------------------------------------

const FIXED_TO_COMPONENT: Record<OutlineFixedKind, ComponentKindName> = {
  Mermaid: 'Mermaid',
  Callout: 'Callout',
  FlashcardDeck: 'FlashcardDeck',
  ConceptMap: 'ConceptMap',
  StepThrough: 'StepThrough',
  CodeRunner: 'CodeRunner',
  SvgFigure: 'SvgFigure',
};

interface ArtifactSuccess {
  ok: true;
  block: LessonBlock;
}
interface ArtifactFail {
  ok: false;
  reason: string;
}

function neighbourProseDigest(outline: LessonOutline, item: ArtifactItem): string {
  // Surrounding prose intents make a useful grounding payload for the
  // builder agent — it can't see the prose text (parallelism), but the
  // intents tell it where in the lesson the widget sits.
  const idx = outline.items.findIndex((it) => it.id === item.id);
  const window = (start: number, end: number) =>
    outline.items.slice(Math.max(0, start), end)
      .filter((it) => it.kind === 'prose')
      .map((it) => `- ${(it as ProseItem).intent}`).join('\n');
  const before = window(idx - 2, idx);
  const after = window(idx + 1, idx + 3);
  const parts = [
    `Lesson title: ${outline.title}`,
    `Intro: ${outline.intro}`,
  ];
  if (before) parts.push('Prose just before this artifact:', before);
  if (after) parts.push('Prose just after this artifact:', after);
  return parts.join('\n');
}

/** Project a `LearnerLessonContext` onto the artifact-builder's `learnerState`
 *  shape. Cold-start (or undefined) collapses to a minimal payload that does
 *  not surface any personalisation cue in downstream prompts. */
function projectLearnerStateForArtifact(
  ctx: LessonContext,
  learner: LearnerLessonContext | undefined,
): {
  conceptName: string;
  forgottenConcepts?: string[];
  confusions?: Array<{ concept: string; misconception: string }>;
  missingPrereqs?: string[];
} {
  const base = { conceptName: ctx.sectionTitle };
  if (!learner || learner.coldStart === true) return base;
  const forgottenConcepts = learner.forgottenConcepts.map((f) => f.name);
  const confusions = learner.confusions.map((c) => ({ concept: c.concept, misconception: c.misconception }));
  const missingPrereqs = learner.missingPrereqs.map((p) => p.concept);
  return {
    ...base,
    ...(forgottenConcepts.length > 0 ? { forgottenConcepts } : {}),
    ...(confusions.length > 0 ? { confusions } : {}),
    ...(missingPrereqs.length > 0 ? { missingPrereqs } : {}),
  };
}

async function buildOneArtifact(
  outline: LessonOutline,
  item: ArtifactItem,
  ctx: LessonContext,
  learner: LearnerLessonContext | undefined,
): Promise<ArtifactSuccess | ArtifactFail> {
  if (item.type === 'fixed') {
    const kind = FIXED_TO_COMPONENT[item.fixedKind!];
    const result = await generateComponent({
      kind,
      context: item.spec,
      learnerState: projectLearnerStateForArtifact(ctx, learner),
    });
    if (result.kind === 'markdown') {
      return { ok: false, reason: `fixed-kind ${item.fixedKind} fell back to markdown` };
    }
    const block: LessonBlock = {
      type: 'component',
      kind: result.kind,
      props: result.props,
    };
    if (result.children) block.children = result.children;
    return { ok: true, block };
  }
  // freeform
  const intent: OutlineArtifactIntent = item.intent ?? 'free';
  const lessonContext = neighbourProseDigest(outline, item);
  const result = await generateArtifact({
    intent,
    context: item.spec,
    lessonContext,
    learnerState: projectLearnerStateForArtifact(ctx, learner),
  });
  if (!result.ok) {
    return { ok: false, reason: `artifact agent: ${result.errorText}` };
  }
  const spec: ArtifactSpec = result.spec;
  const block: LessonBlock = {
    type: 'component',
    kind: 'Artifact',
    props: {
      title: spec.title,
      html: spec.html,
      libraries: spec.libraries,
      height: spec.height,
    },
  };
  return { ok: true, block };
}

/**
 * Run artifact builders with bounded parallelism. Anthropic per-key rate
 * limits start to bite past ~4 simultaneous Opus-max calls; we cap at 3
 * so the lesson pipeline can co-exist with other generators.
 */
async function buildArtifactsBounded(
  outline: LessonOutline,
  artifacts: ArtifactItem[],
  ctx: LessonContext,
  learner: LearnerLessonContext | undefined,
  concurrency = 3,
): Promise<Map<string, ArtifactSuccess | ArtifactFail>> {
  const out = new Map<string, ArtifactSuccess | ArtifactFail>();
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, artifacts.length); w += 1) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= artifacts.length) return;
        const item = artifacts[idx]!;
        try {
          const r = await buildOneArtifact(outline, item, ctx, learner);
          out.set(item.id, r);
          if (!r.ok) {
            console.warn(`[lesson-generator] artifact ${item.id} failed: ${r.reason}`);
          } else {
            console.log(`[lesson-generator] artifact ${item.id} built (${item.type === 'fixed' ? item.fixedKind : `Artifact:${item.intent}`})`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[lesson-generator] artifact ${item.id} threw: ${msg}`);
          out.set(item.id, { ok: false, reason: msg });
        }
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Stage 4 — composer. Pure code, no LLM.
// ---------------------------------------------------------------------------

function isAllowedKind(k: string): boolean {
  return ALLOWED_KINDS.has(k);
}

function fallbackBlock(item: ArtifactItem, reason: string): LessonBlock {
  const tag = item.type === 'fixed' ? item.fixedKind : `Artifact:${item.intent}`;
  return {
    type: 'markdown',
    content: `_[Artifact generation failed for ${tag}: ${reason}]_`,
  };
}

function compose(
  outline: LessonOutline,
  proseById: Map<string, string>,
  artifactById: Map<string, ArtifactSuccess | ArtifactFail>,
): LessonBlock[] {
  const blocks: LessonBlock[] = [];
  blocks.push({ type: 'markdown', content: outline.intro });
  for (const item of outline.items) {
    if (item.kind === 'prose') {
      const md = proseById.get(item.id);
      if (md && md.trim().length > 0) {
        blocks.push({ type: 'markdown', content: md });
      } else {
        blocks.push({
          type: 'markdown',
          content: `_[Prose block ${item.id} failed to generate. Intent: ${item.intent}]_`,
        });
      }
      continue;
    }
    // artifact
    const got = artifactById.get(item.id);
    if (got && got.ok && isAllowedKind(got.block.type === 'component' ? got.block.kind : '')) {
      blocks.push(got.block);
    } else {
      const reason = got && !got.ok ? got.reason : 'no result';
      blocks.push(fallbackBlock(item, reason));
    }
  }
  blocks.push({ type: 'markdown', content: outline.outro });
  return blocks;
}

// ---------------------------------------------------------------------------
// Estimated read minutes + key takeaways.
// ---------------------------------------------------------------------------

function estimateReadMinutes(blocks: LessonBlock[]): number {
  // ~200 wpm reading speed for technical material. Components add ~30s each.
  let words = 0;
  let components = 0;
  for (const b of blocks) {
    if (b.type === 'markdown') {
      words += b.content.split(/\s+/).filter(Boolean).length;
    } else {
      components += 1;
      if (b.children) words += b.children.split(/\s+/).filter(Boolean).length;
    }
  }
  const minutes = Math.round(words / 200 + components * 0.5);
  return Math.max(2, Math.min(20, minutes));
}

interface TakeawaysInput {
  outline: LessonOutline;
  proseSample: string;
}

const TAKEAWAYS_SYSTEM_PROMPT = `You read a lesson outline and excerpt and extract 3-6 short, concrete key takeaways the learner should leave with.

Output ONLY a JSON object: { "takeaways": ["...", "..."] }. First char '{', last char '}'. No prose, no fences.

Each takeaway: 5-20 words, concrete, learner-oriented. No vague platitudes ("understand the basics"). State a specific fact, mechanism, or rule of thumb the lesson teaches.`;

async function generateTakeaways(input: TakeawaysInput): Promise<string[]> {
  const userPrompt = [
    `Lesson title: ${input.outline.title}`,
    `Intro: ${input.outline.intro}`,
    '',
    `Prose excerpts:`,
    input.proseSample.slice(0, 4000),
    '',
    `Outro: ${input.outline.outro}`,
    '',
    'Output the JSON.',
  ].join('\n');
  try {
    const result = await runAgent(userPrompt, {
      model: 'haiku',
      effort: 'low',
      systemPrompt: TAKEAWAYS_SYSTEM_PROMPT,
      tools: 'none',
      maxTurns: 1,
      timeoutMs: 60_000,
    });
    const raw = (result.result ?? '').trim();
    const obj = raw.match(/\{[\s\S]*\}/);
    if (!obj) return [];
    const parsed = JSON.parse(obj[0]) as { takeaways?: unknown };
    if (!Array.isArray(parsed.takeaways)) return [];
    return parsed.takeaways.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim()).slice(0, 6);
  } catch (err) {
    console.warn('[lesson-generator] takeaways extraction failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Orchestrator entry point.
// ---------------------------------------------------------------------------

async function generateLessonStructuredV3(
  sectionId: string,
  opts: GenerateLessonOpts = {},
): Promise<GeneratedLessonStructured> {
  const emit = async (stage: LessonStage): Promise<void> => {
    if (!opts.onStage) return;
    try { await opts.onStage(stage); } catch (err) {
      console.warn(`[lesson-generator] onStage(${stage}) callback threw:`, err);
    }
  };

  const ctx = await buildContext(sectionId);
  console.log(`[lesson-generator] starting pipeline for section ${sectionId} ("${ctx.sectionTitle}")`);

  // Single platform fetch for learner state. Degrades to cold-start on any
  // failure / timeout — pipeline must never abort because of a flaky platform
  // call. The same snapshot is threaded through every parallel stage.
  const learnerContext = await loadLearnerLessonContext(ctx.conceptEntityIds);
  // Pass the typed context downstream only when we're personalising. For
  // cold-start lessons we pass `undefined`, which makes outliner / prose /
  // artifact prompts byte-identical to the v0.3 baseline.
  const personalised: LearnerLessonContext | undefined =
    learnerContext.coldStart === false ? learnerContext : undefined;
  console.log(
    `[lesson-generator] learner-state: coldStart=${learnerContext.coldStart} ` +
    `facts=${learnerContext.relevantFacts.length} ` +
    `confusions=${learnerContext.confusions.length} ` +
    `forgotten=${learnerContext.forgottenConcepts.length} ` +
    `missingPrereqs=${learnerContext.missingPrereqs.length} ` +
    `(fetchedAt=${learnerContext.fetchedAt})`,
  );

  // Stage 1 — outline.
  await emit('outlining');
  const outline = await generateLessonOutline({
    courseTitle: ctx.courseTitle,
    courseDescription: ctx.courseDescription,
    sectionTitle: ctx.sectionTitle,
    sectionDescription: ctx.sectionDescription,
    learningObjectives: ctx.learningObjectives,
    orderIndex: ctx.orderIndex,
    prevSectionTitle: ctx.prevSectionTitle,
    nextSectionTitle: ctx.nextSectionTitle,
    learnerContext: personalised,
  });
  const proseItems = outline.items.filter((it): it is ProseItem => it.kind === 'prose');
  const artifactItems = outline.items.filter((it): it is ArtifactItem => it.kind === 'artifact');
  console.log(`[lesson-generator] outline has ${proseItems.length} prose, ${artifactItems.length} artifacts`);

  // Stages 2 + 3 — prose writers and artifact builders run concurrently.
  // We label the stage by what's still outstanding: start with writing_prose
  // (artifacts run alongside), and transition to building_artifacts once the
  // prose writers finish — artifacts are typically the long tail.
  await emit('writing_prose');
  const proseProm = Promise.all(proseItems.map(async (item) => {
    try {
      const md = await writeProseBlock({
        outline,
        item,
        courseTitle: ctx.courseTitle,
        sectionTitle: ctx.sectionTitle,
        sectionDescription: ctx.sectionDescription,
        learningObjectives: ctx.learningObjectives,
        learnerContext: personalised,
      });
      console.log(`[lesson-generator] prose ${item.id} written (${md.length} chars)`);
      return [item.id, md] as const;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lesson-generator] prose ${item.id} failed: ${msg}`);
      return [item.id, ''] as const;
    }
  }));

  const artifactProm = buildArtifactsBounded(outline, artifactItems, ctx, personalised, 3);

  // Track prose finishing independently so we can flip the stage label to
  // building_artifacts when only artifacts remain.
  const proseEntries = await proseProm;
  if (artifactItems.length > 0) {
    await emit('building_artifacts');
  }
  const artifactById = await artifactProm;
  const proseById = new Map<string, string>(proseEntries);

  // Stage 4 — compose.
  await emit('composing');
  const blocks = compose(outline, proseById, artifactById);

  // Validate every emitted block. Anything that fails the validator is
  // dropped and replaced with a placeholder to keep the lesson complete.
  const validated: LessonBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'markdown' && typeof b.content === 'string') {
      validated.push(b);
      continue;
    }
    if (b.type === 'component' && typeof b.kind === 'string' && isAllowedKind(b.kind)) {
      validated.push(b);
      continue;
    }
    validated.push({ type: 'markdown', content: '_[Block dropped: failed validation]_' });
  }

  // Takeaways from a prose sample.
  const proseSample = Array.from(proseById.values()).filter(Boolean).join('\n\n');
  const keyTakeaways = await generateTakeaways({ outline, proseSample });

  console.log(`[lesson-generator] composed lesson: ${validated.length} blocks, ${keyTakeaways.length} takeaways`);

  return {
    blocks: validated,
    estimatedReadMinutes: estimateReadMinutes(validated),
    keyTakeaways,
  };
}

// ---------------------------------------------------------------------------
// Legacy single-shot path (env-gated).
// ---------------------------------------------------------------------------

const LEGACY_SYSTEM_PROMPT = `You are an expert educator and technical writer. Your job is to write a single section of a course as a focused, engaging markdown lesson.

## Output

Output ONLY a JSON object — no surrounding text, no markdown fences, no commentary. The JSON must match exactly this schema:

{
  "content": "string — markdown lesson body",
  "estimatedReadMinutes": number — integer between 2 and 20,
  "keyTakeaways": ["string", "..."]
}

## Lesson structure

The "content" field MUST be markdown with these parts in order, separated by '##' headings:
1. ## Why this matters
2. ## Core ideas (with code examples in fenced blocks where technical)
3. ## Things to watch out for
4. ## What's next

## Style

- Direct, second-person voice. Short paragraphs. No padding.

## Hard rules

- Output JSON ONLY. No fences. Escape newlines inside the content string as \\n.`;

function buildLegacyPrompt(ctx: LessonContext): string {
  const objectives = ctx.learningObjectives.length > 0
    ? ctx.learningObjectives.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : '(none specified)';
  return `Write the lesson body for the following section.

## Course
- Title: ${ctx.courseTitle}
${ctx.courseDescription ? `- Description: ${ctx.courseDescription}` : ''}

## Section
- Title: ${ctx.sectionTitle}
${ctx.sectionDescription ? `- Description: ${ctx.sectionDescription}` : ''}
- Position: ${ctx.orderIndex + 1}${ctx.prevSectionTitle ? ` (previous: "${ctx.prevSectionTitle}")` : ' (first)'}
${ctx.nextSectionTitle ? `- Next: "${ctx.nextSectionTitle}"` : '- Final section.'}

## Learning objectives
${objectives}

Output the JSON only.`;
}

async function generateLessonLegacy(sectionId: string): Promise<GeneratedLesson> {
  const ctx = await buildContext(sectionId);
  const result = await runAgent(buildLegacyPrompt(ctx), {
    model: 'haiku',
    effort: 'low',
    systemPrompt: LEGACY_SYSTEM_PROMPT,
    maxTurns: 3,
    timeoutMs: 300_000,
  });
  const raw = (result.result ?? '').trim();
  const tryJson = (s: string): GeneratedLesson | null => {
    try {
      const p = JSON.parse(s) as Partial<GeneratedLesson>;
      if (typeof p.content !== 'string' || typeof p.estimatedReadMinutes !== 'number'
        || !Array.isArray(p.keyTakeaways)) return null;
      return {
        content: p.content,
        estimatedReadMinutes: p.estimatedReadMinutes,
        keyTakeaways: p.keyTakeaways.map(String),
      };
    } catch { return null; }
  };
  const direct = tryJson(raw);
  if (direct) return direct;
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    const fenced = tryJson(obj[0]);
    if (fenced) return fenced;
  }
  throw new Error(`Legacy lesson generator produced invalid JSON. First 300 chars: ${raw.slice(0, 300)}`);
}

function isLegacyEnabled(): boolean {
  const v = process.env.LEARN_LESSON_GENERATOR_LEGACY;
  return v === '1' || v === 'true' || v === 'yes';
}

// ---------------------------------------------------------------------------
// Public entry point — preserved signature.
// ---------------------------------------------------------------------------

export async function generateLessonAuto(
  sectionId: string,
  opts: GenerateLessonOpts = {},
): Promise<GenerateLessonResult> {
  if (isLegacyEnabled()) {
    // Legacy path is single-shot — emit a single 'composing' transition so
    // the UI gets one signal even on the legacy path.
    if (opts.onStage) { try { await opts.onStage('composing'); } catch { /* ignore */ } }
    const r = await generateLessonLegacy(sectionId);
    return { format: 'markdown', ...r };
  }
  const r = await generateLessonStructuredV3(sectionId, opts);
  return { format: 'structured', ...r };
}

// Re-exports for backwards compatibility with v0.2 callers (none in-tree
// today, but documented as public API in the original module).
export const generateLesson = generateLessonLegacy;
export const generateLessonStructured = generateLessonStructuredV3;
