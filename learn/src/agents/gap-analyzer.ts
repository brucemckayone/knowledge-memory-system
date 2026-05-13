/**
 * Gap Analyzer + Content Generator Agent
 *
 * THE WOW MOMENT.
 *
 * Reads the learner's current graph state, finds the highest-impact gap
 * (the weakness that blocks the most downstream understanding), traces
 * its causal history, then generates targeted content to fix it.
 *
 * Output: a mini-lesson targeted at the root cause + follow-up questions.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';
import { withPresentationMode } from './presentation-mode.js';
import { getStruggleAreas, getConcept } from '../services/nmemo-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const SYSTEM_PROMPT = `You are an adaptive learning system. Your job is to identify the most important gap in a learner's knowledge and generate targeted content to address it.

## Phase 1 — Diagnose (use MCP tools — be efficient, prefer cheap tools first)
1. get_struggle_areas — fast, direct query for low-confidence and confused areas. Use FIRST.
2. get_prerequisite_chain — fast, direct query for prerequisite structure. Use for the weakest concepts.
3. ONLY IF still ambiguous: get_causal_learning_history for ONE concept — this is expensive (full reasoning agent), use sparingly.

Do not call get_learning_gaps unless you have no other signal — it triggers the full reasoning agent.

CRITICAL: The MCP tools return JSON containing entity ids (entityId / object_entity_id / entity.id fields). Capture the id of whichever concrete concept you decide is the root cause — you will be required to emit it verbatim as the first line of your output. Do not lose track of it.

## Phase 2 — Generate targeted content
Based on your diagnosis, create a focused mini-lesson that:
- Addresses the ROOT CAUSE gap (not just the symptom)
- Explains WHY this matters (connects to what they're trying to understand)
- Uses clear examples and analogies
- Is appropriately short (learners don't want a textbook — 3-5 paragraphs)
- Ends with 2-3 follow-up questions that will check if the lesson worked

## Output format — TWO PARTS in this exact order

### Part 1 — Root-cause id trailer (MUST be the FIRST line)
Models reliably stop generating after closed JSON, so the trailer comes BEFORE the JSON. The very first non-whitespace line of your output MUST be:

ROOT_CAUSE: { "entityId": "<exact-id-from-mcp-tool>", "conceptName": "<concept name>" }

Rules:
  - entityId MUST be the exact id string returned by an MCP tool during Phase 1 (look for entityId / object_entity_id / id fields in tool JSON). Do NOT fabricate ids.
  - If you genuinely cannot resolve a single concrete entity id (cold-start / no signal), emit entityId: null, but still emit the trailer. Do NOT omit it.
    ROOT_CAUSE: { "entityId": null, "conceptName": "<best-guess concept name>" }
  - One line, no code fence, no leading whitespace, before any other content.

### Part 2 — JSON body (after the trailer line, separated by a blank line)
{
  "targetConcept": "string — the specific gap being addressed",
  "rootCause": "string — why the learner has this gap (causal trace in plain language)",
  "whyItMatters": "string — what this blocks downstream",
  "lesson": "string — the mini-lesson content (markdown formatted, 3-5 paragraphs)",
  "followUpQuestions": [
    {
      "questionText": "string",
      "hint": "string — a brief hint to guide them"
    }
  ],
  "nextSteps": "string — what to study after this"
}

Your output should look exactly like:

ROOT_CAUSE: { "entityId": "abc-123", "conceptName": "binary search trees" }

{
  "targetConcept": "...",
  ...
}`;

export interface GapAnalysisResult {
  targetConcept: string;
  rootCause: string;
  whyItMatters: string;
  lesson: string;
  followUpQuestions: Array<{ questionText: string; hint: string }>;
  nextSteps: string;
  /** Structured root-cause entity id emitted by the agent's ROOT_CAUSE: trailer.
   *  null when the agent could not resolve a concrete entity id. The persistence
   *  layer prefers this over a name-based lookup. */
  rootCauseEntityId: string | null;
  /** The concept name from the ROOT_CAUSE: trailer when available. Falls back
   *  to targetConcept when the trailer is missing. */
  rootCauseConceptName: string | null;
}

export interface ParsedRootCause {
  entityId: string | null;
  conceptName: string | null;
}

/**
 * Parse the `ROOT_CAUSE: { ... }` trailer. Now emitted as the FIRST line of
 * the agent's output (models reliably stop after JSON, so the trailer is
 * less likely to be truncated when it leads). We still tolerate a trailing
 * trailer for back-compat: anchor on the first occurrence, fall through to
 * the last if the first doesn't parse.
 */
export function parseRootCauseTrailer(raw: string): ParsedRootCause {
  if (!raw) return { entityId: null, conceptName: null };
  const re = /ROOT_CAUSE\s*:\s*(\{[^{}]*\})/gi;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) matches.push(m);
  if (matches.length === 0) return { entityId: null, conceptName: null };

  // Score each viable trailer by payload richness (entityId beats conceptName-only).
  // On ties, later wins — defends against the agent echoing the marker mid-prose
  // before emitting the real trailer.
  let best: ParsedRootCause = { entityId: null, conceptName: null };
  let bestScore = -1;
  for (const match of matches) {
    try {
      const obj = JSON.parse(match[1]!) as { entityId?: unknown; conceptName?: unknown };
      const entityId = typeof obj.entityId === 'string' && obj.entityId.length > 0
        ? obj.entityId
        : null;
      const conceptName = typeof obj.conceptName === 'string' && obj.conceptName.length > 0
        ? obj.conceptName
        : null;
      const score = (entityId ? 2 : 0) + (conceptName ? 1 : 0);
      if (score >= bestScore && score > 0) {
        best = { entityId, conceptName };
        bestScore = score;
      }
    } catch { /* try next match */ }
  }
  return best;
}

/**
 * Fallback resolver. When the LLM omits the trailer or emits `entityId: null`,
 * resolve a concrete entity id deterministically so the dashboard CTA can
 * route to a section.
 *
 * Resolution order:
 *  1. getConcept(targetConcept) — direct name → entity id. The MCP /concept/:name
 *     endpoint does fuzzy matching against canonical_name + aliases.
 *  2. If the resolved entity also appears in the learner's weak areas (low
 *     confidence), that's a perfect match.
 *  3. If the concept doesn't resolve by name, fall back to the lowest-confidence
 *     weak-area entity id — better to point at SOMETHING the learner is
 *     struggling with than fail open.
 */
async function resolveEntityIdFromStruggle(targetConcept: string | undefined | null): Promise<string | null> {
  const needle = (targetConcept ?? '').trim();

  // 1. Direct name lookup.
  if (needle.length > 0) {
    try {
      const concept = await getConcept(needle);
      if (concept?.entity?.id && concept.entity.entityType === 'concept') {
        return concept.entity.id;
      }
    } catch (err) {
      console.warn('[gap-analyzer] getConcept lookup failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Lowest-confidence weak-area fallback.
  try {
    const { weakAreas } = await getStruggleAreas();
    const withIds = weakAreas.filter(w => w.entityId);
    if (withIds.length === 0) return null;
    withIds.sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
    return withIds[0]!.entityId;
  } catch (err) {
    console.warn('[gap-analyzer] getStruggleAreas fallback failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function analyzeGapsAndGenerateContent(params: {
  courseTopic?: string;
  presentationMode?: boolean;
}): Promise<GapAnalysisResult> {
  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
  });

  const topicNote = params.courseTopic ? ` The learner is studying: ${params.courseTopic}.` : '';

  const prompt = `Diagnose the learner's most important knowledge gap and generate targeted content to fix it.${topicNote}

Use the MCP tools to understand their current state, then generate a focused mini-lesson. Output JSON only.`;

  const result = await runAgent(prompt, {
    model: 'sonnet',
    effort: 'medium',
    systemPrompt: withPresentationMode(SYSTEM_PROMPT, params.presentationMode),
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 12,
    timeoutMs: 900_000, // 15 min — gap analyzer can recursively trigger Nmemo reasoning agent
  });

  // Strip ALL ROOT_CAUSE: trailers (one at the start under the new prompt,
  // potentially one at the end under the legacy prompt) before extracting the
  // JSON body so the greedy {...} match doesn't accidentally swallow trailer braces.
  const rootCause = parseRootCauseTrailer(result.result);
  const withoutTrailer = result.result.replace(/ROOT_CAUSE\s*:\s*\{[^{}]*\}/gi, '').trim();

  // Build the result body — parse JSON, or fall back to the prose-only template.
  let body: Omit<GapAnalysisResult, 'rootCauseEntityId' | 'rootCauseConceptName'>;
  try {
    const jsonMatch = withoutTrailer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in output');
    body = JSON.parse(jsonMatch[0]) as typeof body;
  } catch {
    body = {
      targetConcept: 'General review needed',
      rootCause: 'Unable to determine root cause — more quiz data needed',
      whyItMatters: 'Building strong foundations is important for all learning',
      lesson: result.result || 'Please complete more quizzes so the system can identify your specific gaps.',
      followUpQuestions: [
        { questionText: 'What concept have you found most challenging so far?', hint: 'Be specific' },
        { questionText: 'Can you explain what you understand about the main topic in your own words?', hint: 'Start from the beginning' },
      ],
      nextSteps: 'Continue with quizzes to help the system learn where to focus.',
    };
  }

  // Resolve the entity id. Prefer the agent-emitted trailer; otherwise pick
  // the best match from the learner's current struggle areas so the dashboard
  // CTA always has a concrete entity to route from.
  let rootCauseEntityId = rootCause.entityId;
  if (!rootCauseEntityId) {
    rootCauseEntityId = await resolveEntityIdFromStruggle(rootCause.conceptName ?? body.targetConcept);
    if (rootCauseEntityId) {
      console.log(`[gap-analyzer] trailer missing; synthesised entity id ${rootCauseEntityId} from struggle areas for "${body.targetConcept}"`);
    }
  }

  return {
    ...body,
    rootCauseEntityId,
    rootCauseConceptName: rootCause.conceptName ?? body.targetConcept ?? null,
  };
}

// Test-only hooks.
export const __test = { parseRootCauseTrailer, resolveEntityIdFromStruggle };
