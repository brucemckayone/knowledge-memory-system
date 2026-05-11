/**
 * Mnemo MCP Server (W41)
 *
 * Model Context Protocol server that exposes Mnemo's knowledge base
 * to Claude Code and other MCP-compatible clients.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MnemoClient } from './mnemo-client.js';
import { tools } from './tools.js';
import { resources } from './resources.js';

const MNEMO_URL = process.env.MNEMO_URL || 'http://localhost:3001';
const MNEMO_API_KEY = process.env.MNEMO_API_KEY;

const client = new MnemoClient({
  baseUrl: MNEMO_URL,
  apiKey: MNEMO_API_KEY,
});

const server = new Server(
  {
    name: 'mnemo',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  })),
}));

// Execute tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(request.params.arguments, client);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error}` }],
      isError: true,
    };
  }
});

// List resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: resources.map(r => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  })),
}));

// Read resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resource = resources.find(r => r.uri === request.params.uri);
  if (!resource) {
    throw new Error(`Unknown resource: ${request.params.uri}`);
  }

  const content = await resource.handler(client);
  return {
    contents: [{
      uri: resource.uri,
      mimeType: resource.mimeType,
      text: content,
    }],
  };
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mnemo MCP Server running on stdio');
}

main().catch(console.error);
