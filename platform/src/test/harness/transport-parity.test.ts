/**
 * Transport Parity Contract Test — bead nmemo-2yv.134
 *
 * Both LLM transports (`pi-agent-bridge.ts`, `graph-mcp.ts`) implement the
 * same agentic flow. Equivalence between them must be enforced by a test,
 * not by individual reviewers noticing divergence in PRs.
 *
 * Asserts four parity contracts:
 *
 *   1. **Tool surface equivalence.** Both transports expose the same set of
 *      tool names; each tool's `inputSchema.required` list matches across
 *      transports.
 *   2. **Tool count matches `GRAPH_TOOLS`.** Both transports' tool-list
 *      length === `GRAPH_TOOLS.length`. Anti-drift: a tool that fails to
 *      register in either transport fails this.
 *   3. **Write-serialization parity.** Two concurrent `create_fact` calls
 *      against each transport produce distinct rows that both persist
 *      (the shared `writeQueue` in `handleToolCall` serializes them
 *      regardless of transport — post-bead nmemo-2yv.127).
 *   4. **Unknown-tool error envelope.** Issuing `tools/call` (or its Pi
 *      equivalent at `POST /tools/call`) with a bogus name returns the
 *      same `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }`
 *      envelope on each transport.
 *
 * Scope guards:
 *   - ZAI excluded (no existing platform audit; documented in doc 30 §"Parity
 *     contract" as a gap to be addressed by a follow-up bead).
 *   - No full agentic-flow LLM invocation here. Pi side uses the direct-dispatch
 *     `POST /tools/call` debug endpoint (bead .134) which mirrors MCP's
 *     `tools/call` envelope shape; MCP side spawns `graph-mcp.ts` per-test as
 *     `causal-integration.test.ts` does.
 *
 * Falsifying check: comment out one `GRAPH_TOOLS` entry's registration in
 * `pi-agent-bridge.ts:buildPiTools` and the surface-equivalence assertion
 * fails with the missing tool name in its message. Comment out the unknown-
 * tool catch in either transport and the error-envelope assertion fails.
 *
 * Requires:
 *   - PostgreSQL (test DB) for the write-serialization case.
 *   - Pi bridge running on `PI_BRIDGE_URL` (default http://localhost:3099).
 *     Skipped via `describe.skipIf(!bridgeAvailable)` when the bridge is down,
 *     matching the gating already used in `pi-agent-bridge.test.ts`.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  GRAPH_TOOLS,
  getGraphMcpScriptPath,
  getMcpEnv,
} from '../../services/causal-agent.js';
import { testDb, createTestEntity } from '../setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRIDGE_URL = process.env.PI_BRIDGE_URL || 'http://localhost:3099';

/**
 * Bridge-availability probe — mirrors `pi-agent-bridge.test.ts:195-202`. If
 * the bridge is not reachable, the contract test cannot exercise the Pi side;
 * the test is skipped with `describe.skipIf` rather than failing, matching the
 * project's existing convention for integration tests gated on infra.
 */
const bridgeAvailable = await (async () => {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
})();

// ============================================
// MCP JSON-RPC client — minimal inline driver
// ============================================

interface McpToolListEntry {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

interface McpToolsCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  rpcError?: unknown;
}

/**
 * Spawn `graph-mcp.ts`, complete `initialize`, then send the requested
 * follow-up request (`tools/list` or `tools/call`). Returns the parsed
 * response and kills the subprocess. Adapted from the existing pattern in
 * `causal-integration.test.ts`; sharing the script-path + env resolvers
 * keeps the test contract aligned with production.
 */
async function mcpRequest(
  followUp: { method: 'tools/list'; params?: Record<string, unknown> }
    | { method: 'tools/call'; params: { name: string; arguments: Record<string, unknown> } },
  timeoutMs = 15_000,
): Promise<unknown> {
  const platformRoot = path.resolve(__dirname, '..', '..', '..');
  const serverScript = getGraphMcpScriptPath();

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', serverScript], {
      cwd: platformRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: getMcpEnv('graph_agent'),
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let followUpSent = false;

    const finish = (value: unknown) => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      resolve(value);
    };

    const fail = (err: Error) => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`MCP request timed out (${followUp.method}). stderr: ${stderr}`)),
      timeoutMs,
    );

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result && !followUpSent) {
            followUpSent = true;
            proc.stdin.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: followUp.method,
                params: followUp.params ?? {},
              }) + '\n',
            );
          }
          if (msg.id === 2) {
            clearTimeout(timer);
            if (msg.result !== undefined) {
              finish(msg.result);
            } else {
              finish({ rpcError: msg.error });
            }
          }
        } catch {
          // Partial JSON — keep accumulating.
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => fail(new Error(`Failed to spawn graph-mcp.ts: ${err.message}`)));
    proc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        fail(new Error(`graph-mcp.ts exited with code ${code} before responding. stderr: ${stderr}`));
      }
    });

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'transport-parity-test', version: '1.0.0' },
        },
      }) + '\n',
    );
  });
}

async function mcpToolsList(): Promise<McpToolListEntry[]> {
  const result = (await mcpRequest({ method: 'tools/list' })) as { tools?: McpToolListEntry[] };
  if (!result.tools) {
    throw new Error(`MCP tools/list returned no tools field. result=${JSON.stringify(result)}`);
  }
  return result.tools;
}

async function mcpToolsCall(name: string, args: Record<string, unknown>): Promise<McpToolsCallResult> {
  const result = (await mcpRequest({
    method: 'tools/call',
    params: { name, arguments: args },
  })) as McpToolsCallResult;
  return result;
}

// ============================================
// Pi bridge HTTP client
// ============================================

interface PiToolsList {
  tools: McpToolListEntry[];
  count: number;
}

async function piToolsList(): Promise<PiToolsList> {
  const res = await fetch(`${BRIDGE_URL}/tools`);
  if (!res.ok) throw new Error(`Pi /tools returned ${res.status}`);
  return (await res.json()) as PiToolsList;
}

async function piToolsCall(name: string, args: Record<string, unknown>): Promise<McpToolsCallResult> {
  const res = await fetch(`${BRIDGE_URL}/tools/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  if (!res.ok) throw new Error(`Pi /tools/call returned ${res.status}`);
  return (await res.json()) as McpToolsCallResult;
}

// ============================================
// Parity assertions
// ============================================

describe.skipIf(!bridgeAvailable)('Transport parity contract — Pi bridge ↔ MCP server (bead .134)', () => {
  describe('Case 1 + 2: tools/list surface equivalence', () => {
    it('both transports expose the same tool name set and count matches GRAPH_TOOLS', async () => {
      const piList = await piToolsList();
      const mcpList = await mcpToolsList();

      const piNames = new Set(piList.tools.map((t) => t.name));
      const mcpNames = new Set(mcpList.map((t) => t.name));
      const expectedNames = new Set(GRAPH_TOOLS.map((t) => t.name));

      // Case 2: count matches GRAPH_TOOLS on both transports.
      expect(piList.tools).toHaveLength(GRAPH_TOOLS.length);
      expect(mcpList).toHaveLength(GRAPH_TOOLS.length);
      expect(piList.count).toBe(GRAPH_TOOLS.length);

      // Case 1: name-set equivalence.
      expect(piNames).toEqual(expectedNames);
      expect(mcpNames).toEqual(expectedNames);
      expect(piNames).toEqual(mcpNames);

      // Diagnostic on diff — surfaces missing tools by name if the symmetric
      // expectations above ever fail, so a regressing edit (e.g. dropping a
      // `GRAPH_TOOLS` registration in one transport) names the offender
      // rather than dumping two giant sets.
      const onlyInPi = [...piNames].filter((n) => !mcpNames.has(n));
      const onlyInMcp = [...mcpNames].filter((n) => !piNames.has(n));
      expect(onlyInPi, `Tools only on Pi: ${onlyInPi.join(', ')}`).toEqual([]);
      expect(onlyInMcp, `Tools only on MCP: ${onlyInMcp.join(', ')}`).toEqual([]);
    }, 30_000);

    it('inputSchema.required is identical for every tool across transports', async () => {
      const piList = await piToolsList();
      const mcpList = await mcpToolsList();

      const piByName = new Map(piList.tools.map((t) => [t.name, t]));
      const mcpByName = new Map(mcpList.map((t) => [t.name, t]));

      // Walk GRAPH_TOOLS as the canonical reference; every entry MUST exist
      // in both maps (case 1 already asserts that; this loop adds the
      // per-tool inputSchema.required assertion).
      for (const tool of GRAPH_TOOLS) {
        const piTool = piByName.get(tool.name);
        const mcpTool = mcpByName.get(tool.name);
        expect(piTool, `Pi missing tool ${tool.name}`).toBeDefined();
        expect(mcpTool, `MCP missing tool ${tool.name}`).toBeDefined();

        const piRequired = piTool!.inputSchema?.required ?? [];
        const mcpRequired = mcpTool!.inputSchema?.required ?? [];
        const canonicalRequired = tool.inputSchema.required;

        // Sort before comparing — JSON Schema doesn't ordain a stable order
        // for `required`, so a transport that re-orders it is still valid.
        expect([...piRequired].sort(), `Pi required mismatch for ${tool.name}`).toEqual(
          [...canonicalRequired].sort(),
        );
        expect([...mcpRequired].sort(), `MCP required mismatch for ${tool.name}`).toEqual(
          [...canonicalRequired].sort(),
        );
      }
    }, 30_000);
  });

  describe('Case 3: write-serialization parity (depends on .127)', () => {
    it('two concurrent create_fact calls against the Pi bridge both persist', async () => {
      const subj = await createTestEntity({ canonicalName: 'ParityPiWriteSubj', entityType: 'person' });
      const obj1 = await createTestEntity({ canonicalName: 'ParityPiWriteObj1', entityType: 'location' });
      const obj2 = await createTestEntity({ canonicalName: 'ParityPiWriteObj2', entityType: 'location' });

      // Promise.all over two Pi /tools/call invocations: the bridge's
      // /tools/call -> handleToolCall path runs through the same writeQueue
      // as the MCP path (bead .127 — write serialisation moved into the
      // dispatcher), so both rows must persist.
      const [r1, r2] = await Promise.all([
        piToolsCall('create_fact', {
          subject_entity_id: subj.id,
          predicate: 'visited',
          object_entity_id: obj1.id,
          confidence: 0.9,
        }),
        piToolsCall('create_fact', {
          subject_entity_id: subj.id,
          predicate: 'visited',
          object_entity_id: obj2.id,
          confidence: 0.9,
        }),
      ]);

      // The Pi /tools/call envelope wraps the underlying handleToolCall
      // result in `content[0].text`. Parse that to extract factId.
      expect(r1.isError, `Pi r1 unexpectedly errored: ${r1.content?.[0]?.text}`).toBeFalsy();
      expect(r2.isError, `Pi r2 unexpectedly errored: ${r2.content?.[0]?.text}`).toBeFalsy();
      const p1 = JSON.parse(r1.content![0]!.text);
      const p2 = JSON.parse(r2.content![0]!.text);
      expect(p1.factId).toBeDefined();
      expect(p2.factId).toBeDefined();
      expect(p1.factId).not.toBe(p2.factId);

      const rows = await testDb<{ id: string }[]>`
        SELECT id FROM public.facts WHERE id IN (${p1.factId}::uuid, ${p2.factId}::uuid)
      `;
      expect(rows.length).toBe(2);

      // Cleanup
      await testDb.unsafe(`DELETE FROM facts WHERE subject_entity_id = '${subj.id}'`).catch(() => {});
      await testDb
        .unsafe(`DELETE FROM entities WHERE id IN ('${subj.id}', '${obj1.id}', '${obj2.id}')`)
        .catch(() => {});
    }, 30_000);

    // The MCP-side mirror of case 3 lives in `causal-mcp.test.ts` (bead .127)
    // — `handleToolCall` is the shared dispatcher, and the writeQueue is a
    // module-scoped singleton. Asserting it here too would re-prove the
    // dispatcher's own contract via two paths; the value lives in the Pi
    // side (above) confirming the transport routes through the same queue.
  });

  describe('Case 4: unknown-tool error envelope parity', () => {
    it('both transports return the {isError, content:[{type:text,text:"Error: ..."}]} envelope', async () => {
      // Run both calls in parallel — they're independent.
      const [piResult, mcpResult] = await Promise.all([
        piToolsCall('__bogus_tool_name__', {}),
        mcpToolsCall('__bogus_tool_name__', {}),
      ]);

      // Same envelope shape on both sides.
      expect(piResult.isError, `Pi did not return isError for unknown tool`).toBe(true);
      expect(mcpResult.isError, `MCP did not return isError for unknown tool`).toBe(true);

      expect(piResult.content).toBeDefined();
      expect(mcpResult.content).toBeDefined();
      expect(piResult.content!.length).toBeGreaterThan(0);
      expect(mcpResult.content!.length).toBeGreaterThan(0);

      // First content block: type=text, text starts with 'Error:'.
      expect(piResult.content![0]!.type).toBe('text');
      expect(mcpResult.content![0]!.type).toBe('text');
      expect(piResult.content![0]!.text).toMatch(/^Error:/);
      expect(mcpResult.content![0]!.text).toMatch(/^Error:/);
    }, 30_000);
  });
});
