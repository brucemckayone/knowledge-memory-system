/**
 * Component Generator Agent
 *
 * Produces a single inline interactive component (Mermaid graph, SVG figure,
 * step-through, code-runner, etc.) on demand. Pure generation: no MCP, no
 * graph mutations, single LLM turn, ~60s budget.
 *
 * The chat tutor (and dashboard) calls this when the conversation would
 * benefit from showing rather than telling. Output is a props payload that
 * matches the corresponding viz component's contract; on any failure
 * (timeout, invalid JSON, schema mismatch) we degrade to a markdown block.
 *
 * Model: Haiku per project preference. Generation tasks (small structured
 * JSON for known schemas) are well within Haiku's range; bump to Sonnet
 * only if live testing shows persistent invalid output for a kind.
 */
import { runAgent } from '../services/agent.js';

export type ComponentKindName =
  | 'Callout'
  | 'Mermaid'
  | 'SvgFigure'
  | 'CodeRunner'
  | 'StepThrough'
  | 'FlashcardDeck'
  | 'ConceptMap';

export interface ComponentKind {
  kind: ComponentKindName;
}

export interface ComponentGenInput {
  kind: ComponentKindName;
  context: string;
  learnerState?: {
    confidence?: number;
    courseId?: string;
    sectionId?: string;
    conceptName?: string;
    /** Concepts the learner once knew but whose last fact is older than 14 days. */
    forgottenConcepts?: string[];
    /** Active confusions on this section's concepts. */
    confusions?: Array<{ concept: string; misconception: string }>;
    /** Prerequisite concepts the learner is flagged as lacking. */
    missingPrereqs?: string[];
  };
}

export interface ComponentGenSuccess {
  kind: ComponentKindName;
  props: Record<string, unknown>;
  children?: string;
}

export interface ComponentGenFallback {
  kind: 'markdown';
  content: string;
}

export type ComponentGenResult = ComponentGenSuccess | ComponentGenFallback;

const ALLOWED_CALLOUT_VARIANTS = new Set(['info', 'warning', 'insight', 'takeaway']);

const BASE_PROMPT = `You generate a single inline interactive component for a learning platform. Output ONLY a JSON object — no prose, no markdown fences, no chain of thought.

Top-level shape:
{
  "props": { ... },              // required, kind-specific (see below)
  "children": "string"           // optional, only for components that wrap markdown
}

Hard rules:
- Output JSON ONLY. The first character must be '{', the last must be '}'.
- No surrounding commentary. No \`\`\`json fences.
- Escape newlines inside string fields as \\n.
- Stay strictly inside the schema for the requested kind. Unknown fields are ignored.
- Be concrete and specific to the supplied context. No placeholder content.`;

const KIND_PROMPTS: Record<ComponentKindName, string> = {
  Callout: `### Kind: Callout
Schema:
  props.variant: one of "info" | "warning" | "insight" | "takeaway"
  props.title?: short string headline (<= 60 chars)
  children: markdown content (1-4 short paragraphs or a tight bullet list)

Pick the variant that matches the message:
  info     — neutral context or background
  warning  — pitfall, gotcha, common mistake
  insight  — non-obvious connection or "aha"
  takeaway — the one thing to remember

Example output:
{"props":{"variant":"insight","title":"Why hashing works"},"children":"A good hash function spreads keys uniformly, so collisions stay rare even when the table is half full."}`,

  Mermaid: `### Kind: Mermaid
Schema:
  props.src: a complete, valid Mermaid v10 graph definition (string)

Constraints:
  - Start with a graph type declaration (e.g. \`flowchart TD\`, \`sequenceDiagram\`, \`stateDiagram-v2\`, \`classDiagram\`).
  - Keep it compact: <= ~12 nodes for flowcharts. Prefer clarity to detail.
  - Node labels in [] or () must not contain unescaped quotes or angle brackets — wrap with double quotes if punctuation is needed: A["multi-word label"].
  - No HTML, no init blocks, no themes.

Example output:
{"props":{"src":"flowchart LR\\n  A[Insert key] --> B{slot empty?}\\n  B -- yes --> C[store value]\\n  B -- no --> D[append to chain]\\n  D --> C"}}`,

  SvgFigure: `### Kind: SvgFigure
Schema:
  props.src: a complete, well-formed SVG document as a string (must start with <svg ...> and end with </svg>)
  props.caption?: 1-sentence caption shown beneath

Constraints:
  - Include xmlns="http://www.w3.org/2000/svg" on the root <svg>.
  - Set a viewBox; do NOT hardcode width/height in pixels.
  - No <script> tags, no event handlers (onclick etc.). The renderer sanitises.
  - Use simple shapes: rect, circle, line, path, text, g. Inline styles via style="..." attributes.
  - Keep it under ~30 elements. Use stroke and fill attributes; assume a dark background (use light strokes/text).

Example output:
{"props":{"src":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 200 80\\"><rect x=\\"10\\" y=\\"20\\" width=\\"40\\" height=\\"40\\" fill=\\"#6366f1\\"/><text x=\\"30\\" y=\\"45\\" fill=\\"#fff\\" text-anchor=\\"middle\\" font-size=\\"12\\">A</text></svg>","caption":"A simple labelled box"}}`,

  CodeRunner: `### Kind: CodeRunner
Schema:
  props.lang: must be the literal string "js"
  props.code: runnable JavaScript that produces output via console.log

Constraints:
  - Self-contained — no imports, no fetch, no DOM access, no top-level await.
  - Use console.log for ALL output the learner should see; runtime captures it.
  - Keep under ~30 lines. Demonstrate ONE idea clearly.
  - End with at least one console.log call so the runner has visible output.

Example output:
{"props":{"lang":"js","code":"const arr = [3, 1, 4, 1, 5];\\nconst doubled = arr.map(n => n * 2);\\nconsole.log('original:', arr);\\nconsole.log('doubled :', doubled);"}}`,

  StepThrough: `### Kind: StepThrough
Schema:
  props.steps: array of 3-7 steps, each { title?: string, content: string }
    - title: short label for the step (<= 60 chars)
    - content: markdown, 1-3 sentences each step

Constraints:
  - Steps must be sequential — each builds on the previous one.
  - Don't repeat the title inside the content.

Example output:
{"props":{"steps":[{"title":"Hash the key","content":"Compute hash(key) and reduce it modulo the table size to find an index."},{"title":"Slot empty?","content":"If the slot is empty, store the (key, value) directly."},{"title":"Slot taken","content":"On collision, append the (key, value) pair to the linked list at that slot."},{"title":"Lookup","content":"Hash the key again, walk the chain at that index, return the matching value."}]}}`,

  FlashcardDeck: `### Kind: FlashcardDeck
Schema:
  props.cards: array of 3-5 cards, each { front: string, back: string, hint?: string }

Constraints:
  - Front: short prompt (question, term, or scenario).
  - Back: self-contained answer, 1-3 sentences.
  - Hints optional and only when the front would otherwise be too vague.
  - Mix card shapes: definition, contrast, application, "why does this matter".
  - Specific to the concept — no generic placeholders.

Example output:
{"props":{"cards":[{"front":"What problem does chaining solve?","back":"It lets a hash table store multiple keys at the same index by linking them in a list, so collisions don't lose data."},{"front":"Worst-case lookup with chaining?","back":"O(n) — when every key hashes to the same slot, the chain becomes a linear list.","hint":"What if every key hashes to the same slot?"}]}}`,

  ConceptMap: `### Kind: ConceptMap
Schema:
  props.nodes: array of { id: string, label: string, type?: string }
    - type optional, one of: "concept" | "fact" | "question" | "error"
  props.edges: array of { source: string, target: string, label?: string }
    - source and target MUST reference existing node ids
  props.width?: number (default 600)
  props.height?: number (default 360)

Constraints:
  - 4-10 nodes total. Keep ids short and unique (no spaces).
  - 3-12 edges. Every edge references node ids that exist in nodes[].
  - Edge labels should describe the relationship in 1-3 words.

Example output:
{"props":{"nodes":[{"id":"hash","label":"Hash function","type":"concept"},{"id":"table","label":"Hash table","type":"concept"},{"id":"collision","label":"Collision","type":"concept"},{"id":"chain","label":"Chaining","type":"concept"}],"edges":[{"source":"hash","target":"table","label":"indexes"},{"source":"table","target":"collision","label":"can have"},{"source":"chain","target":"collision","label":"resolves"}]}}`,
};

function buildSystemPrompt(kind: ComponentKindName): string {
  return `${BASE_PROMPT}\n\n${KIND_PROMPTS[kind]}`;
}

function buildUserPrompt(input: ComponentGenInput): string {
  const parts: string[] = [
    `Generate a ${input.kind} component for the following context.`,
    '',
    `Context: ${input.context.trim() || '(no context provided — pick a sensible illustrative example)'}`,
  ];
  if (input.learnerState) {
    const ls = input.learnerState;
    const bits: string[] = [];
    if (typeof ls.confidence === 'number') bits.push(`learner confidence ${ls.confidence.toFixed(2)} (0=novice, 1=expert)`);
    if (ls.conceptName) bits.push(`concept "${ls.conceptName}"`);
    if (ls.sectionId) bits.push(`section ${ls.sectionId}`);
    if (ls.courseId) bits.push(`course ${ls.courseId}`);
    if (bits.length > 0) parts.push('', `Learner state: ${bits.join(', ')}.`);
    const personal: string[] = [];
    if (Array.isArray(ls.forgottenConcepts) && ls.forgottenConcepts.length > 0) {
      personal.push(`Forgotten (decay candidates): ${ls.forgottenConcepts.map((s) => `"${s}"`).join(', ')}.`);
    }
    if (Array.isArray(ls.confusions) && ls.confusions.length > 0) {
      personal.push(`Active confusions: ${ls.confusions.map((c) => `"${c.concept}" → "${c.misconception}"`).join('; ')}.`);
    }
    if (Array.isArray(ls.missingPrereqs) && ls.missingPrereqs.length > 0) {
      personal.push(`Missing prerequisites: ${ls.missingPrereqs.map((s) => `"${s}"`).join(', ')}.`);
    }
    if (personal.length > 0) {
      parts.push('', 'Personalisation cues:');
      parts.push(...personal);
    }
  }
  parts.push('', 'Output the JSON object only.');
  return parts.join('\n');
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

interface RawAgentShape {
  props?: unknown;
  children?: unknown;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function nonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

type Validator = (raw: RawAgentShape) => ComponentGenSuccess | null;

const VALIDATORS: Record<ComponentKindName, Validator> = {
  Callout: (r) => {
    if (!isObj(r.props)) return null;
    const variant = r.props.variant;
    if (typeof variant !== 'string' || !ALLOWED_CALLOUT_VARIANTS.has(variant)) return null;
    const props: Record<string, unknown> = { variant };
    if (nonEmptyString(r.props.title)) props.title = r.props.title.trim();
    const children = nonEmptyString(r.children) ? r.children.trim() : undefined;
    if (!children) return null;
    return { kind: 'Callout', props, children };
  },

  Mermaid: (r) => {
    if (!isObj(r.props) || !nonEmptyString(r.props.src)) return null;
    const src = r.props.src.trim();
    // Sanity: starts with a known graph keyword.
    if (!/^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline)\b/i.test(src)) return null;
    return { kind: 'Mermaid', props: { src } };
  },

  SvgFigure: (r) => {
    if (!isObj(r.props) || !nonEmptyString(r.props.src)) return null;
    const src = r.props.src.trim();
    if (!/^<svg[\s>]/i.test(src) || !/<\/svg>\s*$/i.test(src)) return null;
    const props: Record<string, unknown> = { src };
    if (nonEmptyString(r.props.caption)) props.caption = r.props.caption.trim();
    return { kind: 'SvgFigure', props };
  },

  CodeRunner: (r) => {
    if (!isObj(r.props)) return null;
    if (!nonEmptyString(r.props.code)) return null;
    const lang = typeof r.props.lang === 'string' ? r.props.lang.toLowerCase() : 'js';
    const normLang = lang === 'js' || lang === 'javascript' ? 'js' : null;
    if (!normLang) return null;
    return { kind: 'CodeRunner', props: { lang: 'js', code: r.props.code } };
  },

  StepThrough: (r) => {
    if (!isObj(r.props) || !Array.isArray(r.props.steps)) return null;
    const steps: Array<{ title?: string; content: string }> = [];
    for (const s of r.props.steps) {
      if (!isObj(s)) continue;
      if (!nonEmptyString(s.content)) continue;
      const step: { title?: string; content: string } = { content: s.content.trim() };
      if (nonEmptyString(s.title)) step.title = s.title.trim();
      steps.push(step);
    }
    if (steps.length < 2) return null;
    return { kind: 'StepThrough', props: { steps } };
  },

  FlashcardDeck: (r) => {
    if (!isObj(r.props) || !Array.isArray(r.props.cards)) return null;
    const cards: Array<{ front: string; back: string; hint?: string }> = [];
    for (const c of r.props.cards) {
      if (!isObj(c)) continue;
      if (!nonEmptyString(c.front) || !nonEmptyString(c.back)) continue;
      const card: { front: string; back: string; hint?: string } = { front: c.front.trim(), back: c.back.trim() };
      if (nonEmptyString(c.hint)) card.hint = c.hint.trim();
      cards.push(card);
    }
    if (cards.length < 2) return null;
    return { kind: 'FlashcardDeck', props: { cards } };
  },

  ConceptMap: (r) => {
    if (!isObj(r.props) || !Array.isArray(r.props.nodes) || !Array.isArray(r.props.edges)) return null;
    const ids = new Set<string>();
    const nodes: Array<{ id: string; label: string; type?: string }> = [];
    for (const n of r.props.nodes) {
      if (!isObj(n)) continue;
      if (!nonEmptyString(n.id) || !nonEmptyString(n.label)) continue;
      const id = n.id.trim();
      if (ids.has(id)) continue;
      ids.add(id);
      const node: { id: string; label: string; type?: string } = { id, label: n.label.trim() };
      if (nonEmptyString(n.type)) node.type = n.type.trim();
      nodes.push(node);
    }
    if (nodes.length < 2) return null;
    const edges: Array<{ source: string; target: string; label?: string }> = [];
    for (const e of r.props.edges) {
      if (!isObj(e)) continue;
      if (!nonEmptyString(e.source) || !nonEmptyString(e.target)) continue;
      const source = e.source.trim();
      const target = e.target.trim();
      if (!ids.has(source) || !ids.has(target)) continue;
      const edge: { source: string; target: string; label?: string } = { source, target };
      if (nonEmptyString(e.label)) edge.label = e.label.trim();
      edges.push(edge);
    }
    if (edges.length < 1) return null;
    const props: Record<string, unknown> = { nodes, edges };
    if (typeof (r.props as Record<string, unknown>).width === 'number') props.width = (r.props as Record<string, unknown>).width;
    if (typeof (r.props as Record<string, unknown>).height === 'number') props.height = (r.props as Record<string, unknown>).height;
    return { kind: 'ConceptMap', props };
  },
};

function validateOutput(kind: ComponentKindName, parsed: unknown): ComponentGenSuccess | null {
  if (!isObj(parsed)) return null;
  return VALIDATORS[kind]({ props: parsed.props, children: parsed.children });
}

function fallbackContent(kind: ComponentKindName, context: string, raw?: string): string {
  const head = `**[Component generation unavailable for ${kind}]**`;
  // If the agent produced any prose, surface it; otherwise a generic note.
  if (raw && raw.trim().length > 0 && raw.trim().length < 1500) {
    // Only surface raw output if it doesn't look like broken JSON (would just be noise).
    const trimmed = raw.trim();
    const looksJson = trimmed.startsWith('{') || trimmed.startsWith('```');
    if (!looksJson) return `${head}\n\n${trimmed}`;
  }
  const ctx = context.trim();
  const tail = ctx
    ? `Could not produce a valid ${kind} for: "${ctx.slice(0, 200)}${ctx.length > 200 ? '…' : ''}".`
    : `Could not produce a valid ${kind} component.`;
  return `${head}\n\n${tail}`;
}

/**
 * Generate a single inline component. Returns either a validated component
 * spec (kind + props [+ children]) or a markdown fallback.
 *
 * Bounded: 60s timeout, single LLM turn, no MCP tools, no tool calls.
 */
export async function generateComponent(input: ComponentGenInput): Promise<ComponentGenResult> {
  if (!VALIDATORS[input.kind]) {
    return { kind: 'markdown', content: fallbackContent(input.kind, input.context) };
  }

  const systemPrompt = buildSystemPrompt(input.kind);
  const userPrompt = buildUserPrompt(input);

  let raw = '';
  try {
    const result = await runAgent(userPrompt, {
      model: 'haiku',
      effort: 'low',
      systemPrompt,
      // No mcpConfigPath — pure generation, no tool calls allowed.
      tools: 'none',
      maxTurns: 2, // 1 produces edge cases on warm-up; 2 lets the assistant correct itself once.
      timeoutMs: 60_000,
    });
    raw = result.result ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[component-generator] runAgent failed for ${input.kind}: ${msg}`);
    return { kind: 'markdown', content: fallbackContent(input.kind, input.context) };
  }

  const parsed = parseLoose(raw);
  if (parsed) {
    const validated = validateOutput(input.kind, parsed);
    if (validated) return validated;
  }

  console.warn(`[component-generator] invalid output for ${input.kind}; first 200 chars: ${raw.slice(0, 200)}`);
  return { kind: 'markdown', content: fallbackContent(input.kind, input.context, raw) };
}
