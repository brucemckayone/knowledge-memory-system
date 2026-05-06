/**
 * Quiz Generator Agent
 *
 * Generates a question for a concept, informed by:
 * - The learner's current understanding of the concept
 * - What related concepts exist in the curriculum graph
 * - Web research for accuracy and context
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';
import { db, questions } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'learning-mcp.ts');

const SYSTEM_PROMPT = `You are an expert quiz designer. Generate a single, high-quality question that probes understanding of a concept.

Before generating, use your MCP tools to:
1. get_learner_understanding — check what level they're already at (tailor difficulty)
2. get_prerequisite_chain — understand what foundational concepts they need
3. search_curriculum — see what related concepts exist so you can test connections

Then use web search if you need to verify accuracy or find a good real-world angle.

## Question design principles
- Open-ended (never multiple choice) — probe actual understanding
- Require explanation, not recall — "explain why", "describe how", "what would happen if"
- Target the right difficulty: if they're at 0.8+ understanding, ask a challenging application question; if <0.5, ask a foundational question
- Connect to related concepts where possible — demonstrate breadth of understanding

## Output format
Output ONLY this JSON (no surrounding text):
{
  "questionText": "string — the question to ask",
  "expectedAnswer": "string — key points a good answer should cover (used by evaluator, not shown to learner)",
  "explanation": "string — explanation shown AFTER they answer",
  "difficulty": 1-5,
  "targetsConcept": "string — the concept this primarily tests",
  "generationRationale": "string — brief note on why this question, not shown to learner"
}`;

export interface GeneratedQuestion {
  questionText: string;
  expectedAnswer: string;
  explanation: string;
  difficulty: number;
  targetsConcept: string;
  generationRationale: string;
}

export async function generateQuestion(params: {
  concept: string;
  sectionId: string;
  conceptEntityId?: string;
}): Promise<string> {
  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
  });

  const prompt = `Generate a question that tests understanding of: "${params.concept}"\n\nCheck the learner's current state and related concepts before designing the question. Output JSON only.`;

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT,
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 8,
  });

  let q: GeneratedQuestion;
  try {
    const jsonMatch = result.result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in output');
    q = JSON.parse(jsonMatch[0]) as GeneratedQuestion;
  } catch {
    // Fallback: create a generic question
    q = {
      questionText: `Explain the concept of "${params.concept}" in your own words and give an example.`,
      expectedAnswer: `Should demonstrate understanding of ${params.concept} with a clear explanation and relevant example.`,
      explanation: `${params.concept} is an important concept in this subject.`,
      difficulty: 3,
      targetsConcept: params.concept,
      generationRationale: 'Fallback generic question',
    };
  }

  const questionId = randomUUID();
  await db.insert(questions).values({
    id: questionId,
    sectionId: params.sectionId,
    questionText: q.questionText,
    expectedAnswer: q.expectedAnswer,
    explanation: q.explanation,
    difficulty: q.difficulty,
    questionType: 'generated',
    conceptEntityId: params.conceptEntityId ?? null,
  });

  return questionId;
}
