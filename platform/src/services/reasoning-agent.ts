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
  /**
   * Bead nmemo-0wq.3 — graph-anchored fallback evidence (doc 38 §6.2.1).
   * Populated by the /api/reason/query boundary ONLY when the pre-flight flat
   * retrieval failed the §6.1 confidence bar and the fallback recovered ranked
   * unit-grained evidence. Forwarded to ml-services so the reasoning agent can
   * reason over flat + fallback evidence together. Undefined (omitted) when flat
   * retrieval succeeded or nothing anchored — the no-regression / no-anchor cases.
   */
  fallbackEvidence?: unknown[];
}

export interface ReasoningAgentResult {
  result: string;
}

export async function invokeReasoningAgent(params: ReasoningAgentParams): Promise<ReasoningAgentResult> {
  const mcpConfigPath = getMcpConfigPath('reasoning_agent');

  // Bead nmemo-2yv.72 decoupled pattern-detection + graph-stats cadences
  // from the reasoning-patrol success edge. Both now react directly to fact
  // inserts via public.derived_freshness counters + threshold helpers in
  // src/services/derived-freshness.ts (post-insert hook in createFact).
  // The wrapper no longer post-processes patrol success — the result is
  // surfaced verbatim and the cadences run on their own DB-reactive schedule.
  return await agentFetch<ReasoningAgentResult>({
    agent: 'reasoning_agent',
    url: `${config.ML_SERVICES_URL}/reasoning-agent`,
    body: {
      mode: params.mode,
      question: params.question,
      mcp_config_path: mcpConfigPath,
      invocation_id: params.invocationId,
      // Bead nmemo-0wq.3 — omitted unless the boundary recovered fallback evidence.
      fallback_evidence: params.fallbackEvidence,
    },
    timeoutMs: config.REASONING_AGENT_TIMEOUT_MS,
  });
}
