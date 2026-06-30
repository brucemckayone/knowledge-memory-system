/**
 * B6 (nmemo-6do.6): versioned PRICING map + cost helpers.
 *
 * Pure unit test (no DB) — runs under vitest.unit.config.ts (the .unit.test.ts
 * suffix, no globalSetup). config.ts validates env at import and exits if
 * DATABASE_URL is missing; vitest sets NODE_ENV=test so config.ts skips dotenv
 * (it expects tests to supply env). We set a dummy DATABASE_URL before a dynamic
 * import — the pricing exports never touch the DB.
 */

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

type ConfigModule = typeof import('../config.js');
let cfg: ConfigModule;

beforeAll(async () => {
  cfg = await import('../config.js');
});

describe('B6: PRICING config + cost helpers', () => {
  it('exports version, baseline, and blended weights', () => {
    expect(cfg.PRICING_VERSION).toBe('2026-06-16');
    expect(cfg.BASELINE_MODEL).toBe('claude-haiku-4-5');
    expect(cfg.BLENDED_WEIGHTS).toEqual({ input: 1, output: 2 });
  });

  it('has confirmed Anthropic rows with correct cache multipliers', () => {
    expect(cfg.PRICING['claude-haiku-4-5']).toMatchObject({
      provider: 'anthropic', input: 1.0, output: 5.0,
      cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2.0, verified: 'confirmed',
    });
    expect(cfg.PRICING['claude-sonnet-4-6']).toMatchObject({ input: 3.0, output: 15.0 });
    expect(cfg.PRICING['claude-opus-4-8']).toMatchObject({ input: 5.0, output: 25.0 });
  });

  it('has the hardening-review-corrected candidate rows', () => {
    expect(cfg.PRICING['mimo-v2-5']).toMatchObject({ input: 0.14, output: 0.28, verified: 'estimated' });
    expect(cfg.PRICING['kimi-k2-6']).toMatchObject({ input: 0.95, output: 4.0, cacheRead: 0.16, verified: 'estimated' });
    expect(cfg.PRICING['nomic-embed-text']).toMatchObject({ provider: 'ollama', input: 0, output: 0, verified: 'confirmed' });
  });

  it('(a) computeCost reconciles the per-bucket sum to estimated_usd (Haiku)', () => {
    const c = cfg.computeCost(
      {
        input_tokens: 1000, output_tokens: 1000,
        cache_read_tokens: 100, cache_write_5m_tokens: 50, cache_write_1h_tokens: 50,
      },
      'claude-haiku-4-5',
    );
    expect(c.cost_status).toBe('priced');
    expect(c.input_cost_usd).toBeCloseTo(0.001, 9);                 // 1000 * 1.00 / 1e6
    expect(c.output_cost_usd).toBeCloseTo(0.005, 9);                // 1000 * 5.00 / 1e6
    expect(c.cache_cost_usd).toBeCloseTo((100 * 0.1 + 50 * 1.25 + 50 * 2.0) / 1e6, 12);
    expect(c.saved_cache_cost_usd).toBeCloseTo(0.0001, 12);         // 100 * 1.00 / 1e6
    expect(c.estimated_usd).toBeCloseTo(
      c.input_cost_usd! + c.output_cost_usd! + c.cache_cost_usd!, 12,
    );
  });

  it('(b) blendedRate(haiku) = (1*1 + 5*2)/3 ≈ 3.667', () => {
    expect(cfg.blendedRate('claude-haiku-4-5')).toBeCloseTo(11 / 3, 6);
  });

  it('(c) multiplier vs the baseline orders cheap < 1 < premium', () => {
    expect(cfg.multiplier('deepseek-v4-flash')).toBeLessThan(1);
    expect(cfg.multiplier('claude-haiku-4-5')).toBeCloseTo(1, 9);
    expect(cfg.multiplier('claude-opus-4-8')).toBeGreaterThan(1);
  });

  it('prices a DATED model id via its alias (claude-haiku-4-5-20251001 -> claude-haiku-4-5)', () => {
    // Regression (B11 live E2E): the CLI reports the dated id; PRICING is keyed by the alias.
    const c = cfg.computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-haiku-4-5-20251001');
    expect(c.cost_status).toBe('priced');
    expect(c.estimated_usd).toBeCloseTo(0.006, 9); // (1000*1 + 1000*5) / 1e6
  });

  it('(d) unknown resolved_model -> cost_status unknown_model with NULL costs', () => {
    const c = cfg.computeCost({ input_tokens: 100, output_tokens: 50 }, 'totally-unknown-model');
    expect(c.cost_status).toBe('unknown_model');
    expect(c.input_cost_usd).toBeNull();
    expect(c.output_cost_usd).toBeNull();
    expect(c.estimated_usd).toBeNull();
  });

  it('(e) gateway_reported_usd overrides the computed total but keeps buckets', () => {
    const c = cfg.computeCost(
      { input_tokens: 1000, output_tokens: 1000 },
      'claude-haiku-4-5',
      { gatewayReportedUsd: 0.05 },
    );
    expect(c.estimated_usd).toBe(0.05);
    expect(c.input_cost_usd).toBeCloseTo(0.001, 9);  // buckets still computed for reconciliation
  });

  it('prices reasoning_output as a SUBSET of output (no double-count)', () => {
    const pricing = { m: { input: 1, output: 10, reasoningOutput: 30 } };
    const c = cfg.computeCost({ output_tokens: 100, reasoning_output_tokens: 20 }, 'm', { pricing });
    // 80 non-reasoning * 10 + 20 reasoning * 30 = 1400 / 1e6
    expect(c.output_cost_usd).toBeCloseTo(1400 / 1e6, 12);
  });

  it('blendedRate / multiplier return safe values for unknown models', () => {
    expect(cfg.blendedRate('nope')).toBe(0);
    expect(cfg.multiplier('nope')).toBe(0);                // model unknown, baseline known
    expect(cfg.multiplier('nope', 'also-nope')).toBe(1);   // both unknown -> 1
  });

  it('operation taxonomy includes active + reserved operations', () => {
    for (const op of ['graph_agent', 'reasoning_agent', 'reconciliation_agent',
      'gardener_agent', 'drift', 'judge', 'embed.document', 'embed.query']) {
      expect(cfg.OPERATION_VALUES).toContain(op);
    }
    expect(cfg.OPERATION_VALUES).toContain('notify.phrase');  // reserved — no LLM call today
  });
});
