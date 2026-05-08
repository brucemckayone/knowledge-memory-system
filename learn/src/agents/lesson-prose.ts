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
import type { LearnerLessonContext } from './learner-lesson-context.js';
import type { LessonCitation } from './lesson-types.js';

export interface ProseWriterInput {
  outline: LessonOutline;
  /** The specific prose item to write. Must be present in outline.items. */
  item: ProseItem;
  courseTitle: string;
  sectionTitle: string;
  sectionDescription: string | null;
  learningObjectives: string[];
  /** Optional learner state. When `coldStart === false`, the prose writer
   *  may quote the listed confusion/gap. Cold-start (or undefined) yields
   *  a byte-identical user prompt to the canonical baseline. */
  learnerContext?: LearnerLessonContext;
  /** Whether the prose writer is allowed to call WebSearch / WebFetch when it
   *  needs current information. When false, the agent runs with no tools and
   *  the user prompt does not mention web research (keeps cold-start prompts
   *  byte-identical to the v0.3 baseline). */
  enableWebSearch?: boolean;
}

export interface ProseWriterResult {
  markdown: string;
  citations?: LessonCitation[];
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

# Personalisation

When the user prompt includes a "## Learner context" block, this lesson is being regenerated for a learner with graph-tracked beliefs. Your block MUST address listed confusions / forgotten concepts / missing prereqs ONLY when (and only when) the assigned block's \`intent\` references that concept. Otherwise, write canonical prose — do not name learner state in unrelated paragraphs.

If you DO address a listed confusion:
- Name the misconception ONLY to refute it. The corrected belief MUST follow within the same paragraph (≤ 3 sentences). Never quote the wrong belief in isolation — that risks reinforcing it.
- Use second-person directly: "You may have written X — that's not quite right; the truth is Y, because…".

NEVER fabricate a learner fact that wasn't supplied. If no "## Learner context" block is present, write a canonical block exactly as you would for a cold-start lesson.

# Hard rules

- Output JSON only. No prose outside the JSON. No markdown fences around the JSON.
- The markdown body itself MAY contain code fences (\`\`\`...\`\`\`); just escape backticks/newlines per JSON rules.
- Do not output anything that introduces a separate widget — your block is prose only. Other items in the outline handle widgets.

# Web research (only when the user prompt's "## Web research" block is present)

When that block is present, you MAY call WebSearch / WebFetch to verify facts that change quickly: version numbers, API stability, deprecations, recent releases, current state of a feature. Prefer official documentation, primary sources, and high-signal references; avoid forums and Q&A sites unless they're the only source. Never cite a URL you have not actually fetched.

If you used any web sources in your block, append a citations metadata footer AFTER the JSON object — separated from it by a blank line:

[CITATIONS]
{"citations":[{"url":"https://...","title":"..."},{"url":"...","title":"..."}]}

Each entry: { "url": string (required), "title": string (optional, the document title from your fetch). One entry per unique URL you cited or pulled material from. If you did not use any web sources, omit the [CITATIONS] block entirely.`;

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
  );
  // Personalisation block — gated strictly on coldStart === false. Filtered
  // to learner-state items plausibly relevant to this prose item's intent
  // (over-inclusion is acceptable; the model picks). Cold-start callers
  // produce byte-identical prompts to the v0.3 baseline.
  if (input.learnerContext && input.learnerContext.coldStart === false) {
    const block = renderProseLearnerContextBlock(input.learnerContext, item.intent);
    if (block.length > 0) {
      parts.push('', '## Learner context (use ONLY when intent above references one of these)', block);
    }
  }
  if (input.enableWebSearch) {
    parts.push(
      '',
      '## Web research',
      'You MAY call WebSearch / WebFetch to verify version numbers, API stability, deprecations, or recent releases mentioned by this section. Prefer official docs and primary sources. Cite every URL you actually fetch in a [CITATIONS] block (see system prompt).',
    );
  }
  parts.push('', 'Write ONLY the markdown for this block. Output the JSON object.');
  return parts.join('\n');
}

const PROSE_TRUNC = 80;
function clip(s: string, n = PROSE_TRUNC): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * Filter a `LearnerLessonContext` to entries whose concept name appears as a
 * substring of the prose item's intent (case-insensitive). Over-inclusion is
 * acceptable — the model picks; the worst case (no overlap) returns an empty
 * block, which is silently omitted upstream.
 */
function renderProseLearnerContextBlock(ctx: LearnerLessonContext, intent: string): string {
  const intentLc = intent.toLowerCase();
  const lines: string[] = [];
  const mentions = (concept: string): boolean =>
    concept.length > 0 && intentLc.includes(concept.toLowerCase());

  for (const c of ctx.confusions) {
    if (!mentions(c.concept)) continue;
    lines.push(`- confused: "${c.concept}" — they wrote: "${clip(c.misconception)}"`);
  }
  for (const f of ctx.forgottenConcepts) {
    if (!mentions(f.name)) continue;
    lines.push(`- forgot: "${f.name}" — last seen ${f.daysSince} day(s) ago at confidence ${f.lastConfidence.toFixed(2)}`);
  }
  for (const p of ctx.missingPrereqs) {
    if (!mentions(p.concept) && !mentions(p.neededFor)) continue;
    lines.push(`- missing prereq: "${p.concept}" — needed for "${p.neededFor}"`);
  }
  return lines.join('\n');
}

/**
 * Extract a `[CITATIONS] {...}` metadata block from the agent's raw output.
 *
 * Tolerant: the block may appear before or after the JSON markdown wrapper,
 * may use single or double quotes, and may have whitespace / newlines around
 * the JSON. Returns at most one entry per URL (deduplicated, in first-seen
 * order). On any parse failure, returns an empty array — the lesson must
 * still ship without citations rather than fail.
 */
export function parseCitationsBlock(raw: string): LessonCitation[] {
  if (!raw || typeof raw !== 'string') return [];
  // Extract the JSON object that follows the [CITATIONS] marker by matching
  // braces (the naive non-greedy regex truncates at the first closing brace
  // of an inner array element). Tolerant of leading whitespace/newlines.
  const markerIdx = raw.search(/\[CITATIONS\]/i);
  if (markerIdx < 0) return [];
  const after = raw.slice(markerIdx);
  const startIdx = after.indexOf('{');
  if (startIdx < 0) return [];
  // Walk the string counting braces, ignoring braces inside JSON string literals.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;
  for (let i = startIdx; i < after.length; i += 1) {
    const ch = after[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx < 0) return [];
  const jsonText = after.slice(startIdx, endIdx + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const list = Array.isArray(obj.citations) ? obj.citations : null;
  if (!list) return [];
  const seen = new Set<string>();
  const out: LessonCitation[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const url = typeof e.url === 'string' ? e.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = typeof e.title === 'string' && e.title.trim().length > 0
      ? e.title.trim() : undefined;
    const accessedAt = typeof e.accessedAt === 'string' && e.accessedAt.trim().length > 0
      ? e.accessedAt.trim() : undefined;
    const cit: LessonCitation = { url };
    if (title) cit.title = title;
    if (accessedAt) cit.accessedAt = accessedAt;
    out.push(cit);
  }
  return out;
}

/**
 * Strip the `[CITATIONS] {...}` block from raw output before JSON parsing.
 * Brace-balanced — naive non-greedy regex stops at the first '}' of an inner
 * array entry and leaves dangling '},...]}' behind.
 */
function stripCitationsBlock(raw: string): string {
  const markerIdx = raw.search(/\[CITATIONS\]/i);
  if (markerIdx < 0) return raw.trim();
  const before = raw.slice(0, markerIdx);
  const after = raw.slice(markerIdx);
  const startIdx = after.indexOf('{');
  if (startIdx < 0) return (before).trim();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;
  for (let i = startIdx; i < after.length; i += 1) {
    const ch = after[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx < 0) return before.trim();
  const tail = after.slice(endIdx + 1);
  return (before + tail).trim();
}

export const __test = { buildUserPrompt, renderProseLearnerContextBlock, parseCitationsBlock, stripCitationsBlock };

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
 * Write the prose for a single outline item. Returns the markdown body and
 * any citations the agent attached via the `[CITATIONS] {...}` footer.
 * Throws on failure — the orchestrator decides whether to substitute a
 * placeholder or fail the whole lesson.
 *
 * `enableWebSearch` flips the agent's `tools` opt to `'WebSearch,WebFetch'`
 * and adds the "## Web research" instruction to the user prompt. When false,
 * the prompt and tool list are byte-identical to the v0.3 baseline.
 */
export async function writeProseBlock(input: ProseWriterInput): Promise<ProseWriterResult> {
  const tools = input.enableWebSearch ? 'WebSearch,WebFetch' : 'none';
  const maxTurns = input.enableWebSearch ? 5 : 1;
  const result = await runAgent(buildUserPrompt(input), {
    model: 'sonnet',
    effort: 'high',
    systemPrompt: SYSTEM_PROMPT,
    tools,
    maxTurns,
    timeoutMs: 600_000,
  });
  const raw = result.result ?? '';
  const citations = parseCitationsBlock(raw);
  const stripped = stripCitationsBlock(raw);
  const parsed = parseLoose(stripped);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const md = (parsed as Record<string, unknown>).markdown;
    if (typeof md === 'string' && md.trim().length > 0) {
      return citations.length > 0 ? { markdown: md, citations } : { markdown: md };
    }
  }
  // Some Sonnet outputs slip prose around or skip the JSON wrapper. Treat
  // the raw text as markdown if it looks like markdown (no opening brace).
  const trimmed = stripped.trim();
  if (trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('```')) {
    return citations.length > 0 ? { markdown: trimmed, citations } : { markdown: trimmed };
  }
  throw new Error(`Prose writer produced invalid output. First 300 chars: ${raw.slice(0, 300)}`);
}
