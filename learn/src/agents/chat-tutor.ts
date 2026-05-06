/**
 * Chat Tutor Agent
 *
 * Processes a chat message from the learner. Responds as a helpful tutor
 * and silently uses MCP tools to make targeted, deliberate graph updates
 * when the conversation reveals something worth recording.
 *
 * The learner never sees the graph updates — they just get a good tutor response.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { runAgent, writeMcpConfig } from '../services/agent.js';

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

export interface ChatTutorResult {
  response: string;
  nmemoUpdates: Array<{ tool: string; args: Record<string, unknown> }>;
}

export async function processChatMessage(params: {
  message: string;
  history: Array<{ role: string; content: string }>;
  courseTopic?: string;
}): Promise<ChatTutorResult> {
  const mcpConfigPath = writeMcpConfig('learn', MCP_SCRIPT, {
    NMEMO_URL: config.NMEMO_URL,
    NODE_ENV: config.NODE_ENV,
  });

  // Build conversation context
  const historyText = params.history.slice(-6) // last 3 exchanges
    .map(m => `${m.role === 'user' ? 'Learner' : 'Tutor'}: ${m.content}`)
    .join('\n');

  const contextNote = params.courseTopic
    ? `The learner is studying: ${params.courseTopic}\n\n`
    : '';

  const prompt = `${contextNote}${historyText ? `Recent conversation:\n${historyText}\n\n` : ''}Learner's latest message: "${params.message}"\n\nFirst check their understanding state via MCP tools if relevant, then respond as their tutor.`;

  const result = await runAgent(prompt, {
    model: 'haiku',
    effort: 'low',
    systemPrompt: SYSTEM_PROMPT,
    mcpConfigPath,
    mcpServerName: 'learn',
    maxTurns: 10,
    timeoutMs: 600_000, // 10 min
  });

  // The result.result is the tutor's text response (last text block from claude)
  // We don't have easy visibility into which MCP calls were made from the text output,
  // but the MCP server has already executed them. Return the response as-is.
  return {
    response: result.result,
    nmemoUpdates: [], // MCP calls already fired, we don't enumerate them in the response
  };
}
