import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, parseToolsOption } from '../agent.js';

// ── parseToolsOption ───────────────────────────────────────────────────────

test("parseToolsOption: 'none' → empty tools, no MCP", () => {
  const r = parseToolsOption('none');
  assert.equal(r.webTools, null);
  assert.equal(r.wantsMcp, false);
  assert.equal(r.passthrough, null);
});

test("parseToolsOption: 'mcp' → MCP only, no web tools", () => {
  const r = parseToolsOption('mcp');
  assert.equal(r.webTools, null);
  assert.equal(r.wantsMcp, true);
  assert.equal(r.passthrough, null);
});

test("parseToolsOption: 'WebSearch' alone is recognised as a web tool", () => {
  const r = parseToolsOption('WebSearch');
  assert.equal(r.webTools, 'WebSearch');
  assert.equal(r.wantsMcp, false);
});

test("parseToolsOption: 'WebSearch,WebFetch' → both web tools, no MCP", () => {
  const r = parseToolsOption('WebSearch,WebFetch');
  assert.equal(r.webTools, 'WebSearch,WebFetch');
  assert.equal(r.wantsMcp, false);
  assert.equal(r.passthrough, null);
});

test("parseToolsOption: 'WebSearch,WebFetch,mcp' → web tools + MCP", () => {
  const r = parseToolsOption('WebSearch,WebFetch,mcp');
  assert.equal(r.webTools, 'WebSearch,WebFetch');
  assert.equal(r.wantsMcp, true);
});

test("parseToolsOption: unknown bare string falls through as passthrough", () => {
  const r = parseToolsOption('SomeOtherTool');
  assert.equal(r.webTools, null);
  assert.equal(r.passthrough, 'SomeOtherTool');
});

test('parseToolsOption: undefined defaults to none', () => {
  const r = parseToolsOption(undefined);
  assert.equal(r.webTools, null);
  assert.equal(r.wantsMcp, false);
  assert.equal(r.passthrough, null);
});

// ── buildArgs CLI assembly ─────────────────────────────────────────────────

function indexOfPair(args: string[], flag: string): number {
  return args.indexOf(flag);
}

function valueAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i < 0 || i === args.length - 1) return null;
  return args[i + 1] ?? null;
}

test("buildArgs: tools='WebSearch,WebFetch' produces --tools 'WebSearch,WebFetch'", () => {
  const args = buildArgs('hi', { tools: 'WebSearch,WebFetch' });
  assert.equal(valueAfter(args, '--tools'), 'WebSearch,WebFetch');
  // Defaults
  assert.equal(valueAfter(args, '--model'), 'haiku');
  assert.equal(valueAfter(args, '--effort'), 'low');
});

test("buildArgs: tools='none' produces empty --tools '' (back-compat)", () => {
  const args = buildArgs('hi', { tools: 'none' });
  assert.equal(valueAfter(args, '--tools'), '');
});

test("buildArgs: tools='WebSearch' single tool", () => {
  const args = buildArgs('hi', { tools: 'WebSearch' });
  assert.equal(valueAfter(args, '--tools'), 'WebSearch');
});

test("buildArgs: tools='mcp' alone with mcpConfigPath wires MCP and skips --tools", () => {
  const args = buildArgs('hi', { tools: 'mcp', mcpConfigPath: '/tmp/x.json' });
  // MCP plumbing
  assert.equal(valueAfter(args, '--mcp-config'), '/tmp/x.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(valueAfter(args, '--allowedTools'), 'mcp__learn__*');
  // No --tools flag should appear at all
  assert.equal(indexOfPair(args, '--tools'), -1);
});

test("buildArgs: tools default ('none') produces --tools ''", () => {
  const args = buildArgs('hi', {});
  assert.equal(valueAfter(args, '--tools'), '');
});

test("buildArgs: tools='WebSearch,WebFetch,mcp' includes both web and MCP plumbing", () => {
  const args = buildArgs('hi', {
    tools: 'WebSearch,WebFetch,mcp',
    mcpConfigPath: '/tmp/x.json',
  });
  assert.equal(valueAfter(args, '--tools'), 'WebSearch,WebFetch');
  assert.equal(valueAfter(args, '--mcp-config'), '/tmp/x.json');
});

test("buildArgs: env-flag-style 'none' never emits 'WebSearch' anywhere", () => {
  const args = buildArgs('hi', { tools: 'none' });
  for (const a of args) {
    assert.ok(!a.includes('WebSearch'), `arg should not contain WebSearch: ${a}`);
    assert.ok(!a.includes('WebFetch'), `arg should not contain WebFetch: ${a}`);
  }
});
