#!/usr/bin/env node
/**
 * Pi Agent Bridge — SDK-based LLM agent service
 *
 * Replaces the Claude Code subprocess + MCP server pattern.
 * Uses the Pi SDK (createAgentSession + defineTool) to run agentic
 * tool-use loops entirely in-process — no MCP, no subprocess per invocation.
 *
 * The graph tools from causal-agent.ts (GRAPH_TOOLS + handleToolCall)
 * are registered as Pi custom tools via defineTool(). The agent gets
 * a per-invocation system prompt and runs until it stops or times out.
 *
 * Usage: npx tsx src/services/pi-agent-bridge.ts
 *   Listens on port 3099 (configurable via PI_BRIDGE_PORT env var).
 *   3099 avoids the 3001 collision with the platform server (.env PORT=3001).
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  createAgentSession,
  defineTool,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  createExtensionRuntime,
  type AgentSession,
  type ResourceLoader,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { GRAPH_TOOLS, handleToolCall, type ToolCallContext } from './causal-agent.js';

// ============================================
// Config
// ============================================

const PORT = parseInt(process.env.PI_BRIDGE_PORT || '3099', 10);
const REQUEST_TIMEOUT_MS = 10_000; // time to wait for bridge startup

// ============================================
// Tool Conversion: GRAPH_TOOLS → Pi defineTool
// ============================================

/**
 * Convert a GRAPH_TOOLS JSON Schema inputSchema to a TypeBox schema.
 *
 * GRAPH_TOOLS schemas are standard JSON Schema objects:
 *   { type: "object", properties: {...}, required: [...] }
 *
 * TypeBox's Type.Unsafe() accepts any raw JSON Schema and produces
 * a valid TSchema that Pi's tool validation can use.
 */
function jsonSchemaToTypeBox(schema: Record<string, unknown>) {
  return Type.Unsafe(schema);
}

/**
 * Build Pi custom tools from GRAPH_TOOLS definitions.
 * Each tool delegates to handleToolCall() from causal-agent.ts.
 */
function buildPiTools(actor: string) {
  return GRAPH_TOOLS.map((toolDef) =>
    defineTool({
      name: toolDef.name,
      label: toolDef.name,
      description: toolDef.description,
      parameters: jsonSchemaToTypeBox(toolDef.inputSchema as Record<string, unknown>),
      // Bead nmemo-2yv.127: write-tool serialisation moved into the shared
      // `handleToolCall` dispatcher so BOTH transports (Pi + MCP) inherit it.
      // Pi's per-tool executionMode is now unconditionally 'parallel' — the
      // dispatcher's writeQueue is the single source of truth for ordering.
      executionMode: 'parallel',
      execute: async (_toolCallId, params, _signal, _onUpdate) => {
        const context: ToolCallContext = {
          agent: actor as ToolCallContext['agent'],
        };
        const result = await handleToolCall(toolDef.name, params as Record<string, unknown>, context);
        return {
          content: [{ type: 'text' as const, text: result }],
          details: {},
        };
      },
    }),
  );
}

// ============================================
// Minimal ResourceLoader — no discovery
// ============================================

function makeResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// ============================================
// Request / Response Types
// ============================================

interface BridgeRequest {
  prompt: string;
  system_prompt: string;
  /** Pi provider name (e.g. "zai", "anthropic", "google") */
  provider?: string;
  /** Model ID (e.g. "glm-5.1", "claude-sonnet-4-20250514") */
  model?: string;
  /** Pi thinking level: "off" | "minimal" | "low" | "medium" | "high" */
  thinking?: string;
  /** Agent actor for audit trail: "graph_agent" | "reasoning_agent" | etc. */
  actor?: string;
  /** Request timeout in seconds (default 300) */
  timeout?: number;
}

interface BridgeResponse {
  result: string;
  cost?: {
    input_tokens: number;
    output_tokens: number;
    cache_read?: number;
    cache_write?: number;
    total_tokens?: number;
    estimated_usd?: number;
  };
  error?: string;
  tool_calls?: number;
  turns?: number;
}

// ============================================
// Run Agent
// ============================================

async function runAgent(req: BridgeRequest): Promise<BridgeResponse> {
  const {
    prompt,
    system_prompt,
    provider = 'zai',
    model: modelId = 'glm-5.1',
    thinking = 'off',
    actor = 'graph_agent',
    timeout = 300,
  } = req;

  const tools = buildPiTools(actor);
  const resourceLoader = makeResourceLoader(system_prompt);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  let result = '';
  let cost: BridgeResponse['cost'] = {};
  let toolCallCount = 0;
  let turnCount = 0;
  let error: string | undefined;

  // Resolve model — strict-by-default. Fail fast on (provider, modelId) miss
  // rather than silently substituting a different model (which masks config
  // typos, drifts the caller's cost meter, and changes capability/latency).
  let resolvedModel;
  try {
    const available = await modelRegistry.getAvailable();
    resolvedModel = available.find(
      (m) => m.provider === provider && m.id === modelId,
    );

    if (!resolvedModel) {
      const sample = available.map((m) => `${m.provider}/${m.id}`).slice(0, 20).join(', ');
      return {
        result: '',
        error: `Model not found: provider=${provider} id=${modelId}. Available (first 20): ${sample}`,
      };
    }
  } catch (err) {
    return {
      result: '',
      error: `Model resolution failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Create session up-front so the timeout branch can abort + dispose it on hang.
  const { session } = await createAgentSession({
    model: resolvedModel,
    thinkingLevel: thinking as any,
    tools: [], // no built-in tools
    customTools: tools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
    authStorage,
    modelRegistry,
  });

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  // Timeout guard — on expiry, abort the in-flight prompt then dispose (best-effort).
  const timeoutPromise = new Promise<BridgeResponse>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      // Fire-and-forget cleanup; the caller already has its timeout response.
      void session.abort().finally(() => session.dispose());
      resolve({
        result: result || '',
        cost,
        error: `Agent timed out after ${timeout}s`,
        tool_calls: toolCallCount,
        turns: turnCount,
      });
    }, timeout * 1000);
  });

  const agentPromise = (async (): Promise<BridgeResponse> => {
    try {
      // Subscribe to events for result collection
      session.subscribe((event: AgentSessionEvent) => {
        switch (event.type) {
          case 'tool_execution_end':
            toolCallCount++;
            break;
          case 'turn_end':
            turnCount++;
            break;
          case 'agent_end': {
            const messages = event.messages || [];
            // Get last assistant message text
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i]!;
              if (msg.role === 'assistant') {
                const textParts: string[] = [];
                for (const block of (msg as any).content || []) {
                  if (block.type === 'text') {
                    textParts.push(block.text);
                  }
                }
                result = textParts.join('\n');

                // Extract usage
                const usage = (msg as any).usage;
                if (usage) {
                  cost = {
                    input_tokens: usage.input || 0,
                    output_tokens: usage.output || 0,
                    cache_read: usage.cacheRead || 0,
                    cache_write: usage.cacheWrite || 0,
                    total_tokens: usage.totalTokens || 0,
                    estimated_usd: (msg as any).cost?.total || 0,
                  };
                }
                break;
              }
            }
            break;
          }
        }
      });

      // Run the prompt
      await session.prompt(prompt);

      return {
        result,
        cost,
        tool_calls: toolCallCount,
        turns: turnCount,
      };
    } catch (err) {
      return {
        result: result || '',
        cost,
        error: err instanceof Error ? err.message : String(err),
        tool_calls: toolCallCount,
        turns: turnCount,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Gate dispose on !timedOut to avoid double-dispose (the timeout branch already disposed).
      if (!timedOut) session.dispose();
    }
  })();

  return Promise.race([agentPromise, timeoutPromise]);
}

// ============================================
// HTTP Server
// ============================================

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'pi-agent-bridge',
      tools: GRAPH_TOOLS.length,
      version: '1.0.0',
    });
    return;
  }

  // Tool listing (for debugging)
  if (req.method === 'GET' && req.url === '/tools') {
    sendJson(res, 200, {
      tools: GRAPH_TOOLS.map((t) => ({ name: t.name, description: t.description.slice(0, 80) })),
      count: GRAPH_TOOLS.length,
    });
    return;
  }

  // Run agent
  if (req.method === 'POST' && req.url === '/run') {
    try {
      const body = await readBody(req);
      const bridgeReq = JSON.parse(body) as BridgeRequest;

      if (!bridgeReq.prompt) {
        sendJson(res, 400, { error: 'Missing required field: prompt' });
        return;
      }

      console.error(`[bridge] POST /run actor=${bridgeReq.actor || 'graph_agent'} model=${bridgeReq.model || 'default'} tools=${GRAPH_TOOLS.length}`);
      const startTime = Date.now();

      const result = await runAgent(bridgeReq);

      const elapsed = Date.now() - startTime;
      console.error(`[bridge] POST /run done ${elapsed}ms turns=${result.turns || 0} tools=${result.tool_calls || 0} ${result.error ? 'ERROR: ' + result.error.slice(0, 100) : 'OK'}`);

      sendJson(res, result.error ? 500 : 200, result);
    } catch (err) {
      console.error('[bridge] POST /run error:', err);
      sendJson(res, 500, {
        result: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: 'Not found' });
});

// ============================================
// Startup assertions
// ============================================

/**
 * Bead nmemo-2yv.113: Fail fast if any tool is missing the `mutates: boolean`
 * flag. The dispatcher's writeQueue (causal-agent.ts handleToolCall) relies
 * on this flag to know which tools to serialise. A forgotten field on a new
 * write tool would otherwise silently degrade to `mutates === undefined`
 * (falsy) → run-in-parallel → DB race on the resource the tool writes.
 *
 * Better to fail at process start than to lose writes at runtime.
 */
function assertMutatesFlagsDeclared(): void {
  const missing: string[] = [];
  for (const tool of GRAPH_TOOLS) {
    if (typeof tool.mutates !== 'boolean') {
      missing.push(tool.name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Pi Agent Bridge refusing to start — ${missing.length} tool(s) missing required \`mutates: boolean\` flag: ${missing.join(', ')}`,
    );
  }
}

assertMutatesFlagsDeclared();

server.listen(PORT, () => {
  console.error(`Pi Agent Bridge running on http://localhost:${PORT}`);
  console.error(`  GET  /health  — health check`);
  console.error(`  GET  /tools   — list registered tools`);
  console.error(`  POST /run     — run agent (prompt + system_prompt → result)`);
});
