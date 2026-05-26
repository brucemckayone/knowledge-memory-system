/**
 * B06 Integration: Unified graph MCP server end-to-end
 *
 * Spawns the real MCP server (graph-mcp.ts) and verifies it exposes the
 * seven causal-reasoning tools through the JSON-RPC handshake. This
 * complements graph-mcp-health.test.ts (which mocks `node:child_process`)
 * by exercising the real subprocess path.
 *
 * Requires: PostgreSQL.
 */

import { describe, it, expect } from 'vitest';
import { checkGraphMcpHealth } from '../../services/causal-agent.js';

describe('B06 Integration: graph MCP server end-to-end', () => {
  // --- MCP Health Check ---

  it('graph MCP server starts and exposes the seven causal tools', async () => {
    const health = await checkGraphMcpHealth();

    expect(health.ok).toBe(true);
    expect(health.tools).toBeDefined();
    // Server now hosts the unified tool set (causal + extraction + reconciliation
    // + gardener + reasoning); assert the seven original causal tools are present.
    for (const t of [
      'create_causal_edge', 'query_entity_facts', 'query_entity_neighbours',
      'search_similar_entities', 'search_memories', 'get_memory_text', 'get_causal_history',
    ]) {
      expect(health.tools).toContain(t);
    }
    expect(health.durationMs).toBeLessThan(15_000);
  }, 20_000);
});
