/**
 * Article Generator Agent
 *
 * Given a dense cluster of concepts the learner has recently touched across
 * multiple courses (typically 5-10), produces a markdown synthesis article
 * that ties the cluster together by identifying the underlying principle
 * they share. Pure generation: no MCP, no graph mutations, single LLM turn,
 * ~90s budget.
 *
 * Triggered on demand or by the patrol agent when a dense cross-course
 * cluster is detected. Persistence (articles table, surfacing on dashboard)
 * is handled by downstream beads — this agent just returns a result.
 *
 * Model: Haiku per project preference. Synthesis writing is a place where
 * Sonnet may genuinely outperform; if live testing shows Haiku producing
 * generic or shallow articles, flip the `model` option below to 'sonnet'.
 */
import { runAgent } from '../services/agent.js';

export interface ArticleGenConcept {
  entityId: string;
  name: string;
  courseId?: string;
  courseTitle?: string;
  /** Optional one-line about how the learner knows this concept. */
  relatedFactSummary?: string;
}

export interface ArticleGenInput {
  /** Typically 5-10 concepts; capped at 12 inside the prompt. */
  concepts: ArticleGenConcept[];
  /** Optional steering — e.g. "the learner has seen these in algorithms and crypto". */
  hint?: string;
}

export interface ArticleGenResult {
  ok: boolean;
  /** Short headline. Empty string when ok=false. */
  title: string;
  /** Markdown body, 3-8 paragraphs. Empty string when ok=false. */
  contentMd: string;
  /** Echoed from input for traceability (in original order). */
  conceptEntityIds: string[];
  /** Why these concepts cluster (1-2 sentences). Optional. */
  rationale?: string;
  /** Present if ok=false — describes what went wrong. */
  errorText?: string;
}

const MAX_CONCEPTS = 12;
const MIN_CONTENT_CHARS = 200;

const SYSTEM_PROMPT = `You are a synthesis writer for an adaptive learning platform. Your job: given a cluster of concepts the learner has recently touched across multiple courses, write a short article (3-8 paragraphs of markdown) that ties them together by identifying the underlying principle they share. Don't summarise each concept individually — the learner has already seen them. Focus on what they have in common, the abstraction that connects them, and why this connection matters.

Tone: clear, deliberate, prose. No fluff. Use markdown features (headings, bold, occasional bullet lists) sparingly.

Avoid:
- Definitions of each concept (the learner has them)
- Generic textbook-isms ("In conclusion, ...")
- Padding ("Let's explore the fascinating world of...")

Output JSON only — no surrounding prose, no markdown fences. The first character must be '{', the last must be '}'. Escape newlines inside string fields as \\n.

Shape:
{
  "title": "string — short headline",
  "contentMd": "string — markdown body, 3-8 paragraphs",
  "rationale": "string — 1-2 sentences on why these concepts cluster"
}`;

function buildUserPrompt(input: ArticleGenInput): string {
  const capped = input.concepts.slice(0, MAX_CONCEPTS);
  const lines: string[] = [
    `Write a synthesis article for the following ${capped.length} concept${capped.length === 1 ? '' : 's'} the learner has recently touched. Identify the underlying principle that connects them.`,
    '',
    'Concepts:',
  ];

  for (const c of capped) {
    const courseBit = c.courseTitle
      ? ` (course: ${c.courseTitle})`
      : c.courseId
        ? ` (course: ${c.courseId})`
        : '';
    const factBit = c.relatedFactSummary?.trim()
      ? ` — ${c.relatedFactSummary.trim()}`
      : '';
    lines.push(`- ${c.name}${courseBit}${factBit}`);
  }

  if (input.hint?.trim()) {
    lines.push('', `Steering hint: ${input.hint.trim()}`);
  }

  lines.push('', 'Output the JSON object only.');
  return lines.join('\n');
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

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function nonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

interface ParsedArticle {
  title: string;
  contentMd: string;
  rationale?: string;
}

function validateOutput(parsed: unknown): ParsedArticle | null {
  if (!isObj(parsed)) return null;
  if (!nonEmptyString(parsed.title)) return null;
  if (!nonEmptyString(parsed.contentMd)) return null;
  const title = parsed.title.trim();
  const contentMd = parsed.contentMd.trim();
  if (contentMd.length < MIN_CONTENT_CHARS) return null;
  const result: ParsedArticle = { title, contentMd };
  if (nonEmptyString(parsed.rationale)) result.rationale = parsed.rationale.trim();
  return result;
}

/**
 * Generate a synthesis article that ties a dense cluster of concepts together.
 *
 * Bounded: 90s timeout, maxTurns 2, no MCP tools. Returns ok=true with a
 * validated title + contentMd, or ok=false with errorText describing what
 * went wrong (input validation, agent error, parse failure, or output
 * validation failure).
 */
export async function generateArticle(input: ArticleGenInput): Promise<ArticleGenResult> {
  const conceptEntityIds = (input.concepts ?? []).map(c => c.entityId);

  if (!Array.isArray(input.concepts) || input.concepts.length === 0) {
    return {
      ok: false,
      title: '',
      contentMd: '',
      conceptEntityIds,
      errorText: 'No concepts provided',
    };
  }

  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(input);

  let raw = '';
  try {
    const result = await runAgent(userPrompt, {
      // Haiku per project preference. Bump to 'sonnet' if synthesis quality
      // is consistently shallow on live testing.
      model: 'haiku',
      effort: 'low',
      systemPrompt,
      // No mcpConfigPath — pure generation, no tool calls.
      tools: 'none',
      // Synthesis can take longer than a single component; allow 2 turns so
      // the model can self-correct an invalid first emission.
      maxTurns: 2,
      timeoutMs: 90_000,
    });
    raw = result.result ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[article-generator] runAgent failed: ${msg}`);
    return {
      ok: false,
      title: '',
      contentMd: '',
      conceptEntityIds,
      errorText: `Agent invocation failed: ${msg}`,
    };
  }

  const parsed = parseLoose(raw);
  if (!parsed) {
    console.warn(`[article-generator] could not parse JSON; first 200 chars: ${raw.slice(0, 200)}`);
    return {
      ok: false,
      title: '',
      contentMd: '',
      conceptEntityIds,
      errorText: `Failed to parse JSON output. Raw: ${raw.slice(0, 1000)}`,
    };
  }

  const validated = validateOutput(parsed);
  if (!validated) {
    console.warn(`[article-generator] output failed validation; first 200 chars: ${raw.slice(0, 200)}`);
    return {
      ok: false,
      title: '',
      contentMd: '',
      conceptEntityIds,
      errorText: `Output failed validation (missing title, missing contentMd, or contentMd < ${MIN_CONTENT_CHARS} chars). Raw: ${raw.slice(0, 1000)}`,
    };
  }

  return {
    ok: true,
    title: validated.title,
    contentMd: validated.contentMd,
    conceptEntityIds,
    rationale: validated.rationale,
  };
}
