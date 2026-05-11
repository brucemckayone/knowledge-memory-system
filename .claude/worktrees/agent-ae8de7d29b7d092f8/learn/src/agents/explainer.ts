/**
 * Explainer Agent
 *
 * On-demand "popover-sized" explainer for highlighted text in a lesson.
 * The learner selects a phrase and picks Explain / Example / Why; this
 * agent returns 1-3 short paragraphs of plain markdown.
 *
 * Pure generation — no MCP, no tools, no graph mutations. Single LLM
 * turn, ~10s timeout. Smaller and faster than the structured agents:
 * the popover wants prose, not JSON.
 *
 * Model: Haiku, low effort. The bound is "feels instant in the popover",
 * so we keep prompts tight and tools off.
 */
import { runAgent } from '../services/agent.js';

export type ExplainerAction = 'explain' | 'example' | 'why';

export interface ExplainerInput {
  selectedText: string;
  action: ExplainerAction;
  sectionContext?: string;
  courseContext?: string;
}

export interface ExplainerResult {
  ok: boolean;
  contentMd: string;
  errorText?: string;
}

const BASE_SYSTEM = `You are a concise, helpful educator. The learner selected a phrase from a lesson and asked for a quick popover-sized explanation. Your output appears inside a small popover next to their text selection, so it MUST be brief.

Hard rules:
- Output plain markdown ONLY — no JSON, no fences, no preamble like "Sure" or "Here is".
- 1-3 short paragraphs maximum. No long lists. A handful of inline emphasis or one short bullet group is fine.
- Do not repeat the selected text back verbatim as a heading.
- Be specific to the selected text, not the whole lesson. Stay in scope.
- Plain language. Avoid jargon unless the selected text is itself the jargon and you're defining it.
- Do NOT include closing meta like "Hope that helps" or "Let me know".`;

const ACTION_PROMPTS: Record<ExplainerAction, string> = {
  explain: `Action: EXPLAIN
Explain this concept in 2-3 sentences, in plain language. If it's a term, define it; if it's a phrase, paraphrase what it means.`,
  example: `Action: EXAMPLE
Give one short, concrete example that illustrates this concept. A single paragraph or a small code block is ideal. Do not give multiple examples — just one good one.`,
  why: `Action: WHY
Explain why this matters or why it's non-obvious. 1-2 short paragraphs. Focus on the insight or implication, not the definition.`,
};

function buildSystemPrompt(action: ExplainerAction): string {
  return `${BASE_SYSTEM}\n\n${ACTION_PROMPTS[action]}`;
}

function buildUserPrompt(input: ExplainerInput): string {
  const parts: string[] = [];
  parts.push(`Selected text: """${input.selectedText.trim()}"""`);
  if (input.sectionContext && input.sectionContext.trim().length > 0) {
    parts.push('', `Lesson section context: ${input.sectionContext.trim()}`);
  }
  if (input.courseContext && input.courseContext.trim().length > 0) {
    parts.push('', `Course context: ${input.courseContext.trim()}`);
  }
  parts.push(
    '',
    'Respond in plain markdown only, following the action rules above.',
  );
  return parts.join('\n');
}

/**
 * Generate a popover-sized explanation for a selected text fragment.
 * Bounded: ~10s, single turn, no tools.
 *
 * Returns `{ ok: true, contentMd }` on success or `{ ok: false, errorText, contentMd }`
 * on any failure (timeout, empty output, spawn error). `contentMd` always carries
 * displayable text so the popover never shows nothing.
 */
export async function explain(input: ExplainerInput): Promise<ExplainerResult> {
  const text = (input.selectedText ?? '').trim();
  if (!text) {
    return {
      ok: false,
      contentMd: '_No text selected._',
      errorText: 'empty selectedText',
    };
  }
  const action = input.action;
  if (action !== 'explain' && action !== 'example' && action !== 'why') {
    return {
      ok: false,
      contentMd: '_Unknown action._',
      errorText: `unknown action: ${String(action)}`,
    };
  }

  const systemPrompt = buildSystemPrompt(action);
  const userPrompt = buildUserPrompt({ ...input, selectedText: text });

  let raw = '';
  try {
    const result = await runAgent(userPrompt, {
      model: 'haiku',
      effort: 'low',
      systemPrompt,
      tools: 'none',
      maxTurns: 1,
      timeoutMs: 30_000, // popover budget — agent itself targets ~5-10s
    });
    raw = (result.result ?? '').trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[explainer] runAgent failed for action=${action}: ${msg}`);
    return {
      ok: false,
      contentMd: `_Couldn't generate an explanation right now. (${msg.slice(0, 120)})_`,
      errorText: msg,
    };
  }

  if (!raw) {
    return {
      ok: false,
      contentMd: '_Empty response from explainer agent._',
      errorText: 'empty agent output',
    };
  }

  // Strip a leading triple-fence wrapper if the model added one despite instructions.
  const fence = raw.match(/^```(?:markdown|md)?\s*([\s\S]*?)```\s*$/);
  const cleaned = fence?.[1] ? fence[1].trim() : raw;

  return { ok: true, contentMd: cleaned };
}
