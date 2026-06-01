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
import { GRAPH_TOOLS, handleToolCall } from './causal-agent.js';
import { toActionableMcpError } from './mcp-errors.js';

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
  tools: GRAPH_TOOLS.map(t => ({
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
