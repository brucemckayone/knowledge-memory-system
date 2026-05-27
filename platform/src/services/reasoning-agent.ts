/**
 * Reasoning Agent — Invocation Surface
 *
 * Extracted from causal-agent.ts under bead nmemo-2yv.80. Owns the
 * platform-side invocation of the ml-services `/reasoning-agent` endpoint
 * (which shells out to Claude Code with the reasoning-agent MCP config and
 * system prompt).
 *
 * Scope intentionally narrow: only `invokeReasoningAgent` and its parameter
 * shapes live here. The reasoning-related MCP tool definitions
 * (`get_reasoning_history`, `save_reasoning_report`, `get_reasoning_targets`)
 * and their dispatcher handlers remain in causal-agent.ts inside the unified
 * GRAPH_TOOLS list and `handleToolCall` switch — splitting those out cleanly
 * needs a barrel/dispatcher refactor that nmemo-2yv.80 explicitly leaves for
 * a follow-up.
 *
 * `AgentInvocationTimeoutError` is re-exported from causal-agent.ts so
 * callers (src/index.ts, the timeout test) can migrate their imports
 * incrementally without a separate sweep.
 */

import { config } from '../config.js';
import {
  AgentInvocationTimeoutError,
  agentFetch,
  getMcpConfigPath,
} from './causal-agent.js';

// Re-export so consumers can import the timeout error from the
// reasoning-agent module directly. The class still lives in causal-agent.ts
// because invokeGraphAgent and invokeGardenerAgent share it.
export { AgentInvocationTimeoutError };

export interface ReasoningAgentParams {
  mode: 'patrol' | 'query';
  question?: string;
  /**
   * Server-side idempotency key for save_reasoning_report (bead nmemo-2yv.77).
   * Generated once per /api/reason invocation by the caller, forwarded to
   * ml-services in the POST body, rendered into the agent's system prompt,
   * and passed back on save_reasoning_report. A second save inside the same
   * pass UPSERTs the existing row instead of inserting a duplicate.
   */
  invocationId?: string;
}

export interface ReasoningAgentResult {
  result: string;
}

export async function invokeReasoningAgent(params: ReasoningAgentParams): Promise<ReasoningAgentResult> {
  const mcpConfigPath = getMcpConfigPath('reasoning_agent');

  const result = await agentFetch<ReasoningAgentResult>({
    agent: 'reasoning_agent',
    url: `${config.ML_SERVICES_URL}/reasoning-agent`,
    body: {
      mode: params.mode,
      question: params.question,
      mcp_config_path: mcpConfigPath,
      invocation_id: params.invocationId,
    },
    timeoutMs: config.REASONING_AGENT_TIMEOUT_MS,
  });

  // Phase 6 (nmemo-d9v.13): bump the pattern-detection counter on patrol
  // success. Every PATTERN_DETECTION_INTERVAL patrols runs detectCausalPatterns
  // + promotePatterns. Wrapped in try/catch inside incrementPatrolCount —
  // any failure logs but never surfaces.
  //
  // Phase 1 cluster-bridging (nmemo-a7f.1.1, doc 22 §3.3): bump the
  // graph-stats counter on the same patrol-success edge. Independent counter
  // and interval — both run sequentially; neither blocks the other.
  if (params.mode === 'patrol') {
    const { incrementPatrolCount, incrementGraphStatsCount } = await import('../pipeline.js');
    await incrementPatrolCount();
    await incrementGraphStatsCount();
  }

  return result;
}
