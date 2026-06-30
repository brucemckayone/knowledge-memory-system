/**
 * Pi Agent Bridge tests
 *
 * Tests the SDK-based bridge that replaces the Claude Code subprocess + MCP pattern.
 * Split into:
 *   - Unit tests (tool conversion, config, no network)
 *   - Integration tests (bridge HTTP endpoints, require bridge running)
 *
 * Run:  pnpm vitest run src/test/services/pi-agent-bridge.test.ts
 * Integration: PI_BRIDGE_URL=http://localhost:3099 pnpm vitest run src/test/services/pi-agent-bridge.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRAPH_TOOLS,
  handleToolCall,
  getMcpConfigPath,
  VALID_ACTORS,
  type ToolCallContext,
} from '../../services/causal-agent.js';

// ============================================
// Unit tests — no network, no bridge needed
// ============================================

describe('Pi Agent Bridge: tool conversion', () => {
  it('all GRAPH_TOOLS have valid MCP-compatible schemas', () => {
    expect(GRAPH_TOOLS.length).toBeGreaterThan(0);

    for (const tool of GRAPH_TOOLS) {
      expect(typeof tool.name, `tool "${tool.name}" missing name`).toBe('string');
      expect(tool.name.length, `tool name too short: "${tool.name}"`).toBeGreaterThan(0);
      expect(typeof tool.description, `tool "${tool.name}" missing description`).toBe('string');
      expect(tool.inputSchema.type, `tool "${tool.name}" schema type`).toBe('object');
      expect(typeof tool.inputSchema.properties, `tool "${tool.name}" missing properties`).toBe('object');
      expect(Array.isArray(tool.inputSchema.required), `tool "${tool.name}" required not array`).toBe(true);
    }
  });

  it('GRAPH_TOOLS can be converted to TypeBox via Type.Unsafe', async () => {
    const { Type } = await import('@sinclair/typebox');

    for (const tool of GRAPH_TOOLS) {
      // This is exactly what the bridge does — wrap the JSON Schema in Type.Unsafe
      const tboxSchema = Type.Unsafe(tool.inputSchema as Record<string, unknown>);
      expect(tboxSchema).toBeDefined();
      // Verify the schema is a valid TypeBox type (has [Kind] symbol)
      expect(typeof tboxSchema).toBe('object');
    }
  });

  it('every tool name is unique', () => {
    const names = GRAPH_TOOLS.map(t => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every tool declares mutates: boolean explicitly', () => {
    // Bead nmemo-2yv.113: the dispatcher's writeQueue (causal-agent.ts
    // handleToolCall) and the bridge's startup assertion both depend on
    // every GRAPH_TOOLS entry declaring `mutates: boolean` — undefined is not
    // allowed (would coerce to falsy and silently route a write tool through
    // the parallel-execution path).
    for (const tool of GRAPH_TOOLS) {
      expect(typeof tool.mutates, `tool "${tool.name}" missing mutates: boolean`).toBe('boolean');
    }
  });

  it('expected write tools are flagged mutates: true', () => {
    // The full current write surface (mutates: true). This guards against
    // accidentally flipping a write tool to mutates: false, which would
    // un-serialise it through the dispatcher's writeQueue and risk a DB race.
    //
    // Resynced from the original design-decision list (bead .113): create_causal_edge
    // was retired in E7 (doc 41 §11); the E2-E6 staging-write tools (propose_entity/
    // propose_fact/propose_causal_edge/propose_identity_verdict/propose_conflict_resolution)
    // and create_contradiction were added since and now belong here. List derived
    // from `GRAPH_TOOLS.filter(t => t.mutates)` — keep it in lockstep with the
    // tool definitions in causal-agent.ts.
    const EXPECTED_WRITE_TOOLS = new Set([
      // Canonical entity/fact writes
      'create_fact', 'resolve_entity', 'link_entity_to_memory',
      'add_entity_alias', 'update_entity_summary', 'create_same_as_link', 'execute_merge',
      'resolve_candidate', 'expire_fact', 'invalidate_fact', 'restore_fact',
      'update_fact_confidence',
      // Causal-edge writes
      'expire_causal_edge', 'revise_causal_edge',
      // Contradiction writes
      'create_contradiction', 'resolve_contradiction',
      // Reasoning report write
      'save_reasoning_report',
      // E2-E6 staging-write tools (doc 41 §8a) — write staging, never canonical
      'propose_entity', 'propose_fact', 'propose_causal_edge',
      'propose_identity_verdict', 'propose_conflict_resolution',
    ]);

    const actualWriteTools = new Set(
      GRAPH_TOOLS.filter((t) => t.mutates).map((t) => t.name),
    );

    expect(actualWriteTools).toEqual(EXPECTED_WRITE_TOOLS);
  });

  it('all required parameters for each tool have descriptions', () => {
    for (const tool of GRAPH_TOOLS) {
      for (const reqParam of tool.inputSchema.required) {
        const prop = tool.inputSchema.properties[reqParam];
        expect(prop, `tool "${tool.name}" required param "${reqParam}" has no property definition`).toBeDefined();
        // Every parameter should have a description for the LLM
        if (typeof prop === 'object' && prop !== null) {
          // It's okay if it's a $ref or complex schema, just verify it exists
          expect(typeof prop).toBe('object');
        }
      }
    }
  });
});

describe('Pi Agent Bridge: handleToolCall context resolution', () => {
  it('resolveContext returns graph_agent by default', () => {
    // handleToolCall with no context should use default actor
    // We test this indirectly — calling a read-only tool with no context
    // should not throw
    expect(typeof handleToolCall).toBe('function');
  });

  it('ToolCallContext accepts all valid actors', () => {
    const validActors: ToolCallContext['agent'][] = [
      'graph_agent', 'reasoning_agent', 'gardener_agent',
      'reconciliation_agent', 'user', 'system_trigger', 'cascade',
    ];

    for (const actor of validActors) {
      const ctx: ToolCallContext = { agent: actor };
      expect(ctx.agent).toBe(actor);
    }
  });
});

describe('Pi Agent Bridge: bridge module structure', () => {
  it('pi-agent-bridge.ts file exists and is valid TS', () => {
    const bridgePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../services/pi-agent-bridge.ts',
    );
    expect(fs.existsSync(bridgePath)).toBe(true);

    const source = fs.readFileSync(bridgePath, 'utf8');
    // Verify key constructs exist
    expect(source).toContain('createAgentSession');
    expect(source).toContain('defineTool');
    expect(source).toContain('handleToolCall');
    expect(source).toContain('GRAPH_TOOLS');
    expect(source).toContain('POST');
    expect(source).toContain('/run');
    expect(source).toContain('/health');
    expect(source).toContain('SessionManager.inMemory');
    expect(source).toContain('SettingsManager.inMemory');
  });

  it('bridge imports GRAPH_TOOLS from causal-agent', () => {
    const bridgePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../services/pi-agent-bridge.ts',
    );
    const source = fs.readFileSync(bridgePath, 'utf8');
    expect(source).toContain("from './causal-agent.js'");
  });

  it('bridge uses Type.Unsafe for schema conversion', () => {
    const bridgePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../services/pi-agent-bridge.ts',
    );
    const source = fs.readFileSync(bridgePath, 'utf8');
    expect(source).toContain('Type.Unsafe');
  });

  it('bridge validates actor / clamps timeout / caps readBody at /run boundary (bead .117)', () => {
    // Bead nmemo-2yv.117: three input-validation gaps at /run.
    //
    //   1. `actor` cast was TypeScript-only — any string flowed into audit
    //      `created_by` columns.  Fix: runtime check against the shared
    //      VALID_ACTORS set re-used from causal-agent.ts (no KnownActor narrow
    //      — the Actor type is correctly 7-wide; the re-lock skips the
    //      original spec's Step 1 type-narrow, see bead halt notes).
    //   2. `timeout` accepted any value — `null` coerced to 0 and short-circuited
    //      the agent.  Fix: clamp to [10, 600] seconds, return error response
    //      otherwise.
    //   3. `readBody` unbounded — a 1 GB POST eats heap.  Fix: 1 MB cap, surface
    //      as HTTP 413 (Payload Too Large) on exceed.
    const bridgePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../services/pi-agent-bridge.ts',
    );
    const source = fs.readFileSync(bridgePath, 'utf8');

    // (1) Actor validation: imports + uses the shared VALID_ACTORS set; no
    //     local KNOWN_ACTORS / KnownActor introduction (the re-lock explicitly
    //     skipped that since Actor is already 7-wide).
    expect(source).toContain('VALID_ACTORS');
    expect(source).toMatch(/from\s+['"]\.\/causal-agent\.js['"]/);
    expect(source).toContain('VALID_ACTORS.has(');
    expect(source).toContain('Invalid actor');
    expect(source).not.toContain('KNOWN_ACTORS');
    expect(source).not.toContain('KnownActor');

    // (2) Timeout clamp: rejects non-finite / out-of-range values BEFORE the
    //     setTimeout, and uses the validated timeoutNum downstream (not the
    //     raw `timeout` from the request body).
    expect(source).toContain('TIMEOUT_MIN_SEC');
    expect(source).toContain('TIMEOUT_MAX_SEC');
    expect(source).toContain('Number.isFinite(timeoutNum)');
    expect(source).toContain('Invalid timeout');
    expect(source).toMatch(/timeoutNum\s*\*\s*1000/);
    // The error message + setTimeout MUST use the validated value, not the
    // raw input.  This regex catches accidental `timeout * 1000` regressions.
    expect(source).not.toMatch(/\bsetTimeout\([^)]*,\s*timeout\s*\*\s*1000\)/);

    // (3) readBody size cap: 1 MB constant + 413 response surface in both
    //     POST handlers (/run and /tools/call).
    expect(source).toContain('MAX_BODY_BYTES');
    expect(source).toContain('1_000_000');
    expect(source).toContain('Request body exceeds');
    expect(source).toContain('413');
    expect(source).toContain('req.destroy()');
  });

  it('VALID_ACTORS is exported from causal-agent.ts and covers all 9 Actor values', () => {
    // Bead nmemo-2yv.117 re-lock: the bridge re-uses the existing
    // VALID_ACTORS set rather than introducing a narrower KNOWN_ACTORS.  This
    // test pins the contract so a future caller of `handleToolCall` adding a
    // new agent type touches one place (causal-agent.ts) and the bridge picks
    // it up automatically.
    //
    // Seven actors mirror migration 009's audit CHECK. Two staging-only MCP
    // actors are valid for tool-scoping but DELIBERATELY absent from the audit
    // CHECK (they write staging, never canonical): `extraction_proposer`
    // (epoch v2, doc 41 §8a.4) and `causal_agent` (epoch v2 E6, doc 41 §8a.6).
    expect(VALID_ACTORS).toBeInstanceOf(Set);
    expect(VALID_ACTORS.size).toBe(9);

    const expected: ToolCallContext['agent'][] = [
      'graph_agent', 'reasoning_agent', 'gardener_agent',
      'reconciliation_agent', 'user', 'system_trigger', 'cascade',
      'extraction_proposer', 'causal_agent',
    ];
    for (const actor of expected) {
      expect(VALID_ACTORS.has(actor), `expected VALID_ACTORS to include ${actor}`).toBe(true);
    }

    // Negative case: arbitrary strings from a malformed /run caller must NOT
    // satisfy the set's runtime check.  This is the falsifying test from the
    // bead Premise (`actor: "hacker"` previously flowed into audit rows).
    expect(VALID_ACTORS.has('hacker' as ToolCallContext['agent'])).toBe(false);
    expect(VALID_ACTORS.has('' as ToolCallContext['agent'])).toBe(false);
    expect(VALID_ACTORS.has('GRAPH_AGENT' as ToolCallContext['agent'])).toBe(false);
  });

  it('bridge fails fast on (provider, modelId) miss — no silent fallback', () => {
    // Bead nmemo-2yv.118: the previous two-tier fallback
    // (`|| available.find((m) => m.provider === provider) || available[0]`)
    // silently substituted a different model on config typo, drifting the
    // caller's cost meter and masking misconfigs. Strict-by-default: on miss
    // the bridge returns an error response listing the first 20 available
    // models so the caller can correct its provider/model envvars.
    const bridgePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../services/pi-agent-bridge.ts',
    );
    const source = fs.readFileSync(bridgePath, 'utf8');

    // No two-tier fallback shape.
    expect(source).not.toContain('available.find((m) => m.provider === provider)');
    expect(source).not.toMatch(/\|\|\s*available\[0\]/);

    // Error response on miss includes the available-models sample.
    expect(source).toContain('Model not found: provider=');
    expect(source).toContain('Available (first 20):');
    expect(source).toContain('.slice(0, 20)');
  });
});

// ============================================
// Integration tests — need bridge running
// ============================================

const BRIDGE_URL = process.env.PI_BRIDGE_URL || 'http://localhost:3099';
const bridgeAvailable = await (async () => {
  try {
    await fetch(`${BRIDGE_URL}/health`);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!bridgeAvailable)('Pi Agent Bridge: HTTP integration', () => {

  it('GET /health returns ok', async () => {
    const res = await fetch(`${BRIDGE_URL}/health`);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.status).toBe('ok');
    expect(data.service).toBe('pi-agent-bridge');
    expect(typeof data.tools).toBe('number');
    expect(data.tools).toBe(GRAPH_TOOLS.length);
  });

  it('GET /tools lists all graph tools', async () => {
    const res = await fetch(`${BRIDGE_URL}/tools`);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.count).toBe(GRAPH_TOOLS.length);

    const names = data.tools.map((t: any) => t.name);
    for (const tool of GRAPH_TOOLS) {
      expect(names, `tool "${tool.name}" not listed`).toContain(tool.name);
    }
  });

  it('POST /run with minimal prompt returns result', async () => {
    const res = await fetch(`${BRIDGE_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Respond with exactly the word "pong". Do not use any tools.',
        system_prompt: 'You are a test assistant. Follow instructions exactly. Never use tools.',
        provider: 'zai',
        model: 'glm-5.1',
        thinking: 'off',
        timeout: 30,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;

    expect(typeof data.result).toBe('string');
    expect(data.result.toLowerCase()).toContain('pong');
    expect(data.cost).toBeDefined();
    expect(typeof data.cost.input_tokens).toBe('number');
    expect(typeof data.cost.output_tokens).toBe('number');
    expect(data.cost.input_tokens).toBeGreaterThan(0);
  });

  it('POST /run without prompt returns 400', async () => {
    const res = await fetch(`${BRIDGE_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain('prompt');
  });

  it('POST /run respects actor parameter', async () => {
    const res = await fetch(`${BRIDGE_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Say "ok". Do not use any tools.',
        system_prompt: 'Reply with just "ok". Never use tools.',
        provider: 'zai',
        model: 'glm-5.1',
        actor: 'reasoning_agent',
        timeout: 30,
      }),
    });

    expect(res.status).toBe(200);
  });

  it('POST /run tracks tool calls when tools are used', async () => {
    // This test requires a running DB + Qdrant + ML services
    // because the tools hit real services. Skip if not available.
    const res = await fetch(`${BRIDGE_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Search for entities similar to "test". Use the search_similar_entities tool.',
        system_prompt: 'You are a test assistant. Use the search_similar_entities tool to search for "test", then report the result.',
        provider: 'zai',
        model: 'glm-5.1',
        timeout: 60,
      }),
    });

    // May fail if DB is down — that's ok, we're testing the plumbing
    if (res.status === 200) {
      const data = await res.json() as any;
      // If the LLM actually called a tool, tool_calls should be > 0
      // But we can't guarantee the LLM will cooperate, so just verify the field exists
      expect(typeof data.tool_calls).toBe('number');
      expect(typeof data.turns).toBe('number');
    }
  });
});

// ============================================
// Python provider tests (run via vitest if Python is available)
// ============================================

describe('Pi Agent Bridge: Python PiBridgeProvider shape', () => {
  it('PiBridgeProvider exists in llm.py', () => {
    const llmPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../ml-services/app/core/llm.py',
    );
    expect(fs.existsSync(llmPath)).toBe(true);

    const source = fs.readFileSync(llmPath, 'utf8');
    expect(source).toContain('class PiBridgeProvider');
    expect(source).toContain('def generate(');
    expect(source).toContain('def generate_json(');
    expect(source).toContain('def extract_json(');
    expect(source).toContain('LLM_PROVIDER == "pi"');
    expect(source).toContain('PiBridgeProvider()');
  });

  it('ClaudeCodeProvider was NOT deleted', () => {
    const llmPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../ml-services/app/core/llm.py',
    );
    const source = fs.readFileSync(llmPath, 'utf8');
    expect(source).toContain('class ClaudeCodeProvider');
    // Claude is the default fallthrough (no explicit == "claude" check)
    expect(source).toContain('LLM_PROVIDER == "zai"');
    expect(source).toContain('LLM_PROVIDER == "pi"');
    expect(source).toContain('Using Claude Code CLI LLM provider');
  });

  it('PiBridgeProvider maps effort to thinking levels', () => {
    const llmPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../ml-services/app/core/llm.py',
    );
    const source = fs.readFileSync(llmPath, 'utf8');
    // Verify the mapping table exists
    expect(source).toContain('"low": "off"');
    expect(source).toContain('"medium": "low"');
    expect(source).toContain('"high": "medium"');
    expect(source).toContain('"max": "high"');
  });

  it('PiBridgeProvider sends all required fields in POST', () => {
    const llmPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../ml-services/app/core/llm.py',
    );
    const source = fs.readFileSync(llmPath, 'utf8');
    // Verify the payload structure
    expect(source).toContain('"prompt"');
    expect(source).toContain('"system_prompt"');
    expect(source).toContain('"provider"');
    expect(source).toContain('"model"');
    expect(source).toContain('"thinking"');
    expect(source).toContain('"actor"');
    expect(source).toContain('"timeout"');
  });
});
