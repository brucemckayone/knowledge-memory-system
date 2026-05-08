/**
 * Lesson Prose Writer — second stage of the lesson pipeline.
 *
 * Per outline prose-item, one Sonnet 4.6 high-effort call writing the
 * markdown body for that single block. The orchestrator runs these in
 * parallel via Promise.all.
 *
 * Each call sees the FULL outline (so the writer knows what surrounds it)
 * but only writes its assigned block — no headings spanning siblings,
 * no duplication of intro/outro material.
 */
import { runAgent } from '../services/agent.js';
import type { LessonOutline, OutlineItem, ProseItem } from './lesson-outliner.js';

export interface ProseWriterInput {
  outline: LessonOutline;
  /** The specific prose item to write. Must be present in outline.items. */
  item: ProseItem;
  courseTitle: string;
  sectionTitle: string;
  sectionDescription: string | null;
  learningObjectives: string[];
}

const SYSTEM_PROMPT = `You write a single block of lesson prose. You are part of a multi-agent pipeline — other agents write the surrounding blocks and build the interactive widgets. Your output is ONLY the markdown for your assigned block.

# Output (strict JSON)

{
  "markdown": string   // the markdown body of this block
}

First character '{', last character '}'. No prose, no markdown fences around the JSON. Escape newlines inside the markdown string as \\n.

# Style

- Direct, second-person voice ("you'll see", "notice that"). No sycophancy. No "in this lesson we will".
- Short paragraphs. Bullet lists when listing things. Code fences when code helps.
- Be precise and accurate. One well-explained example beats three shallow ones.
- Do NOT repeat material covered by neighbouring blocks (you'll see their intents in the outline).
- Do NOT introduce a top-level heading — the lesson title sits above your block already. Use \`###\` if you need a sub-heading inside this block.
- Hit the word target loosely (±20%). Don't pad to fill it; don't truncate to underrun it.

# Hard rules

- Output JSON only. No prose outside the JSON. No markdown fences around the JSON.
- The markdown body itself MAY contain code fences (\`\`\`...\`\`\`); just escape backticks/newlines per JSON rules.
- Do not output anything that introduces a separate widget — your block is prose only. Other items in the outline handle widgets.`;

function buildUserPrompt(input: ProseWriterInput): string {
  const { outline, item } = input;
  const idx = outline.items.findIndex((it) => it.id === item.id);
  const before = idx > 0 ? outline.items.slice(0, idx) : [];
  const after = idx >= 0 && idx < outline.items.length - 1 ? outline.items.slice(idx + 1) : [];

  const itemBrief = (it: OutlineItem): string => {
    if (it.kind === 'prose') return `[prose ${it.id}] ${it.intent}`;
    const tag = it.type === 'fixed' ? `[${it.fixedKind} ${it.id}]` : `[Artifact:${it.intent} ${it.id}]`;
    return `${tag} ${it.spec}`;
  };

  const objectives = input.learningObjectives.length > 0
    ? input.learningObjectives.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : '(none specified)';

  const parts: string[] = [
    `Course: ${input.courseTitle}`,
    `Section: ${input.sectionTitle}`,
  ];
  if (input.sectionDescription) parts.push(`Section description: ${input.sectionDescription}`);
  parts.push(
    '',
    'Learning objectives:',
    objectives,
    '',
    `Lesson title: ${outline.title}`,
    '',
    'Lesson intro (already written, do not duplicate):',
    outline.intro,
    '',
    `Items BEFORE your block (already covered or about to be — do not repeat):`,
    before.length > 0 ? before.map(itemBrief).join('\n') : '(none — you are the first item)',
    '',
    `Items AFTER your block (do not steal their material):`,
    after.length > 0 ? after.map(itemBrief).join('\n') : '(none — you are the last item)',
    '',
    'Lesson outro (already written, do not duplicate):',
    outline.outro,
    '',
    `## Your block`,
    `id: ${item.id}`,
    `wordTarget: ${item.wordTarget}`,
    `intent: ${item.intent}`,
    '',
    'Write ONLY the markdown for this block. Output the JSON object.',
  );
  return parts.join('\n');
}

function tryParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
function parseLoose(raw: string): unknown | null {
  const t = raw.trim();
  const direct = tryParse(t);
  if (direct) return direct;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    const o = tryParse(obj[0]);
    if (o) return o;
  }
  return null;
}

/**
 * Write the prose for a single outline item. Returns the markdown body.
 * Throws on failure — the orchestrator decides whether to substitute a
 * placeholder or fail the whole lesson.
 */
export async function writeProseBlock(input: ProseWriterInput): Promise<string> {
  const result = await runAgent(buildUserPrompt(input), {
    model: 'sonnet',
    effort: 'high',
    systemPrompt: SYSTEM_PROMPT,
    tools: 'none',
    maxTurns: 1,
    timeoutMs: 600_000,
  });
  const raw = result.result ?? '';
  const parsed = parseLoose(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const md = (parsed as Record<string, unknown>).markdown;
    if (typeof md === 'string' && md.trim().length > 0) return md;
  }
  // Some Sonnet outputs slip prose around or skip the JSON wrapper. Treat
  // the raw text as markdown if it looks like markdown (no opening brace).
  const trimmed = raw.trim();
  if (trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('```')) {
    return trimmed;
  }
  throw new Error(`Prose writer produced invalid output. First 300 chars: ${raw.slice(0, 300)}`);
}
