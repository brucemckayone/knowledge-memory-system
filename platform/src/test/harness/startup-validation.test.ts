/**
 * Bead nmemo-2yv.132 — startup-validation aggregator + per-validator behaviour.
 *
 * Tests cover:
 *   (1) Aggregator runs every validator; no short-circuit on first failure.
 *   (2) The runValidator wrapper times out a slow validator with a useful detail.
 *   (3) An exception thrown inside a validator surfaces as ok=false with the
 *       message, not as a process-killing throw.
 *   (4) Healthy/drifted/timeout cases for each of the four boundaries —
 *       structured via the runValidator wrapper rather than mocking module
 *       internals, so the test is robust against future re-organisations of
 *       the boundary code.
 */

import { describe, it, expect } from 'vitest';
import { validateStartup, _testOnly } from '../../services/startup-validation.js';

const { runValidator } = _testOnly;

describe('B.startup-validation: runValidator wrapper (nmemo-2yv.132)', () => {
  it('returns ok=true when the inner validator resolves with ok=true', async () => {
    const result = await runValidator({
      name: 'healthy',
      run: async () => ({ ok: true }),
    });
    expect(result.name).toBe('healthy');
    expect(result.ok).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok=false with the detail when the inner validator resolves with ok=false', async () => {
    const result = await runValidator({
      name: 'drifted',
      run: async () => ({ ok: false, detail: 'dim mismatch: provisioned 768, expected 1024' }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('dim mismatch');
  });

  it('returns ok=false with the thrown message when the inner validator throws', async () => {
    const result = await runValidator({
      name: 'thrower',
      run: async () => { throw new Error('boundary unreachable: connect ECONNREFUSED'); },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('returns ok=false with "timeout" detail when the inner validator exceeds the budget', async () => {
    // The validator never resolves; the wrapper's 5s timeout fires.
    // Test budget: ~5s — acceptable for one timeout case.
    const result = await runValidator({
      name: 'slow',
      run: () => new Promise(() => { /* never resolves */ }),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/timeout/i);
    expect(result.durationMs).toBeGreaterThanOrEqual(4_500);
    expect(result.durationMs).toBeLessThan(7_000);
  }, 10_000);

  it('returns ok=false with a useful message when the inner validator throws a non-Error', async () => {
    const result = await runValidator({
      name: 'throws-string',
      run: async () => { throw 'a string, not an Error'; },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('a string, not an Error');
  });
});

describe('B.startup-validation: validateStartup aggregator (nmemo-2yv.132)', () => {
  it('returns a ValidatorResult per registered validator (no short-circuit)', async () => {
    // validateStartup runs the live validators against whatever the test
    // env actually has. We do NOT assert on ok=true/false here — that
    // depends on whether qdrant/ml-services are up — but we DO assert that
    // every registered validator appears in the result, proving no
    // short-circuit on first failure.
    const results = await validateStartup();
    const names = results.map(r => r.name);
    // Per the .132 spec, the four initial validators are: qdrant_dim,
    // ml_services, transport, ports.
    expect(names).toContain('qdrant_dim');
    expect(names).toContain('ml_services');
    expect(names).toContain('transport');
    expect(names).toContain('ports');
    expect(names.length).toBeGreaterThanOrEqual(4);
    // Every result has a durationMs field.
    for (const r of results) {
      expect(typeof r.durationMs).toBe('number');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});

describe('B.startup-validation: ports validator unit (nmemo-2yv.132)', () => {
  it('flags PORT == PI_BRIDGE_PORT as a collision with both values in the detail', async () => {
    // The ports validator is pure env-read; we can drive it directly via
    // the exported VALIDATORS array.
    const { VALIDATORS } = _testOnly;
    const portsValidator = VALIDATORS.find(v => v.name === 'ports');
    expect(portsValidator).toBeDefined();

    const origPort = process.env.PORT;
    const origPi = process.env.PI_BRIDGE_PORT;
    try {
      process.env.PORT = '3001';
      process.env.PI_BRIDGE_PORT = '3001';
      const result = await portsValidator!.run();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('3001');
      expect(result.detail).toMatch(/collide|collision/i);
    } finally {
      if (origPort === undefined) delete process.env.PORT; else process.env.PORT = origPort;
      if (origPi === undefined) delete process.env.PI_BRIDGE_PORT; else process.env.PI_BRIDGE_PORT = origPi;
    }
  });

  it('passes when PORT and PI_BRIDGE_PORT differ', async () => {
    const { VALIDATORS } = _testOnly;
    const portsValidator = VALIDATORS.find(v => v.name === 'ports')!;
    const origPort = process.env.PORT;
    const origPi = process.env.PI_BRIDGE_PORT;
    try {
      process.env.PORT = '3000';
      process.env.PI_BRIDGE_PORT = '3099';
      const result = await portsValidator.run();
      expect(result.ok).toBe(true);
    } finally {
      if (origPort === undefined) delete process.env.PORT; else process.env.PORT = origPort;
      if (origPi === undefined) delete process.env.PI_BRIDGE_PORT; else process.env.PI_BRIDGE_PORT = origPi;
    }
  });
});

describe('B.startup-validation: transport validator unit (nmemo-2yv.132)', () => {
  it('rejects an unknown LLM_PROVIDER value with a clear message', async () => {
    const { VALIDATORS } = _testOnly;
    const transport = VALIDATORS.find(v => v.name === 'transport')!;
    const orig = process.env.LLM_PROVIDER;
    try {
      process.env.LLM_PROVIDER = 'mystery';
      const result = await transport.run();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('mystery');
      expect(result.detail).toMatch(/pi\|claude\|zai/);
    } finally {
      if (orig === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = orig;
    }
  });

  it('skips probe when LLM_PROVIDER=zai (provider runs in ml-services)', async () => {
    const { VALIDATORS } = _testOnly;
    const transport = VALIDATORS.find(v => v.name === 'transport')!;
    const orig = process.env.LLM_PROVIDER;
    try {
      process.env.LLM_PROVIDER = 'zai';
      const result = await transport.run();
      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(/zai|skipped/i);
    } finally {
      if (orig === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = orig;
    }
  });
});
