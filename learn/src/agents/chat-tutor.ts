/**
 * Chat Tutor Agent
 *
 * Processes a chat message from the learner. Responds as a helpful tutor
 * and silently uses MCP tools to make targeted, deliberate graph updates
 * when the conversation reveals something worth recording.
 *
 * The learner never sees the graph updates — they just get a good tutor response.
 *
 * Always structured: tutor emits a `{ blocks: [...] }` response that mixes
 * markdown with interactive components (Mermaid, Callout, CodeRunner,
 * StepThrough, etc.). The agent calls the `generate_component` MCP tool to
 * produce well-formed component props rather than hand-rolling Mermaid syntax
 * or SVG markup. On parse failure the raw text is wrapped in a single
 * markdown block so the response still renders.
 *
 * The CHAT_STRUCTURED env flag is honoured for back-compat only: explicitly
 * set CHAT_STRUCTURED=0 to fall back to the plain-string v0.1 path.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';
import type { LessonBlock } from './lesson-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const SYSTEM_PROMPT = `You are an expert tutor helping a learner understand a subject. Your two jobs are:

1. **Give a great tutor response** — helpful, clear, patient. Answer questions, explain concepts, correct misunderstandings, ask Socratic questions to probe understanding.

2. **Silently update the knowledge graph** — use MCP tools to record what you learned about this learner's understanding. Do this BEFORE writing your response.

## When to call MCP tools (ONLY when there is clear evidence)

Call record_understanding when:
- The learner correctly explained a concept in their own words
- They asked a question that reveals they understand the surrounding context well
- They made a connection between concepts showing deep understanding

Call record_confusion when:
- They stated something factually wrong (specific misconception, not just uncertainty)
- They conflated two distinct concepts in a specific, identifiable way

Call flag_prerequisite_gap when:
- Their question reveals they are missing a specific foundational concept
- They can't understand your explanation because of a clear prerequisite gap

Call record_understanding with low confidence (0.3-0.5) when:
- They showed partial understanding — they get the surface but not the depth

## When NOT to call MCP tools
- Casual chitchat ("thanks", "ok", "got it")
- Simple clarification questions (doesn't reveal understanding level)
- You're uncertain what they actually understand
- They just repeated back what you said

## Tool usage order
1. Call MCP read tools first to understand their current state (get_learner_understanding, get_struggle_areas)
2. Decide if any write tools are warranted
3. Make targeted write calls (usually 0-2 per message)
4. Then write your tutor response

## Response format
Your final text response goes to the learner. Keep it conversational and helpful. Do not mention the knowledge graph or that you are tracking their understanding.`;

// v0.2 structured-response system prompt — gated behind CHAT_STRUCTURED.
// The agent is taught to compose a LessonBlock[] response and to call the
// generate_component MCP tool whenever an interactive visual would help.
const SYSTEM_PROMPT_STRUCTURED = `You are an expert tutor helping a learner understand a subject. You have three jobs:

1. **Give a great tutor response** — helpful, clear, patient. Answer questions, explain concepts, correct misunderstandings, ask Socratic questions to probe understanding.

2. **Silently update the knowledge graph** — use the learning MCP tools to record what you learned about the learner's understanding. Do this BEFORE writing your response.

3. **Compose a structured response document** — your final reply is a JSON object with a "blocks" array that mixes markdown prose and interactive components.

## When to call MCP tools (ONLY when there is clear evidence)

Call record_understanding when:
- The learner correctly explained a concept in their own words
- They asked a question that reveals they understand the surrounding context well
- They made a connection between concepts showing deep understanding

Call record_confusion when:
- They stated something factually wrong (specific misconception, not just uncertainty)

Call flag_prerequisite_gap when:
- Their question reveals they are missing a specific foundational concept

Call record_understanding with low confidence (0.3-0.5) when:
- They showed partial understanding — surface but not depth

Skip MCP write calls for chitchat, simple clarifications, or when you're uncertain about their understanding level.

## Composing the structured response

Your final assistant message MUST be a JSON object with EXACTLY this shape:

{
  "blocks": [
    { "type": "markdown", "content": "..." },
    { "type": "component", "kind": "Mermaid|Callout|SvgFigure|CodeRunner|StepThrough|FlashcardDeck|ConceptMap|Highlight",
      "props": { ... }, "children": "optional markdown string" }
  ]
}

Allowed component kinds (use exactly, case-sensitive):
- Callout: { variant: 'info'|'warning'|'insight'|'takeaway', title?: string }, with markdown children
- Mermaid: { src: string }  (Mermaid graph source)
- SvgFigure: { src: string, caption?: string }
- CodeRunner: { lang: 'js', code: string }
- StepThrough: { steps: [{ title?: string, content: string }, ...] }
- FlashcardDeck: { cards: [{ front: string, back: string, hint?: string }, ...] }
- ConceptMap: { nodes: [{id,label,type?}], edges: [{source,target,label?}] }
- Highlight: wraps markdown children with selection actions; props usually {}

## How to produce component props — IMPORTANT

When you decide a component would help (a diagram, a stepwise mechanism, a runnable example), DO NOT hand-roll Mermaid syntax, SVG markup, or component JSON yourself. Call the **generate_component** MCP tool with the kind and a clear context string. It returns a validated props payload. Splice that payload directly into your blocks array as a "component" block.

Example flow:
- Decide a Mermaid flowchart would help explain hash-table chaining.
- Call generate_component({ kind: "Mermaid", context: "chaining in a hash table — insert collides, append to linked list at the slot, lookup walks the chain" }).
- The tool returns { kind: "Mermaid", props: { src: "flowchart LR\\n..." } } (or a markdown fallback).
- Drop that into "blocks" as { "type": "component", "kind": "Mermaid", "props": { ... } }.

If generate_component returns a markdown fallback ({ kind: "markdown", content: "..." }), include it as a regular markdown block instead.

## When to use components vs. plain markdown

- Use **markdown** for the bulk of your reply — explanations, prose, code examples, bullets.
- Use **components** when an interactive visual genuinely earns its place: a flow you can show with a diagram, a stepwise process, a runnable example, a contrast you can flashcard. Don't sprinkle components for decoration.
- A short clarification or chitchat answer is fine as a single markdown block.

## Response style

- Direct, helpful, second-person ("you'll see", "notice that"). Conversational.
- Do not mention the knowledge graph or that you are tracking the learner.
- Do not greet by name; do not be sycophantic.

## Hard rules for the final message

- Your final assistant message must be the JSON object — and ONLY the JSON object.
- First character: '{'. Last character: '}'. No prose before or after. No \`\`\`json fences.
- "blocks" is a non-empty array. Every entry must have a valid "type" ("markdown" or "component").
- For component blocks, "kind" must be one of the allowed kinds exactly.
- Escape newlines inside JSON strings as \\n.`;

export interface ChatTutorResult {
  response: string;
  blocks?: LessonBlock[];
  nmemoUpdates: Array<{ tool: string; args: Record<string, unknown> }>;
}

const ALLOWED_KINDS = new Set([
  'Callout', 'Mermaid', 'SvgFigure', 'CodeRunner',
  'StepThrough', 'FlashcardDeck', 'ConceptMap', 'Highlight',
]);

function isStructuredEnabled(): boolean {
  // Default ON. Only the explicit opt-out values disable structured responses.
  const v = process.env.CHAT_STRUCTURED;
  if (v === undefined) return true;
  return !(v === '0' || v === 'false' || v === 'no' || v === '');
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function parseLoose(raw: string): unknown | null {
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }

  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    const parsed = tryParse(obj[0]);
    if (parsed) return parsed;
  }
  return null;
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

/**
 * Try to parse a structured `{ blocks: [...] }` response from the agent's raw
 * text. Returns null on any failure (caller falls back to a single markdown
 * block wrapping the raw text).
 */
function parseStructuredBlocks(raw: string): LessonBlock[] | null {
  const parsed = parseLoose(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.blocks)) return null;
  const blocks: LessonBlock[] = [];
  for (const raw of obj.blocks) {
    const b = validateBlock(raw);
    if (b) blocks.push(b);
  }
  return blocks.length > 0 ? blocks : null;
}

/**
 * Synthesise a single-markdown-block fallback when the structured branch is
 * enabled but the agent's output failed to parse. Wraps the raw text so the
 * learner still sees something useful.
 */
function fallbackBlocks(raw: string): LessonBlock[] {
  const trimmed = raw.trim();
  // Strip leading/trailing JSON fences if present, otherwise the markdown block
  // would render literal '{}' braces in the chat.
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  return [{
    type: 'markdown',
    content: stripped.length > 0 ? stripped : '(empty response)',
  }];
}

/**
 * Collapse a LessonBlock[] to a plain-text summary suitable for the legacy
 * `content` column. Lets old clients (and the GET messages endpoint) keep
 * working when a message has structured blocks. Component blocks are
 * represented by their `children` text or a short stub.
 */
function blocksToPlainText(blocks: LessonBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'markdown') {
      parts.push(b.content);
    } else if (b.type === 'component') {
      if (b.children && b.children.trim()) parts.push(b.children);
      else parts.push(`[${b.kind}]`);
    }
  }
  return parts.join('\n\n').trim();
}

export async function processChatMessage(params: {
  message: string;
  history: Array<{ role: string; content: string }>;
  courseTopic?: string;
  sectionTitle?: string;
  sectionExcerpt?: string;
}): Promise<ChatTutorResult> {
  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
  });

  // Build conversation context
  const historyText = params.history.slice(-6) // last 3 exchanges
    .map(m => `${m.role === 'user' ? 'Learner' : 'Tutor'}: ${m.content}`)
    .join('\n');

  const contextParts: string[] = [];
  if (params.courseTopic) contextParts.push(`Course: ${params.courseTopic}`);
  if (params.sectionTitle) contextParts.push(`Current section: ${params.sectionTitle}`);
  if (params.sectionExcerpt) {
    // Cap excerpt to keep prompt small; tutor uses it for grounding, not full reading.
    const excerpt = params.sectionExcerpt.length > 1200
      ? params.sectionExcerpt.slice(0, 1200) + '…'
      : params.sectionExcerpt;
    contextParts.push(`Section content (excerpt):\n${excerpt}`);
  }
  const contextNote = contextParts.length > 0
    ? contextParts.join('\n') + '\n\n'
    : '';

  const structured = isStructuredEnabled();
  const tail = structured
    ? 'First check their understanding state via MCP tools if relevant, decide if any write calls are warranted, then compose your structured JSON response. If a component would help, call generate_component to produce its props. Output ONLY the JSON object.'
    : 'First check their understanding state via MCP tools if relevant, then respond as their tutor.';

  const prompt = `${contextNote}${historyText ? `Recent conversation:\n${historyText}\n\n` : ''}Learner's latest message: "${params.message}"\n\n${tail}`;

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: structured ? SYSTEM_PROMPT_STRUCTURED : SYSTEM_PROMPT,
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 10,
    timeoutMs: 600_000, // 10 min
  });

  const raw = result.result ?? '';

  if (!structured) {
    // v0.1 path: behaviour unchanged. Plain-string response.
    return {
      response: raw,
      nmemoUpdates: [],
    };
  }

  // v0.2 path: parse structured blocks. On failure, wrap raw text in a single
  // markdown block so the response still renders.
  const blocks = parseStructuredBlocks(raw);
  if (blocks) {
    return {
      response: blocksToPlainText(blocks),
      blocks,
      nmemoUpdates: [],
    };
  }

  console.warn(`[chat-tutor] structured parse failed; falling back to single markdown block. First 200 chars: ${raw.slice(0, 200)}`);
  const fb = fallbackBlocks(raw);
  return {
    response: blocksToPlainText(fb),
    blocks: fb,
    nmemoUpdates: [],
  };
}

// Internal helpers exposed for unit-style testing.
export const __test = {
  parseStructuredBlocks,
  fallbackBlocks,
  blocksToPlainText,
  isStructuredEnabled,
};
