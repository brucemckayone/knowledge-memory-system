/**
 * MCP discovery + invocation probe for the new `generate_component` tool.
 *
 * Boots the learning MCP server as a subprocess (stdio transport) using the
 * official MCP client SDK, then:
 *   1) Sends `tools/list` and asserts `generate_component` is registered.
 *   2) Sends `tools/call` for `generate_component({ kind: 'Callout', context: ... })`
 *      and asserts the result is a non-empty parseable JSON describing either
 *      the component spec or a markdown fallback.
 *
 * Mirrors the verification pattern used for umy.2 / umy.5 smoke tests.
 */
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const log = (...a: unknown[]) => console.log('[probe]', ...a);

let failures = 0;
function expect(cond: boolean, msg: string) {
  if (cond) log('OK  ', msg);
  else { failures += 1; log('FAIL', msg); }
}

async function main() {
  log('spawning learning MCP server (npx tsx src/mcp/learning-mcp.ts)…');

  // npx is a .cmd on Windows — let StdioClientTransport handle the spawn.
  // tsx is resolved via local node_modules.
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', 'src/mcp/learning-mcp.ts'],
    env: process.env as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });

  await client.connect(transport);
  log('connected');

  // 1) tools/list
  const list = await client.listTools();
  const names = list.tools.map(t => t.name);
  log(`tools/list returned ${names.length} tools`);
  expect(names.includes('generate_component'), 'generate_component is registered');
  const def = list.tools.find(t => t.name === 'generate_component');
  if (def) {
    expect(typeof def.description === 'string' && def.description.length > 20,
      `description present (${def.description?.length ?? 0} chars)`);
    const props = (def.inputSchema as any).properties ?? {};
    expect(!!props.kind && !!props.context, 'inputSchema has kind+context');
    expect(Array.isArray(props.kind?.enum) && props.kind.enum.length === 7,
      `kind enum has 7 values (got ${props.kind?.enum?.length ?? 0})`);
  }

  // 2) tools/call
  log('calling generate_component(kind=Callout, context="explain why git branches matter")…');
  const t0 = Date.now();
  const callResult = await client.callTool({
    name: 'generate_component',
    arguments: {
      kind: 'Callout',
      context: 'explain why git branches matter',
    },
  });
  const ms = Date.now() - t0;
  log(`call completed in ${ms}ms`);

  const content = (callResult as any).content;
  expect(Array.isArray(content) && content.length > 0, 'response has content[]');
  const text = content?.[0]?.text as string | undefined;
  expect(typeof text === 'string' && text.length > 0, `text non-empty (len=${text?.length ?? 0})`);

  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* below */ }
  expect(!!parsed, 'response text is valid JSON');

  if (parsed) {
    const isComponent = parsed.kind && parsed.kind !== 'markdown' && parsed.props;
    const isFallback = parsed.kind === 'markdown' && typeof parsed.content === 'string';
    expect(isComponent || isFallback,
      `result is either component spec or markdown fallback (kind=${parsed.kind})`);
    if (isComponent) {
      log('  -> component:', parsed.kind, 'props keys:', Object.keys(parsed.props ?? {}).join(','),
        parsed.children ? `children=${(parsed.children as string).length}c` : '');
    } else if (isFallback) {
      log('  -> markdown fallback (len=' + parsed.content.length + ')');
    }
  }

  await client.close();

  if (failures > 0) {
    log(`FAILED: ${failures} assertion(s)`);
    process.exit(1);
  }
  log('ALL CHECKS PASSED');
  process.exit(0);
}

main().catch(err => {
  console.error('[probe] THREW:', err);
  process.exit(2);
});
