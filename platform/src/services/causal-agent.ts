/**
 * Causal Agent — Tool Definitions (B05) + Invocation (B06)
 *
 * 7 tools for the causal reasoning agent, exposed via MCP server (causal-mcp.ts).
 * Each tool maps to an existing service function. The tool schema format
 * is MCP-compatible (JSON Schema inputSchema).
 *
 * The invokeCausalAgent() function calls the ML service's /causal-reason endpoint,
 * which shells out to Claude Code with the MCP config and system prompt.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { getEntityFacts } from './facts.js';
import { findConnectedEntities } from './graph.js';
import { findSimilarEntities } from './entities.js';
import { searchMemories, getMemory } from './qdrant.js';
import { getEntityCausalHistory, createCausalEdge } from './causal.js';
import { ml } from './ml-client.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// Tool Schemas (MCP-compatible)
// ============================================

/** MCP tool schema — compatible with @modelcontextprotocol/sdk Tool type */
export interface CausalToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const CAUSAL_AGENT_TOOLS: CausalToolDefinition[] = [
  {
    name: 'query_entity_facts',
    description:
      'Get all active bi-temporal facts for a given entity. Returns facts where the entity is the subject.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to query facts for',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'query_entity_neighbours',
    description:
      'Traverse the knowledge graph to find entities connected to a given entity, optionally filtered by relationship type and depth.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to find neighbours for',
        },
        relationship_type: {
          type: 'string',
          description: 'Optional relationship type filter (e.g. "works_at", "knows")',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 1)',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'search_similar_entities',
    description:
      'Semantic similarity search over all entities using pgvector. Find entities whose names/descriptions are semantically close to a query text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for semantically similar entities',
        },
        threshold: {
          type: 'number',
          description: 'Minimum similarity threshold 0.0-1.0 (default: 0.5)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
        entity_type: {
          type: 'string',
          description: 'Optional entity type filter (e.g. "person", "organization")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_memories',
    description:
      'Semantic search over source texts in the vector store. Find past inputs that are semantically related to a query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for semantically similar memories',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_memory_text',
    description:
      'Retrieve the full source text of a specific memory by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: {
          type: 'string',
          description: 'UUID of the memory to retrieve',
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'get_causal_history',
    description:
      'Get existing causal chains involving a given entity. Returns causal events and edges from Graph C with reasoning, strength, and source references.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: {
          type: 'string',
          description: 'UUID of the entity to get causal history for',
        },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'create_causal_edge',
    description:
      'Assert a causal link between two causal events with detailed reasoning and source references. Every edge must be auditable — provide thorough reasoning and list all sources that informed the conclusion.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cause_event_id: {
          type: 'string',
          description: 'UUID of the causal event that is the cause',
        },
        effect_event_id: {
          type: 'string',
          description: 'UUID of the causal event that is the effect',
        },
        strength: {
          type: 'number',
          description: 'Confidence in the causal link, 0.0-1.0. Use 0.3-0.6 for inferred causality, 0.7-1.0 for explicitly stated.',
        },
        reasoning: {
          type: 'string',
          description: 'Detailed justification for this causal assertion. Must explain WHY the cause led to the effect.',
        },
        source_references: {
          type: 'array',
          description: 'Every source that informed this conclusion',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['memory', 'fact', 'entity'],
                description: 'Type of source reference',
              },
              id: {
                type: 'string',
                description: 'UUID of the memory, fact, or entity',
              },
              relevance: {
                type: 'string',
                description: 'How this source informed the causal conclusion',
              },
            },
            required: ['type', 'id', 'relevance'],
          },
        },
        temporal_span: {
          type: 'string',
          description: 'Optional estimated delay between cause and effect (ISO 8601 duration, e.g. "P7D" for 7 days)',
        },
      },
      required: ['cause_event_id', 'effect_event_id', 'strength', 'reasoning', 'source_references'],
    },
  },
];

// ============================================
// Tool Handlers
// ============================================

/**
 * Dispatch a tool call from the Haiku agent to the appropriate service function.
 * Returns a string result suitable for the Anthropic tool_result content block.
 */
export async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  switch (toolName) {
    case 'query_entity_facts': {
      const facts = await getEntityFacts(toolInput.entity_id as string);
      return JSON.stringify(facts.map(f => ({
        id: f.id,
        subjectEntityId: f.subjectEntityId,
        predicate: f.predicate,
        objectEntityId: f.objectEntityId,
        objectValue: f.objectValue,
        confidence: f.confidence,
        validAt: f.validAt,
        invalidAt: f.invalidAt,
        sourceText: f.sourceText,
      })));
    }

    case 'query_entity_neighbours': {
      const neighbours = await findConnectedEntities(
        toolInput.entity_id as string,
        {
          relationshipType: toolInput.relationship_type as string | undefined,
          maxDepth: toolInput.max_depth as number | undefined,
        },
      );
      return JSON.stringify(neighbours);
    }

    case 'search_similar_entities': {
      const embedResult = await ml.embed(toolInput.query as string);
      const similar = await findSimilarEntities(embedResult.vector, {
        threshold: (toolInput.threshold as number) ?? 0.5,
        limit: (toolInput.limit as number) ?? 10,
        type: toolInput.entity_type as string | undefined,
      });
      return JSON.stringify(similar.map(e => ({
        id: e.id,
        canonicalName: e.canonicalName,
        entityType: e.entityType,
        similarity: e.similarity,
      })));
    }

    case 'search_memories': {
      const embedResult = await ml.embed(toolInput.query as string);
      const memories = await searchMemories(embedResult.vector, {
        limit: (toolInput.limit as number) ?? 5,
      });
      return JSON.stringify(memories.map((m: any) => ({
        id: m.id,
        score: m.score,
        content: m.payload?.content,
        metadata: m.payload?.metadata,
        createdAt: m.payload?.created_at,
      })));
    }

    case 'get_memory_text': {
      const memory = await getMemory(toolInput.memory_id as string);
      if (!memory) {
        return JSON.stringify({ error: 'Memory not found' });
      }
      return JSON.stringify({
        id: memory.id,
        content: (memory.payload as any)?.content,
        metadata: (memory.payload as any)?.metadata,
        createdAt: (memory.payload as any)?.created_at,
      });
    }

    case 'get_causal_history': {
      const history = await getEntityCausalHistory(toolInput.entity_id as string);
      return JSON.stringify({
        events: history.events.map(e => ({
          id: e.id,
          factId: e.factId,
          transitionType: e.transitionType,
          subjectEntityId: e.subjectEntityId,
          predicate: e.predicate,
          deltaConfidence: e.deltaConfidence,
          occurredAt: e.occurredAt,
          sourceText: e.sourceText,
        })),
        edges: history.edges.map(e => ({
          id: e.id,
          causeEventId: e.causeEventId,
          effectEventId: e.effectEventId,
          strength: e.strength,
          reasoning: e.reasoning,
          sourceReferences: e.sourceReferences,
          extractionMethod: e.extractionMethod,
        })),
      });
    }

    case 'create_causal_edge': {
      const refs = toolInput.source_references as Array<{
        type: 'memory' | 'fact' | 'entity';
        id: string;
        relevance: string;
      }>;
      const edgeId = await createCausalEdge({
        causeEventId: toolInput.cause_event_id as string,
        effectEventId: toolInput.effect_event_id as string,
        strength: toolInput.strength as number,
        reasoning: toolInput.reasoning as string,
        sourceReferences: refs,
        temporalSpan: toolInput.temporal_span as string | undefined,
      });
      return JSON.stringify({ edgeId });
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ============================================
// Agent Invocation (B06)
// ============================================

export interface CausalDelta {
  sourceText: string;
  memoryId?: string;
  newEntities: Array<Record<string, unknown>>;
  newFacts: Array<Record<string, unknown>>;
  modifiedFacts: Array<Record<string, unknown>>;
  causalEvents: Array<{
    id: string;
    factId?: string;
    transitionType: string;
    subjectEntityId?: string;
    predicate?: string;
    sourceText?: string;
  }>;
}

export interface CausalAgentResult {
  result: string;
  cost?: Record<string, unknown>;
}

/**
 * Generate a temporary MCP config JSON with resolved absolute paths.
 * Claude Code reads this file to know how to spawn the causal MCP server.
 */
export function getMcpConfigPath(): string {
  const platformRoot = path.resolve(__dirname, '..', '..');
  const configPath = path.resolve(platformRoot, '.causal-mcp-config.json');

  // Write config with resolved paths (idempotent)
  const fs = require('fs') as typeof import('fs');
  // Use absolute path to the MCP server script — Claude Code does not
  // respect the cwd field when spawning MCP servers, so the script path
  // must be resolvable from any working directory.
  const serverScript = path.resolve(platformRoot, 'src', 'services', 'causal-mcp.ts');

  // The MCP server process inherits a minimal env from Claude Code.
  // Pass through the required env vars so config.ts validation passes.
  // Prefer process.env (set by test setup or runtime) over .env file.
  const dotenv = require('dotenv') as typeof import('dotenv');
  const envFile = dotenv.config({ path: path.resolve(platformRoot, '.env') });
  const env: Record<string, string> = {};
  for (const key of ['DATABASE_URL', 'QDRANT_URL', 'ML_SERVICES_URL', 'EMBED_MODEL', 'NODE_ENV']) {
    const val = process.env[key] || envFile.parsed?.[key];
    if (val) env[key] = val;
  }

  const mcpConfig = {
    mcpServers: {
      'mnemo-causal': {
        command: 'npx',
        args: ['tsx', serverScript],
        cwd: platformRoot,
        env,
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return configPath;
}

/**
 * Invoke the causal reasoning agent via the ML service.
 *
 * The ML service calls Claude Code with:
 * - The causal system prompt
 * - MCP config pointing to the causal-mcp.ts server
 * - max_turns=20 for agentic tool-use loop
 *
 * Claude Code spawns the MCP server, uses the tools to query Graph S/C
 * and Qdrant, then asserts causal edges via create_causal_edge.
 */
export async function invokeCausalAgent(delta: CausalDelta): Promise<CausalAgentResult> {
  const mcpConfigPath = getMcpConfigPath();

  const response = await fetch(`${config.ML_SERVICES_URL}/causal-reason`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_text: delta.sourceText,
      memory_id: delta.memoryId,
      new_entities: delta.newEntities,
      new_facts: delta.newFacts,
      modified_facts: delta.modifiedFacts,
      causal_events: delta.causalEvents.map(e => ({
        id: e.id,
        fact_id: e.factId,
        transition_type: e.transitionType,
        subject_entity_id: e.subjectEntityId,
        predicate: e.predicate,
        source_text: e.sourceText,
      })),
      mcp_config_path: mcpConfigPath,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Causal reasoning failed (${response.status}): ${detail}`);
  }

  return response.json() as Promise<CausalAgentResult>;
}

// ============================================
// MCP Health Check
// ============================================

export interface McpHealthResult {
  ok: boolean;
  tools?: string[];
  error?: string;
  durationMs: number;
}

/**
 * Spawn the causal MCP server and verify it responds to a tools/list request.
 * Uses the raw JSON-RPC protocol over stdio (no SDK client needed).
 */
export async function checkCausalMcpHealth(timeoutMs = 15_000): Promise<McpHealthResult> {
  const start = Date.now();
  const platformRoot = path.resolve(__dirname, '..', '..');

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', 'src/services/causal-mcp.ts'], {
      cwd: platformRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const finish = (result: McpHealthResult) => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'MCP server timed out', durationMs: Date.now() - start });
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();

      // Look for tools/list response
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Response to initialize
          if (msg.id === 1 && msg.result) {
            // Send tools/list
            const toolsReq = JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/list',
              params: {},
            });
            proc.stdin.write(toolsReq + '\n');
          }
          // Response to tools/list
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            const tools = msg.result.tools.map((t: { name: string }) => t.name);
            finish({ ok: true, tools, durationMs: Date.now() - start });
          }
        } catch {
          // Not JSON yet, keep accumulating
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `Failed to spawn: ${err.message}`, durationMs: Date.now() - start });
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (!resolved) {
        finish({ ok: false, error: `Server exited with code ${code}: ${stderr}`, durationMs: Date.now() - start });
      }
    });

    // Send MCP initialize request
    const initReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'health-check', version: '1.0.0' },
      },
    });
    proc.stdin.write(initReq + '\n');
  });
}
