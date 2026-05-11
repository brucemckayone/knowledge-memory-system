/**
 * Answer Evaluator Agent
 *
 * Evaluates a learner's quiz answer. Uses:
 * - The expected answer from the question definition
 * - The learner's current understanding history from the graph
 * - Web search for accuracy verification
 *
 * Produces rich feedback and silently updates the learner graph via MCP.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const SYSTEM_PROMPT = `You are an expert educator evaluating a learner's answer. Your job has two parts:

**Part 1 — Research and evaluate (using MCP tools + web search):**
1. get_learner_understanding for the concept — what do we already know about their understanding?
2. Use web search if needed to verify the factual accuracy of their answer
3. Assess the quality of their answer on a 0-1 scale

**Part 2 — Update the knowledge graph (MCP write tools):**
Based on your evaluation, make targeted graph updates:
- Call record_quiz_result with the score
- Call record_understanding if they showed strong understanding (>0.7)
- Call record_confusion if they expressed a specific, identifiable misconception
- Call flag_prerequisite_gap if their answer reveals a foundational gap
- Call update_learning_trajectory recommending the next concept if appropriate

**Part 3 — Write rich feedback for the learner:**
The feedback should:
- Acknowledge what they got right specifically
- Correct any misconceptions with clear explanation (not just "wrong")
- If they're missing a prerequisite, tell them which foundational concept to study
- Give the explanation from the question if they struggled
- End with an encouraging note and what to focus on next

## Output format
Output this JSON:
{
  "score": 0-1,
  "scoreLabel": "Excellent" | "Good" | "Partial" | "Needs Work",
  "feedback": "string — rich feedback shown to the learner (2-4 paragraphs)",
  "internalNotes": "string — brief internal notes on what graph updates were made"
}`;

export interface EvaluationResult {
  score: number;
  scoreLabel: string;
  feedback: string;
  internalNotes: string;
}

export async function evaluateAnswer(params: {
  questionText: string;
  expectedAnswer: string;
  explanation: string;
  conceptName: string;
  answerText: string;
}): Promise<EvaluationResult> {
  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
  });

  const prompt = `Evaluate this answer:

**Question:** ${params.questionText}

**Expected answer (key points):** ${params.expectedAnswer}

**Concept being tested:** ${params.conceptName}

**Learner's answer:** ${params.answerText}

**Explanation to give if needed:** ${params.explanation}

Check the learner's prior history on this concept, evaluate the answer, update the graph, then provide feedback. Output JSON only.`;

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT,
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 12,
    timeoutMs: 600_000, // 10 min
  });

  try {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in output');
    return JSON.parse(jsonMatch[0]) as EvaluationResult;
  } catch {
    // Fallback evaluation
    const words = params.answerText.trim().split(/\s+/).length;
    const hasContent = words > 10;
    return {
      score: hasContent ? 0.5 : 0.2,
      scoreLabel: hasContent ? 'Partial' : 'Needs Work',
      feedback: `Thank you for your answer. ${hasContent ? 'You showed some understanding.' : 'Try to provide more detail.'} The key points to focus on: ${params.explanation}`,
      internalNotes: 'Fallback evaluation — agent output was unparseable',
    };
  }
}
