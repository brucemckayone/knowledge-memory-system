/**
 * Lesson Outliner — first stage of the multi-agent lesson pipeline.
 *
 * One Sonnet 4.6 max-effort call. Produces a structured outline that
 * interleaves prose blocks with tagged artifact intents. Downstream
 * stages (prose writer, artifact builder) consume this verbatim.
 *
 * The outliner is the only stage that gets to make teaching-design
 * decisions — what to cover, in what order, and where an interactive
 * widget genuinely earns a place over plain prose. Quality of the
 * outline drives quality of the whole lesson, hence the model+effort.
 */
import { runAgent } from '../services/agent.js';
import type { LearnerLessonContext } from './learner-lesson-context.js';
import { withPresentationMode } from './presentation-mode.js';

export type OutlineFixedKind =
  | 'Mermaid'
  | 'Callout'
  | 'FlashcardDeck'
  | 'ConceptMap'
  | 'StepThrough'
  | 'CodeRunner'
  | 'SvgFigure';

export type OutlineArtifactIntent = 'diagram' | 'animate' | 'plot' | 'walkthrough' | 'free';

export interface ProseItem {
  kind: 'prose';
  id: string;
  intent: string;
  wordTarget: number;
}

export interface ArtifactItem {
  kind: 'artifact';
  id: string;
  type: 'fixed' | 'freeform';
  fixedKind?: OutlineFixedKind;
  intent?: OutlineArtifactIntent;
  spec: string;
  rationale: string;
}

export type OutlineItem = ProseItem | ArtifactItem;

export interface LessonOutline {
  title: string;
  intro: string;
  items: OutlineItem[];
  outro: string;
}

export interface OutlinerInput {
  courseTitle: string;
  courseDescription: string | null;
  sectionTitle: string;
  sectionDescription: string | null;
  learningObjectives: string[];
  orderIndex: number;
  prevSectionTitle: string | null;
  nextSectionTitle: string | null;
  /** Optional source text to ground the outline in (course-supplied material). */
  sourceText?: string;
  /** Optional learner state. When `coldStart === false`, the outliner will
   *  weave personalisation into the outline. When undefined or `coldStart === true`,
   *  the user prompt is byte-identical to the canonical (cold-start) baseline. */
  learnerContext?: LearnerLessonContext;
  /** When true, the outliner runs with WebSearch enabled so it can ground the
   *  outline in current state for fast-moving topics. Disabled by default —
   *  cold-start prompts and tool list stay byte-identical to the v0.3 baseline. */
  enableWebSearch?: boolean;
  /** When true, the parent course is flagged as part of a live demo. Appends
   *  the presentation-mode addendum to the system prompt to bias register
   *  toward audience-aware explanation. Default false. */
  presentationMode?: boolean;
}

const ALLOWED_FIXED_KINDS = new Set<OutlineFixedKind>([
  'Mermaid', 'Callout', 'FlashcardDeck', 'ConceptMap', 'StepThrough', 'CodeRunner', 'SvgFigure',
]);
const ALLOWED_INTENTS = new Set<OutlineArtifactIntent>([
  'diagram', 'animate', 'plot', 'walkthrough', 'free',
]);

const SYSTEM_PROMPT = `You are a master curriculum designer. Given a single course section, you produce a STRUCTURED OUTLINE for an exceptional lesson — not the lesson itself. Downstream agents will write each prose block and build each interactive widget independently from your outline; the quality of every later stage depends on the precision of your outline.

# Your job

Decide:
1. What concepts the section needs to teach, broken into 6-12 ordered items.
2. Which items should be PROSE (markdown explanation) and which should be ARTIFACTS (interactive widgets that teach better than text).
3. For each artifact, whether a FIXED component kind nails the shape (Mermaid, Callout, FlashcardDeck, ConceptMap, StepThrough, CodeRunner, SvgFigure) or whether it needs a FREEFORM Artifact (sandboxed iframe — anything: animations, equation graphers, recursion trees, custom widgets).

# Output (strict JSON, no prose, no fences)

{
  "title": string,                        // lesson title (<= 80 chars)
  "intro": string,                        // 1-2 paragraph opening prose, plain markdown
  "items": [
    {
      "kind": "prose",
      "id": "p1",                         // unique id, "p" prefix
      "intent": string,                   // 1-2 sentence brief: what this prose block must convey, what came before, what comes after
      "wordTarget": number                // 150-450, default 300
    },
    {
      "kind": "artifact",
      "id": "a1",                         // unique id, "a" prefix
      "type": "fixed" | "freeform",
      "fixedKind": "Mermaid"|"Callout"|"FlashcardDeck"|"ConceptMap"|"StepThrough"|"CodeRunner"|"SvgFigure",  // ONLY when type == "fixed"
      "intent": "diagram"|"animate"|"plot"|"walkthrough"|"free",   // ONLY when type == "freeform"
      "spec": string,                     // detailed brief — see "Artifact spec rules" below
      "rationale": string                 // 1 sentence: why a widget here, not later or never
    }
  ],
  "outro": string                         // 1 paragraph wrap-up that points forward
}

# Hard rules

- Output JSON only. First character '{', last character '}'. No commentary, no markdown fences.
- 6-12 items total. The mix should be MOSTLY PROSE with 2-4 artifacts woven in at the right teaching moments.
- "items" must be ordered as the learner will encounter them.
- Every "id" must be unique within "items".
- For artifact items: include EITHER fixedKind OR intent (matching the type), never both.
- Escape newlines inside JSON strings as \\n.

# When to use which

- PROSE: definitions, motivation, history, reasoning, comparisons, gotchas, summaries — anything that's a sentence/paragraph at heart.
- FIXED artifact:
  - Mermaid: directed/state structures, flowcharts, sequence diagrams. Static, declarative.
  - Callout: a single critical insight or warning that must visually break out of prose. (Use sparingly — at most one per lesson.)
  - FlashcardDeck: 3-6 atomic facts/terms the learner should drill.
  - ConceptMap: a small network of named concepts with labelled relations.
  - StepThrough: a short numbered procedure (3-7 steps) where each step needs a paragraph.
  - CodeRunner: a runnable JS snippet that demonstrates ONE idea via console.log.
  - SvgFigure: a hand-designed static figure (geometry, layout, custom diagram) that Mermaid can't express.
- FREEFORM Artifact: pick this when the teaching needs INTERACTIVITY or VISUALISATION the fixed kinds don't capture. Examples:
  - Animation showing a process unfold (use intent "animate")
  - Function grapher with sliders (use intent "plot")
  - Recursion-tree explorer, custom puzzle, algorithm visualiser (use intent "free")
  - Step-by-step interactive walkthrough where each step renders new state (use intent "walkthrough")
  - Equation/3D scene/physics simulation (use intent "free")

# Artifact spec rules — CRITICAL

The downstream artifact builder (a separate agent) only sees: the spec, the section context, and the surrounding prose intents. It does NOT see your reasoning. So the spec MUST be self-contained and concrete enough that a good builder can produce the right widget without guessing.

A good spec names:
1. The exact concept the widget teaches (no "shows the algorithm" — say "shows in-order traversal of a binary search tree visiting nodes in sorted order").
2. The visual structure (e.g. "tree laid out top-down with 7 nodes", "x axis from -10 to 10, y from -1 to 1", "5 nodes in a horizontal chain").
3. The interaction model (e.g. "buttons: Step forward, Reset; current node highlighted in green", "two sliders for parameters a and b updating in real time").
4. Any specific data, equations, or examples to use (e.g. "tree of values [50,30,70,20,40,60,80]", "function y = a·sin(b·x)").
5. The teaching outcome — what the learner should *see* after interacting.

A bad spec: "Show the algorithm working." A good spec: "Animated visualisation of bubble sort on the array [5,1,4,2,8]. Each pass highlights the pair being compared, swaps with a 300ms transition, and shows the running 'sorted' suffix shaded green. Play/Pause/Step buttons. Goal: the learner sees the largest element bubble to the right on each pass."

# Personalisation (when learner state is supplied)

When the user prompt includes a "## Learner state" block, the lesson is being regenerated for a learner who already has graph-tracked beliefs about this section's concepts. Treat that block as authoritative:

- If \`confusions\` are listed, AT LEAST ONE outline item MUST directly target the listed misconception. The prose item's \`intent\` MUST name the wrong belief and the corrected belief, in that order ("learner thinks X; corrects to Y").
- If \`forgottenConcepts\` are listed, prefer a \`FlashcardDeck\` artifact over plain prose for that concept (3–5 cards, fronts = atomic facts the learner once knew).
- If \`missingPrereqs\` are listed, prefer a \`Mermaid\` (flowchart prereq → section concept) or \`ConceptMap\` (when 3+ prereqs) artifact whose spec mentions both the prereq and the section concept by name.
- If a learning objective is fully covered by an \`established\` entry, the corresponding prose item's \`wordTarget\` should drop to ~150 (terse review) instead of full explanation. Don't drop the item entirely — the lesson must still flow.
- Mix of confusion + missing prereq → freeform \`Artifact\` with \`intent: walkthrough\` that builds from the prereq up through the corrected mental model.
- DO NOT invent personalisation: confusions, forgotten concepts, missing prereqs, and established entries appear ONLY when the supplied lists name them. Don't fabricate a remedial item for a concept not on the lists.

When NO "## Learner state" block is supplied, generate a canonical (cold-start) outline — do not reference any learner state.

# Lesson shape

Items together must cover: motivation → core mechanics → worked example or interactive moment → pitfalls → forward link. The "intro" and "outro" fields handle opening framing and forward-pointing wrap-up; "items" carry the substantive teaching.

# Style

- Title and intro/outro use direct, second-person voice ("you'll see", "notice that"). No sycophancy. No "in this lesson we will".
- Outline must be strictly grounded in the section's learning objectives — every objective should be addressable from the items together.

Now produce the outline.`;

function buildUserPrompt(input: OutlinerInput): string {
  const objectives = input.learningObjectives.length > 0
    ? input.learningObjectives.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : '(none specified)';
  const parts: string[] = [
    'Design the outline for the following section.',
    '',
    '## Course',
    `- Title: ${input.courseTitle}`,
  ];
  if (input.courseDescription) parts.push(`- Description: ${input.courseDescription}`);
  parts.push(
    '',
    '## Section',
    `- Title: ${input.sectionTitle}`,
  );
  if (input.sectionDescription) parts.push(`- Description: ${input.sectionDescription}`);
  parts.push(
    `- Position: ${input.orderIndex + 1}${input.prevSectionTitle ? ` (previous: "${input.prevSectionTitle}")` : ' (first section)'}`,
    input.nextSectionTitle ? `- Next section: "${input.nextSectionTitle}"` : '- This is the final section.',
    '',
    '## Learning objectives',
    objectives,
  );
  if (input.sourceText && input.sourceText.trim()) {
    const trimmed = input.sourceText.trim();
    const excerpt = trimmed.length > 4000 ? trimmed.slice(0, 4000) + '\n…[truncated]' : trimmed;
    parts.push('', '## Source text (ground the outline in this material)', excerpt);
  }
  // Personalisation block — gated strictly on coldStart === false. Cold-start
  // (or absent) contexts produce a byte-identical user prompt to the v0.3
  // baseline.
  if (input.learnerContext && input.learnerContext.coldStart === false) {
    const block = renderLearnerStateBlock(input.learnerContext);
    if (block.length > 0) parts.push('', '## Learner state', block);
  }
  if (input.enableWebSearch) {
    parts.push(
      '',
      '## Web research',
      'You MAY call WebSearch (one or two queries max) to discover current state for this section: recent API changes, new releases, deprecations, framework versions. Use the results to ground individual outline items in concrete, dated specifics. Outline items themselves remain prose/artifact specs — do not include citation metadata in the outline JSON.',
    );
  }
  parts.push('', 'Output the JSON outline only.');
  return parts.join('\n');
}

const TRUNC_LEN = 80;
function clip(s: string, n = TRUNC_LEN): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Render the human-readable Learner state block for the outliner user prompt. */
function renderLearnerStateBlock(ctx: LearnerLessonContext): string {
  const lines: string[] = [];
  if (ctx.prioritisedGap) {
    lines.push('Prioritised gap (the lesson MUST target this — remedial slant):');
    lines.push(`- Concept: ${ctx.prioritisedGap.rootCauseConceptName}`);
    lines.push(`- Why the learner has this gap: ${ctx.prioritisedGap.rootCauseReason}`);
    lines.push(`- What this blocks: ${ctx.prioritisedGap.whyItMatters}`);
    lines.push('Bias the outline so at least one prose item directly addresses the gap. Use "Why this matters" to connect the gap to downstream understanding.');
  }
  if (ctx.confusions.length > 0) {
    lines.push('Confusions:');
    for (const c of ctx.confusions) {
      const src = c.sourceText ? ` (source: "${clip(c.sourceText)}")` : '';
      lines.push(`- ${c.concept} — they wrote: "${clip(c.misconception)}"${src}`);
    }
  }
  if (ctx.forgottenConcepts.length > 0) {
    lines.push('Forgotten concepts (decay candidates):');
    for (const f of ctx.forgottenConcepts) {
      lines.push(`- ${f.name} — last seen ${f.daysSince} day(s) ago at confidence ${f.lastConfidence.toFixed(2)}`);
    }
  }
  if (ctx.missingPrereqs.length > 0) {
    lines.push('Missing prerequisites:');
    for (const p of ctx.missingPrereqs) {
      lines.push(`- ${p.concept} — needed for "${p.neededFor}"`);
    }
  }
  if (ctx.established.length > 0) {
    lines.push('Already established (trim or skip motivation prose):');
    for (const e of ctx.established) {
      lines.push(`- ${e.concept} (confidence ${e.confidence.toFixed(2)})`);
    }
  }
  return lines.join('\n');
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

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function nonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

function validateItem(raw: unknown, fallbackIdx: number): OutlineItem | null {
  if (!isObj(raw)) return null;
  const id = nonEmptyString(raw.id) ? raw.id.trim() : `i${fallbackIdx}`;
  if (raw.kind === 'prose') {
    if (!nonEmptyString(raw.intent)) return null;
    const wt = typeof raw.wordTarget === 'number' && Number.isFinite(raw.wordTarget)
      ? Math.max(80, Math.min(800, Math.round(raw.wordTarget)))
      : 300;
    return { kind: 'prose', id, intent: raw.intent.trim(), wordTarget: wt };
  }
  if (raw.kind === 'artifact') {
    if (!nonEmptyString(raw.spec) || !nonEmptyString(raw.rationale)) return null;
    const type = raw.type === 'fixed' || raw.type === 'freeform' ? raw.type : null;
    if (!type) return null;
    if (type === 'fixed') {
      const fk = nonEmptyString(raw.fixedKind) ? raw.fixedKind.trim() as OutlineFixedKind : null;
      if (!fk || !ALLOWED_FIXED_KINDS.has(fk)) return null;
      return {
        kind: 'artifact',
        id,
        type: 'fixed',
        fixedKind: fk,
        spec: raw.spec.trim(),
        rationale: raw.rationale.trim(),
      };
    }
    // freeform
    const intentRaw = nonEmptyString(raw.intent) ? raw.intent.trim() as OutlineArtifactIntent : 'free';
    const intent = ALLOWED_INTENTS.has(intentRaw) ? intentRaw : 'free';
    return {
      kind: 'artifact',
      id,
      type: 'freeform',
      intent,
      spec: raw.spec.trim(),
      rationale: raw.rationale.trim(),
    };
  }
  return null;
}

function validate(parsed: unknown): LessonOutline | null {
  if (!isObj(parsed)) return null;
  if (!nonEmptyString(parsed.title) || !nonEmptyString(parsed.intro) || !nonEmptyString(parsed.outro)) return null;
  if (!Array.isArray(parsed.items)) return null;
  const items: OutlineItem[] = [];
  const seenIds = new Set<string>();
  parsed.items.forEach((raw, idx) => {
    const item = validateItem(raw, idx);
    if (!item) return;
    let id = item.id;
    if (seenIds.has(id)) id = `${id}_${idx}`;
    seenIds.add(id);
    items.push({ ...item, id });
  });
  if (items.length === 0) return null;
  return {
    title: parsed.title.trim(),
    intro: parsed.intro.trim(),
    items,
    outro: parsed.outro.trim(),
  };
}

/**
 * Run the outliner. Single Sonnet max-effort call, ~10 min budget.
 * Throws on failure (no fallback — the orchestrator must decide).
 */
export async function generateLessonOutline(input: OutlinerInput): Promise<LessonOutline> {
  const tools = input.enableWebSearch ? 'WebSearch' : 'none';
  const maxTurns = input.enableWebSearch ? 4 : 1;
  const result = await runAgent(buildUserPrompt(input), {
    model: 'sonnet',
    effort: 'max',
    systemPrompt: withPresentationMode(SYSTEM_PROMPT, input.presentationMode),
    tools,
    maxTurns,
    timeoutMs: 600_000,
  });
  const raw = result.result ?? '';
  const parsed = parseLoose(raw);
  const outline = validate(parsed);
  if (!outline) {
    throw new Error(`Outliner produced invalid JSON. First 400 chars: ${raw.slice(0, 400)}`);
  }
  return outline;
}

export const __test = { validate, parseLoose, buildUserPrompt, renderLearnerStateBlock };
