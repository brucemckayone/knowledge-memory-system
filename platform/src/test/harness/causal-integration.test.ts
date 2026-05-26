/**
 * B06 Integration: Unified graph MCP server end-to-end
 *
 * Spawns the real MCP server (graph-mcp.ts) and verifies it exposes the
 * unified GRAPH_TOOLS set through the JSON-RPC handshake. This complements
 * graph-mcp-health.test.ts (which mocks `node:child_process`) by exercising
 * the real subprocess path.
 *
 * Bead nmemo-2yv.128 extended this file with three contract assertions:
 *   - GRAPH_TOOLS total count + name-set parity (tool-count drift guard)
 *   - serverName === 'mnemo-graph' (server-identity drift guard)
 *   - tools/call '__bogus__' returns the MCP `isError: true` envelope
 *     with an 'Error:'-prefixed text payload (error-envelope drift guard)
 *
 * Requires: PostgreSQL.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  checkGraphMcpHealth,
  GRAPH_TOOLS,
  getGraphMcpScriptPath,
  getMcpEnv,
} from '../../services/causal-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('B06 Integration: graph MCP server end-to-end', () => {
  // --- MCP Health Check ---

  it('graph MCP server starts and exposes the unified tool set', async () => {
    const health = await checkGraphMcpHealth();

    expect(health.ok).toBe(true);
    expect(health.tools).toBeDefined();
    expect(health.durationMs).toBeLessThan(15_000);

    // Bead nmemo-2yv.128 — anti-drift assertions.
    // Tool-count + name-set parity: every GRAPH_TOOLS entry must be reachable
    // via MCP tools/list. Catches schema-invalid additions that prevent
    // registration, and catches drift in either direction (rogue extras too).
    expect(health.tools).toHaveLength(GRAPH_TOOLS.length);
    expect(new Set(health.tools)).toEqual(new Set(GRAPH_TOOLS.map(t => t.name)));

    // Server identity: must match the name agent allowlists use
    // (mcp__mnemo-graph__*). Catches the same drift causal-mcp.ts shipped with.
    expect(health.serverName).toBe('mnemo-graph');

    // Bead nmemo-2yv.129 — stderr surfaces the graph-mcp.ts startup banner
    // (line 65: `console.error('Mnemo Graph MCP Server running on stdio')`)
    // on the success path. Binds bead .129's manual /api/mcp-health bullet
    // to CI: a real subprocess emits the real banner, and the probe reports
    // it through McpHealthResult.stderr (asymmetry-with-error-path fix).
    expect(health.stderr).toContain('Mnemo Graph MCP Server running on stdio');
  }, 20_000);

  it('graph MCP server returns isError envelope for unknown tools', async () => {
    // Spawn graph-mcp.ts directly via the shared resolvers so this test
    // inherits the same script-path and env contract as production agents
    // and `checkGraphMcpHealth`. Inline JSON-RPC client — no probe extension.
    const platformRoot = path.resolve(__dirname, '..', '..', '..');
    const serverScript = getGraphMcpScriptPath();

    const result = await new Promise<{ isError?: boolean; content?: Array<{ type: string; text: string }>; rpcError?: unknown }>((resolve, reject) => {
      const proc = spawn('npx', ['tsx', serverScript], {
        cwd: platformRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: getMcpEnv('graph_agent'),
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;
      let callSent = false;

      const finish = (value: { isError?: boolean; content?: Array<{ type: string; text: string }>; rpcError?: unknown }) => {
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

      const timer = setTimeout(() => fail(new Error(`Timed out waiting for tools/call __bogus__ response. stderr: ${stderr}`)), 15_000);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            // Response to initialize (id=1) → send tools/call __bogus__ (id=2).
            if (msg.id === 1 && msg.result && !callSent) {
              callSent = true;
              proc.stdin.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'tools/call',
                  params: { name: '__bogus__', arguments: {} },
                }) + '\n',
              );
            }
            // Response to tools/call (id=2). Capture both possible shapes:
            //   - MCP app-level error envelope: result.isError === true
            //   - JSON-RPC protocol error: msg.error (still records, lets the
            //     assertion fail with a clear message rather than time out)
            if (msg.id === 2) {
              clearTimeout(timer);
              if (msg.result !== undefined) {
                finish({ isError: msg.result.isError, content: msg.result.content });
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

      proc.on('error', err => fail(new Error(`Failed to spawn graph-mcp.ts: ${err.message}`)));
      proc.on('exit', code => {
        if (!resolved) {
          clearTimeout(timer);
          fail(new Error(`graph-mcp.ts exited with code ${code} before responding. stderr: ${stderr}`));
        }
      });

      // Kick off the handshake.
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'bogus-tool-test', version: '1.0.0' },
          },
        }) + '\n',
      );
    });

    // graph-mcp.ts:53-58 wraps handler exceptions in the MCP app-level error
    // envelope. An unknown tool name lands in handleToolCall's default branch,
    // which throws — the catch then returns { isError: true, content: [...] }.
    expect(result.rpcError).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content).toBeDefined();
    expect(result.content!.length).toBeGreaterThan(0);
    expect(result.content![0]!.type).toBe('text');
    expect(result.content![0]!.text).toMatch(/^Error:/);
  }, 20_000);
});
