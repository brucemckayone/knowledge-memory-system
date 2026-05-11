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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const SYSTEM_PROMPT = `You are an adaptive learning system. Your job is to identify the most important gap in a learner's knowledge and generate targeted content to address it.

## Phase 1 — Diagnose (use MCP tools — be efficient, prefer cheap tools first)
1. get_struggle_areas — fast, direct query for low-confidence and confused areas. Use FIRST.
2. get_prerequisite_chain — fast, direct query for prerequisite structure. Use for the weakest concepts.
3. ONLY IF still ambiguous: get_causal_learning_history for ONE concept — this is expensive (full reasoning agent), use sparingly.

Do not call get_learning_gaps unless you have no other signal — it triggers the full reasoning agent.

## Phase 2 — Generate targeted content
Based on your diagnosis, create a focused mini-lesson that:
- Addresses the ROOT CAUSE gap (not just the symptom)
- Explains WHY this matters (connects to what they're trying to understand)
- Uses clear examples and analogies
- Is appropriately short (learners don't want a textbook — 3-5 paragraphs)
- Ends with 2-3 follow-up questions that will check if the lesson worked

## Output format
Output this JSON:
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
}`;

export interface GapAnalysisResult {
  targetConcept: string;
  rootCause: string;
  whyItMatters: string;
  lesson: string;
  followUpQuestions: Array<{ questionText: string; hint: string }>;
  nextSteps: string;
}

export async function analyzeGapsAndGenerateContent(params: {
  courseTopic?: string;
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
    systemPrompt: SYSTEM_PROMPT,
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 12,
    timeoutMs: 900_000, // 15 min — gap analyzer can recursively trigger Nmemo reasoning agent
  });

  try {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in output');
    return JSON.parse(jsonMatch[0]) as GapAnalysisResult;
  } catch {
    return {
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
}
