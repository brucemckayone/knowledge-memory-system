/**
 * Lesson Generator Agent
 *
 * Given a sectionId, builds a markdown lesson that introduces the section's
 * concepts grounded in the course context. Pure prompt — no MCP tools — to
 * keep the first version simple. Uses Haiku per the project's haiku-first
 * preference for development.
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

export interface GeneratedLesson {
  content: string;
  estimatedReadMinutes: number;
  keyTakeaways: string[];
}

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

function buildPrompt(ctx: LessonContext): string {
  const objectivesList = ctx.learningObjectives.length > 0
    ? ctx.learningObjectives.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : '(none specified)';

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

Write a self-contained lesson that meets every learning objective. Adhere strictly to the JSON output format from the system prompt. Output the JSON object and nothing else.`;
}

function extractJson(raw: string): GeneratedLesson {
  // Try a few strategies in order: bare object, fenced block, first {...} match.
  const tryParse = (s: string): GeneratedLesson | null => {
    try {
      const parsed = JSON.parse(s) as Partial<GeneratedLesson>;
      if (typeof parsed.content === 'string'
        && typeof parsed.estimatedReadMinutes === 'number'
        && Array.isArray(parsed.keyTakeaways)) {
        return {
          content: parsed.content,
          estimatedReadMinutes: parsed.estimatedReadMinutes,
          keyTakeaways: parsed.keyTakeaways.map(String),
        };
      }
    } catch { /* fall through */ }
    return null;
  };

  // 1. Direct parse
  const direct = tryParse(raw.trim());
  if (direct) return direct;

  // 2. Strip ```json fences if present
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    const fenced = tryParse(fenceMatch[1].trim());
    if (fenced) return fenced;
  }

  // 3. First {...} balance match
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const obj = tryParse(objMatch[0]);
    if (obj) return obj;
  }

  throw new Error(`Lesson generator produced invalid JSON. First 300 chars: ${raw.slice(0, 300)}`);
}

/**
 * Generate a lesson for a section. Pure agent call — no MCP, no graph queries.
 */
export async function generateLesson(sectionId: string): Promise<GeneratedLesson> {
  const ctx = await buildContext(sectionId);
  const prompt = buildPrompt(ctx);

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 3,
    timeoutMs: 300_000,
  });

  return extractJson(result.result);
}
