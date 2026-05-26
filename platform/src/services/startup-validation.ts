/**
 * Startup-validation invariants (bead nmemo-2yv.132 — Review #14 C3).
 *
 * Every config value that spans code + .env + migrations drifts silently
 * eventually. Each boundary is supposed to cross-check at startup; a drifted
 * value should be fatal at boot rather than silently-running. This module
 * stands up the integration point with the four current validators:
 *
 *   1. `qdrant_dim`   — Qdrant collection dimension matches `EMBED_DIMENSIONS`.
 *   2. `ml_services`  — ml-services FastAPI is reachable + healthy.
 *   3. `transport`    — selected LLM_PROVIDER's transport process is healthy.
 *   4. `ports`        — PORT and PI_BRIDGE_PORT don't collide.
 *
 * Per-boundary fix beads (`.121 .126 .127 .112`) own the underlying check
 * logic; this module is the integration point that wires them into a single
 * pre-serve gate.
 *
 * Behaviour contract:
 *   - Every validator runs (no short-circuit on first failure — operators
 *     see the full picture).
 *   - Each validator has a 5s timeout; aggregate budget is bounded by
 *     VALIDATOR_TIMEOUT_MS × VALIDATORS.length.
 *   - Validators never throw to the caller; failures surface as
 *     `ok: false` with a `detail` message.
 *   - The caller (`src/index.ts`) decides what to do with the result list;
 *     production behaviour is fail-fast (`process.exit(1)` on any
 *     `!ok`).
 *
 * Why not a `STRICT_STARTUP` env opt-out: bead .132 Decision section
 * rejected that explicitly. An env-var escape hatch recreates the
 * silent-drift problem this module is fixing. Strict-only.
 */

import { config } from '../config.js';
import { ensureCollections } from './qdrant.js';
import { ml } from './ml-client.js';
import { checkGraphMcpHealth } from './causal-agent.js';

export interface ValidatorResult {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

interface Validator {
  name: string;
  run: () => Promise<{ ok: boolean; detail?: string }>;
}

const VALIDATOR_TIMEOUT_MS = 5_000;

/** Wrap a validator with timing + timeout. The validator's own .run() may
 *  throw or take longer than the budget; either way we return a
 *  `ValidatorResult` rather than propagating. */
async function runValidator(v: Validator): Promise<ValidatorResult> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      v.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`validator timeout after ${VALIDATOR_TIMEOUT_MS}ms`)), VALIDATOR_TIMEOUT_MS);
      }),
    ]);
    return { name: v.name, ok: result.ok, detail: result.detail, durationMs: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: v.name, ok: false, detail: message, durationMs: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ===========================================================================
// Validators
// ===========================================================================

const qdrantDimValidator: Validator = {
  name: 'qdrant_dim',
  run: async () => {
    // ensureCollections creates any missing collections AND throws when an
    // existing one's dim differs from config.EMBED_DIMENSIONS (bead .121).
    // Both behaviours are what we want at startup.
    await ensureCollections();
    return { ok: true };
  },
};

const mlServicesValidator: Validator = {
  name: 'ml_services',
  run: async () => {
    const healthy = await ml.health();
    if (!healthy) {
      return { ok: false, detail: `ml-services /health did not return 200 (URL=${config.ML_SERVICES_URL})` };
    }
    return { ok: true };
  },
};

const transportValidator: Validator = {
  name: 'transport',
  run: async () => {
    const provider = process.env.LLM_PROVIDER ?? 'pi';
    if (provider === 'zai') {
      // ZAI runs inside ml-services; no host transport process to probe.
      return { ok: true, detail: 'skipped (zai provider runs in ml-services)' };
    }
    if (provider === 'pi') {
      const piPort = process.env.PI_BRIDGE_PORT ?? '3099';
      const url = `http://localhost:${piPort}/health`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) {
          return { ok: false, detail: `pi bridge /health returned ${response.status} at ${url}` };
        }
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: `pi bridge /health unreachable at ${url}: ${message}` };
      }
    }
    if (provider === 'claude') {
      const result = await checkGraphMcpHealth();
      if (!result.ok) {
        return { ok: false, detail: `graph MCP probe failed: ${result.error ?? 'unknown error'}` };
      }
      return { ok: true };
    }
    return { ok: false, detail: `unknown LLM_PROVIDER='${provider}' (expected pi|claude|zai)` };
  },
};

const portsValidator: Validator = {
  name: 'ports',
  run: async () => {
    const platformPort = process.env.PORT ?? '3000';
    const piPort = process.env.PI_BRIDGE_PORT ?? '3099';
    if (platformPort === piPort) {
      return {
        ok: false,
        detail: `PORT and PI_BRIDGE_PORT both resolve to ${platformPort} — platform + Pi bridge would collide. Set distinct values in .env.`,
      };
    }
    return { ok: true };
  },
};

/** The active validator list. Hand-maintained. Per-boundary fix beads
 *  (.121 .126 .127 .112) own the underlying check; new boundaries get a
 *  validator entry alongside their initial PR. */
const VALIDATORS: Validator[] = [
  qdrantDimValidator,
  mlServicesValidator,
  transportValidator,
  portsValidator,
];

/** Run every validator (no short-circuit) and return the result list.
 *  The caller decides fail-fast vs. tolerate. Validators never throw out. */
export async function validateStartup(): Promise<ValidatorResult[]> {
  const results: ValidatorResult[] = [];
  for (const v of VALIDATORS) {
    results.push(await runValidator(v));
  }
  return results;
}

// Test-only handle to swap validators for unit-level coverage of the
// aggregator + reporting logic. NOT for production use.
export const _testOnly = { runValidator, VALIDATORS };
