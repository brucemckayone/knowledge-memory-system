/**
 * Bead nmemo-2yv.126 — checkGraphMcpHealth probe behaviour.
 *
 * Tests verify the JSON-RPC three-message sequence (initialize, tools/list,
 * tools/call get_graph_topology) and that the env passed to the spawned
 * subprocess matches what production MCP configs pass. Subprocess mocked at
 * the child_process spawn boundary so the tests don't depend on a live
 * Postgres / graph-mcp.ts script.
 *
 * Why a separate file: existing causal-mcp.test.ts and causal-integration.test.ts
 * spawn the REAL subprocess. Mocking `node:child_process` is module-level
 * and would change the behaviour of those existing tests if applied in the
 * same file. Keep the mock-scope to this file.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the spawn export from node:child_process BEFORE importing the module
// under test. Vitest hoists vi.mock to the top of the file.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Import AFTER the mock is registered.
import { checkGraphMcpHealth, getMcpEnv } from '../../services/causal-agent.js';

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function createFakeProc(): { proc: FakeProc; written: string[] } {
  const written: string[] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = {
    write: vi.fn((msg: string) => {
      written.push(msg);
      return true;
    }),
  };
  proc.kill = vi.fn();
  return { proc, written };
}

const emit = (proc: FakeProc, msg: object) =>
  proc.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));

describe('B.graph-mcp-health: probe behaviour (nmemo-2yv.126)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('happy path — sends initialize + tools/list + tools/call get_graph_topology, returns ok=true', async () => {
    const { proc, written } = createFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = checkGraphMcpHealth(5_000);

    // Drive responses in order. Microtask boundaries let the probe's
    // stdout handler observe each line + send the next request.
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_graph_topology' }, { name: 'create_fact' }] } });
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{ ... topology snapshot ... }' }] } });

    const result = await promise;

    // All three messages sent in order.
    expect(written.length).toBe(3);
    const requests = written.map(m => JSON.parse(m.trim()));
    expect(requests[0]!.method).toBe('initialize');
    expect(requests[0]!.id).toBe(1);
    expect(requests[1]!.method).toBe('tools/list');
    expect(requests[1]!.id).toBe(2);
    expect(requests[2]!.method).toBe('tools/call');
    expect(requests[2]!.id).toBe(3);
    expect(requests[2]!.params.name).toBe('get_graph_topology');
    expect(requests[2]!.params.arguments).toEqual({});

    // Result shape.
    expect(result.ok).toBe(true);
    expect(result.topologyOk).toBe(true);
    expect(result.tools).toContain('get_graph_topology');
    expect(result.tools).toContain('create_fact');
    expect(result.error).toBeUndefined();
  });

  it('passes env: getMcpEnv("graph_agent") to spawn — production parity', async () => {
    const { proc } = createFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = checkGraphMcpHealth(5_000);
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 1, result: {} });
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 2, result: { tools: [] } });
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 3, result: {} });
    await promise;

    // Inspect the spawn call — second arg is args array, third is options.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const options = spawnMock.mock.calls[0]![2] as { env?: Record<string, string> };
    expect(options.env).toBeDefined();
    expect(options.env!.MNEMO_AGENT_ACTOR).toBe('graph_agent');
    // Same shape as getMcpEnv produces — single source of truth check.
    const expected = getMcpEnv('graph_agent');
    expect(options.env).toEqual(expected);
  });

  it('JSON-RPC error on tools/call flips topologyOk and ok to false', async () => {
    const { proc } = createFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = checkGraphMcpHealth(5_000);
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 1, result: {} });
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_graph_topology' }] } });
    await Promise.resolve();
    // JSON-RPC error envelope — method not found at protocol level.
    emit(proc, { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not found' } });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.topologyOk).toBe(false);
    expect(result.tools).toContain('get_graph_topology');
    expect(result.error).toContain('Method not found');
  });

  it('tool-level error envelope (result.isError) still counts as topologyOk=true — MCP→DB path worked', async () => {
    const { proc } = createFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = checkGraphMcpHealth(5_000);
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 1, result: {} });
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_graph_topology' }] } });
    await Promise.resolve();
    // The tool ran but errored at app level — content carries the error msg.
    // This is the MCP idiom: `result.isError=true` instead of JSON-RPC `error`.
    emit(proc, {
      jsonrpc: '2.0',
      id: 3,
      result: { isError: true, content: [{ type: 'text', text: 'graph empty' }] },
    });

    const result = await promise;
    // Tool returned a structured response → topologyOk=true → ok=true.
    expect(result.ok).toBe(true);
    expect(result.topologyOk).toBe(true);
  });

  it('subprocess exits before id=3 arrives → ok=false with the exit-code error', async () => {
    const { proc } = createFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = checkGraphMcpHealth(5_000);
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 1, result: {} });
    await Promise.resolve();
    emit(proc, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_graph_topology' }] } });
    await Promise.resolve();
    // The subprocess dies before responding to id=3 (e.g. DB unreachable
    // and the handler threw, taking the process down).
    proc.stderr.emit('data', Buffer.from('ECONNREFUSED 127.0.0.1:5433\n'));
    proc.emit('exit', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited with code 1');
    expect(result.error).toContain('ECONNREFUSED');
    // tools were observed before the crash, so the result still carries them.
    expect(result.tools).toContain('get_graph_topology');
  });
});

describe('B.graph-mcp-health: getMcpEnv shared builder (nmemo-2yv.126)', () => {
  it('sets MNEMO_AGENT_ACTOR to the supplied actor', () => {
    expect(getMcpEnv('graph_agent').MNEMO_AGENT_ACTOR).toBe('graph_agent');
    expect(getMcpEnv('user').MNEMO_AGENT_ACTOR).toBe('user');
    expect(getMcpEnv('reconciliation_agent').MNEMO_AGENT_ACTOR).toBe('reconciliation_agent');
  });

  it('includes the documented env-var allowlist when process.env has them', () => {
    const orig = { ...process.env };
    try {
      process.env.DATABASE_URL = 'postgres://localhost:5433/test';
      process.env.QDRANT_URL = 'http://localhost:6335';
      process.env.ML_SERVICES_URL = 'http://localhost:8000';
      process.env.EMBED_MODEL = 'nomic-embed-text';
      process.env.NODE_ENV = 'test';
      const env = getMcpEnv('graph_agent');
      expect(env.DATABASE_URL).toBe('postgres://localhost:5433/test');
      expect(env.QDRANT_URL).toBe('http://localhost:6335');
      expect(env.ML_SERVICES_URL).toBe('http://localhost:8000');
      expect(env.EMBED_MODEL).toBe('nomic-embed-text');
      expect(env.NODE_ENV).toBe('test');
    } finally {
      // Restore env exactly
      for (const k of Object.keys(process.env)) {
        if (!(k in orig)) delete process.env[k];
      }
      for (const k of Object.keys(orig)) {
        process.env[k] = orig[k];
      }
    }
  });
});
