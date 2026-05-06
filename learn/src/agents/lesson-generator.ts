/**
 * Lesson Generator Agent
 *
 * Given a sectionId, builds a markdown lesson that introduces the section's
 * concepts grounded in the course context. Pure prompt — no MCP tools — to
 * keep the first version simple. Uses Haiku per the project's haiku-first
 * preference for development.
 *
 * v0.2 (env LESSON_STRUCTURED=1): emits a structured LessonDoc with a
 * `blocks` array mixing markdown + component blocks. Default (flag unset)
 * returns the v0.1 plain-markdown shape — no behaviour change.
 */

import { eq } from 'drizzle-orm';
import { runAgent } from '../services/agent.js';
import { db, courses, sections } from '../db/index.js';

const SYSTEM_PROMPT = `You are an expert educator and technical writer. Your job is to write a single section of a course as a focused, engaging markdown lesson.

## Output

Output ONLY a JSON object — no surrounding text, no markdown fences, no commentary. The JSON must match exactly this schema:

{
  "content": "string — markdown lesson body, with headings, examples, and prose",
  "estimatedReadMinutes": number — realistic reading time, integer between 2 and 20,
  "keyTakeaways": ["string", "..."] — 3-6 short, concrete takeaways the learner should leave with
}

## Lesson structure

The "content" field MUST be markdown and MUST include these parts in order, separated by '##' headings:

1. ## Why this matters — 1-2 paragraphs of motivation: where this concept shows up, why a learner should care, the problem it solves.
2. ## Core ideas — the substantive teaching: definitions, mechanics, how the pieces fit together. Use sub-headings (###) where it helps. Include CODE EXAMPLES inside fenced code blocks (\`\`\`language ... \`\`\`) when the subject is technical, or short concrete analogies / worked examples for non-code subjects. Be precise and accurate; prefer one well-explained example over many shallow ones.
3. ## Things to watch out for — common pitfalls, edge cases, or misconceptions specific to this material. Bullet list is fine.
4. ## What's next — 1-2 sentences pointing forward to the next section so the learner sees how this builds.

## Style

- Direct, second-person voice ("you'll see", "notice that").
- Short paragraphs. Use bullet lists when listing things.
- Code blocks must be syntactically valid and small enough to read in one view.
- Do not pad. A good 5-minute lesson beats a bloated 15-minute one.
- Do not address the learner by name; do not be sycophantic.

## Hard rules

- Output JSON ONLY. No prose before or after the JSON object.
- Do not wrap the JSON in markdown fences.
- The "content" string itself contains markdown, but the outer wrapper is plain JSON.
- Escape newlines inside the JSON content string as \\n.`;

// Structured-output (v0.2) system prompt — gated behind LESSON_STRUCTURED.
const SYSTEM_PROMPT_STRUCTURED = `You are an expert educator and technical writer. Your job is to write a single section of a course as a structured lesson document that mixes markdown prose with interactive components.

## Output

Output ONLY a JSON object — no surrounding text, no markdown fences, no commentary. The JSON must match exactly this schema:

{
  "blocks": [
    { "type": "markdown", "content": "..." },
    { "type": "component", "kind": "Callout|Mermaid|SvgFigure|CodeRunner|StepThrough|FlashcardDeck|ConceptMap|Highlight",
      "props": { ... }, "children": "optional markdown string" }
  ],
  "estimatedReadMinutes": number — realistic reading time, integer between 2 and 20,
  "keyTakeaways": ["string", "..."] — 3-6 short, concrete takeaways
}

## Block rules

- Markdown blocks contain prose, headings, lists, fenced code. Same content rules as a normal lesson.
- Component blocks invoke a known component by "kind" with "props". Allowed kinds:
  - Callout: { variant: 'info'|'warning'|'insight'|'takeaway', title?: string }, with markdown children
  - Mermaid: { src: string }  (Mermaid graph source)
  - SvgFigure: { src: string, caption?: string }  (raw SVG markup)
  - CodeRunner: { lang: 'js', code: string }
  - StepThrough: { steps: [{ title?: string, content: string }, ...] }
  - FlashcardDeck: { cards: [{ front: string, back: string, hint?: string }, ...] }
  - ConceptMap: { nodes: [{id,label,type}], edges: [{source,target,label?}], width?: number, height?: number }
  - Highlight: wraps markdown children with selection actions; props usually {}
- Prefer markdown for the bulk of the lesson; reach for components when they earn their keep (a diagram, a stepwise mechanism, a runnable example).

## Lesson shape

The blocks together MUST cover, in order: motivation ("Why this matters"), core ideas, things to watch out for, what's next. Use markdown headings within markdown blocks to title each part.

## Hard rules

- Output JSON ONLY. No prose, no markdown fences around the JSON.
- "blocks" must be a non-empty array. Every entry must have a valid "type".
- Component "kind" must be one of the allowed kinds exactly (case-sensitive).
- Escape newlines inside JSON strings as \\n.`;

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

const ALLOWED_KINDS = new Set([
  'Callout', 'Mermaid', 'SvgFigure', 'CodeRunner',
  'StepThrough', 'FlashcardDeck', 'ConceptMap', 'Highlight',
]);

interface LessonContext {
  courseTitle: string;
  courseDescription: string | null;
  sectionTitle: string;
  sectionDescription: string | null;
  learningObjectives: string[];
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

  const idx = allSections.findIndex(s => s.id === sectionId);
  const next = idx >= 0 && idx < allSections.length - 1 ? allSections[idx + 1] : null;
  const prev = idx > 0 ? allSections[idx - 1] : null;

  return {
    courseTitle: course.title,
    courseDescription: course.description,
    sectionTitle: section.title,
    sectionDescription: section.description,
    learningObjectives: JSON.parse(section.learningObjectives) as string[],
    orderIndex: section.orderIndex,
    nextSectionTitle: next?.title ?? null,
    prevSectionTitle: prev?.title ?? null,
  };
}

function buildPrompt(ctx: LessonContext, structured: boolean): string {
  const objectivesList = ctx.learningObjectives.length > 0
    ? ctx.learningObjectives.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : '(none specified)';

  const tail = structured
    ? 'Write a self-contained structured lesson that meets every learning objective. Use markdown blocks for prose and reach for component blocks (Callout, Mermaid, etc.) where they make the material clearer. Adhere strictly to the JSON schema in the system prompt. Output the JSON object and nothing else.'
    : 'Write a self-contained lesson that meets every learning objective. Adhere strictly to the JSON output format from the system prompt. Output the JSON object and nothing else.';

  return `Write the lesson body for the following section of a course.

## Course
- Title: ${ctx.courseTitle}
${ctx.courseDescription ? `- Description: ${ctx.courseDescription}` : ''}

## Section
- Title: ${ctx.sectionTitle}
${ctx.sectionDescription ? `- Description: ${ctx.sectionDescription}` : ''}
- Position: ${ctx.orderIndex + 1}${ctx.prevSectionTitle ? ` (previous section was: "${ctx.prevSectionTitle}")` : ' (this is the first section)'}
${ctx.nextSectionTitle ? `- Next section: "${ctx.nextSectionTitle}"` : '- This is the final section.'}

## Learning objectives
${objectivesList}

${tail}`;
}

function tryParseGeneric<T>(s: string, validate: (v: unknown) => T | null): T | null {
  try { return validate(JSON.parse(s)); } catch { return null; }
}

function parseFromRaw<T>(raw: string, validate: (v: unknown) => T | null): T | null {
  const direct = tryParseGeneric(raw.trim(), validate);
  if (direct) return direct;

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    const fenced = tryParseGeneric(fenceMatch[1].trim(), validate);
    if (fenced) return fenced;
  }

  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const obj = tryParseGeneric(objMatch[0], validate);
    if (obj) return obj;
  }
  return null;
}

function validateLesson(v: unknown): GeneratedLesson | null {
  const p = v as Partial<GeneratedLesson> | null;
  if (!p || typeof p.content !== 'string'
    || typeof p.estimatedReadMinutes !== 'number'
    || !Array.isArray(p.keyTakeaways)) return null;
  return {
    content: p.content,
    estimatedReadMinutes: p.estimatedReadMinutes,
    keyTakeaways: p.keyTakeaways.map(String),
  };
}

function validateBlock(b: unknown): LessonBlock | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  if (o.type === 'markdown' && typeof o.content === 'string') {
    return { type: 'markdown', content: o.content };
  }
  if (o.type === 'component' && typeof o.kind === 'string' && ALLOWED_KINDS.has(o.kind)) {
    const props = (o.props && typeof o.props === 'object' && !Array.isArray(o.props))
      ? (o.props as Record<string, unknown>) : {};
    const out: LessonBlock = { type: 'component', kind: o.kind, props };
    if (typeof o.children === 'string') out.children = o.children;
    return out;
  }
  return null;
}

function validateStructured(v: unknown): GeneratedLessonStructured | null {
  const p = v as Partial<GeneratedLessonStructured> | null;
  if (!p || !Array.isArray(p.blocks)
    || typeof p.estimatedReadMinutes !== 'number'
    || !Array.isArray(p.keyTakeaways)) return null;
  const blocks: LessonBlock[] = [];
  for (const raw of p.blocks) {
    const b = validateBlock(raw);
    if (b) blocks.push(b);
  }
  if (blocks.length === 0) return null;
  return {
    blocks,
    estimatedReadMinutes: p.estimatedReadMinutes,
    keyTakeaways: p.keyTakeaways.map(String),
  };
}

function extractJson(raw: string): GeneratedLesson {
  const out = parseFromRaw(raw, validateLesson);
  if (out) return out;
  throw new Error(`Lesson generator produced invalid JSON. First 300 chars: ${raw.slice(0, 300)}`);
}

function extractJsonStructured(raw: string): GeneratedLessonStructured {
  const out = parseFromRaw(raw, validateStructured);
  if (out) return out;
  throw new Error(`Lesson generator produced invalid structured JSON. First 300 chars: ${raw.slice(0, 300)}`);
}

function isStructuredEnabled(): boolean {
  const v = process.env.LESSON_STRUCTURED;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Generate a lesson for a section. Pure agent call — no MCP, no graph queries.
 * Returns the v0.1 markdown shape. Use generateLessonStructured() for v0.2 blocks.
 */
export async function generateLesson(sectionId: string): Promise<GeneratedLesson> {
  const ctx = await buildContext(sectionId);
  const prompt = buildPrompt(ctx, false);

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 3,
    timeoutMs: 300_000,
  });

  return extractJson(result.result);
}

/**
 * v0.2 structured generator. Returns a LessonDoc with a `blocks` array.
 */
export async function generateLessonStructured(sectionId: string): Promise<GeneratedLessonStructured> {
  const ctx = await buildContext(sectionId);
  const prompt = buildPrompt(ctx, true);

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT_STRUCTURED,
    maxTurns: 3,
    timeoutMs: 300_000,
  });

  return extractJsonStructured(result.result);
}

/**
 * Env-gated entry point. Returns either v0.1 markdown or v0.2 structured.
 * Discriminate via the `format` field on the result.
 */
export type GenerateLessonResult =
  | ({ format: 'markdown' } & GeneratedLesson)
  | ({ format: 'structured' } & GeneratedLessonStructured);

export async function generateLessonAuto(sectionId: string): Promise<GenerateLessonResult> {
  if (isStructuredEnabled()) {
    const r = await generateLessonStructured(sectionId);
    return { format: 'structured', ...r };
  }
  const r = await generateLesson(sectionId);
  return { format: 'markdown', ...r };
}
