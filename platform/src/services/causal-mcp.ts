#!/usr/bin/env node
/**
 * Causal MCP Server (B06)
 *
 * Standalone MCP server exposing the 7 causal reasoning tools via stdio.
 * Claude Code spawns this as a subprocess and connects via --mcp-config.
 *
 * Usage: npx tsx src/services/causal-mcp.ts
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
// GRAPH_TOOLS is the unified tool surface (B05 causal tools + extraction +
// reconciliation + gardener + reasoning-layer tools). CAUSAL_AGENT_TOOLS is
// the deprecated empty-list kept for backwards-compatible imports.
import { GRAPH_TOOLS, handleToolCall } from './causal-agent.js';

const server = new Server(
  {
    name: 'mnemo-causal',
    version: '1.0.0',
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
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is reserved for MCP protocol)
  console.error('Mnemo Causal MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Causal MCP Server failed to start:', err);
  process.exit(1);
});
