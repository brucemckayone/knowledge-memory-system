import { checkCausalMcpHealth } from '../src/services/causal-agent.js';

const result = await checkCausalMcpHealth(20_000);
console.log(JSON.stringify({
  ok: result.ok,
  toolCount: result.tools?.length ?? 0,
  tools: result.tools?.sort(),
  durationMs: result.durationMs,
  error: result.error,
}, null, 2));
process.exit(result.ok ? 0 : 1);
