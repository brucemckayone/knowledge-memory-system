/**
 * B11 (nmemo-6do.11): blended-multiplier drift guard.
 *
 * Regenerates the illustrative blended-multiplier table (design §4.6) PURELY from
 * the shipped config.ts PRICING + BLENDED_WEIGHTS and asserts the formulas hold
 * for every model — so the reported multipliers can never drift from the shipped
 * rates (there is no hand-maintained table to fall out of sync). Pure unit test.
 */

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

let cfg: typeof import('../config.js');
beforeAll(async () => { cfg = await import('../config.js'); });

describe('B11: blended-multiplier drift guard', () => {
  it('regenerates the multiplier table from PRICING; the §4.6 formulas hold for every model', () => {
    const { PRICING, BLENDED_WEIGHTS, BASELINE_MODEL, blendedRate, multiplier } = cfg;
    const wIn = BLENDED_WEIGHTS.input;
    const wOut = BLENDED_WEIGHTS.output;
    const baseBlended = blendedRate(BASELINE_MODEL);
    expect(baseBlended).toBeGreaterThan(0);

    const table = Object.entries(PRICING).map(([model, rate]) => {
      const blended = blendedRate(model);
      // §4.6: blended($/MTok) = (rate.input*w_in + rate.output*w_out) / (w_in+w_out)
      expect(blended).toBeCloseTo((rate.input * wIn + rate.output * wOut) / (wIn + wOut), 9);
      const mult = multiplier(model);
      // §4.6: multiplier(m) = blended(m) / blended(BASELINE_MODEL)
      expect(mult).toBeCloseTo(blended / baseBlended, 9);
      return { model, blended: Number(blended.toFixed(4)), mult: Number(mult.toFixed(4)) };
    });

    // The regenerated table is non-empty and well-anchored.
    expect(table.length).toBe(Object.keys(PRICING).length);
    expect(multiplier(BASELINE_MODEL)).toBeCloseTo(1, 9);          // baseline anchors at 1.0x
    expect(multiplier('deepseek-v4-flash')).toBeLessThan(1);       // a cheap model is < 1x
    expect(multiplier('claude-opus-4-8')).toBeGreaterThan(1);      // a premium model is > 1x

    // Surface the regenerated table (what a CI artifact would diff against prose).
    // eslint-disable-next-line no-console
    console.log('[multiplier-table @ ' + cfg.PRICING_VERSION + ']',
      JSON.stringify(table.sort((a, b) => a.mult - b.mult)));
  });
});
