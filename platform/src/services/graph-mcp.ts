#!/usr/bin/env node
/**
 * Graph MCP Server — Unified tool server for the knowledge graph.
 *
 * Exposes all graph tools (read + write) via stdio MCP transport.
 * Used by both the extraction agent and the causal reasoning agent.
 *
 * Usage: npx tsx src/services/graph-mcp.ts
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GRAPH_TOOLS, handleToolCall, allowlistFor, resolveActorFromEnv } from './causal-agent.js';
import { toActionableMcpError } from './mcp-errors.js';

// Per-actor tool surface (doc 41 §8a, §9.5). This server process is spawned
// once per actor with MNEMO_AGENT_ACTOR fixed in its env, so the actor — and
// thus the advertised tool set — is constant for the process lifetime.
// Advertising only the permitted tools means the client's wildcard
// `--allowedTools mcp__mnemo-graph__*` resolves to exactly this actor's surface;
// handleToolCall enforces the same list as defence-in-depth on CallTool.
const MCP_ACTOR = resolveActorFromEnv();
const ALLOWED_TOOLS = allowlistFor(MCP_ACTOR);

const server = new Server(
  {
    name: 'mnemo-graph',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: GRAPH_TOOLS.filter(t => ALLOWED_TOOLS.has(t.name)).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object' as const,
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  })),
}));

// Execute tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: 'text' as const, text: result }],
    };
  } catch (error) {
    // P2 (doc 38): map known SQLSTATEs to an actionable message so the agent
    // can recover (re-resolve / skip / retry) under optimistic concurrency.
    return {
      content: [{ type: 'text' as const, text: toActionableMcpError(error) }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mnemo Graph MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Graph MCP Server failed to start:', err);
  process.exit(1);
});
