/**
 * MCP Tools (W41)
 *
 * Defines the tools available to Claude Code via the MCP protocol.
 */

import { z } from 'zod';
import type { MnemoClient } from './mnemo-client.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: unknown, client: MnemoClient) => Promise<unknown>;
}

export const tools: ToolDefinition[] = [
  {
    name: 'mnemo_search',
    description: 'Search your personal knowledge base for memories, thoughts, and saved content.',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(10).describe('Max results'),
    }),
    handler: async (input, client) => {
      const { query, limit } = input as { query: string; limit?: number };
      return client.hybridSearch(query, limit);
    },
  },
  {
    name: 'mnemo_ingest',
    description: 'Save a piece of content to your Mnemo knowledge base.',
    inputSchema: z.object({
      content: z.string().describe('Content to save'),
      contentType: z.enum(['text', 'markdown', 'link']).optional().default('text'),
      metadata: z.record(z.unknown()).optional(),
    }),
    handler: async (input, client) => {
      const { content, contentType, metadata } = input as {
        content: string;
        contentType?: string;
        metadata?: Record<string, unknown>;
      };
      return client.ingest(content, { contentType, metadata });
    },
  },
  {
    name: 'mnemo_entities',
    description: 'Search entities (people, places, concepts) in your knowledge graph.',
    inputSchema: z.object({
      query: z.string().describe('Entity name or search query'),
      limit: z.number().optional().default(10),
    }),
    handler: async (input, client) => {
      const { query, limit } = input as { query: string; limit?: number };
      return client.getEntities(query, limit);
    },
  },
  {
    name: 'mnemo_facts',
    description: 'Search facts and relationships in your knowledge graph.',
    inputSchema: z.object({
      query: z.string().describe('Fact search query'),
      limit: z.number().optional().default(10),
    }),
    handler: async (input, client) => {
      const { query, limit } = input as { query: string; limit?: number };
      return client.getFacts(query, limit);
    },
  },
  {
    name: 'mnemo_insights',
    description: 'Get AI-generated insights from your knowledge base.',
    inputSchema: z.object({
      limit: z.number().optional().default(10),
    }),
    handler: async (input, client) => {
      const { limit } = input as { limit?: number };
      return client.getInsights(limit);
    },
  },
  {
    name: 'mnemo_briefing',
    description: 'Get your latest morning briefing with task summary and insights.',
    inputSchema: z.object({}),
    handler: async (_input, client) => {
      return client.getBriefing();
    },
  },
];
