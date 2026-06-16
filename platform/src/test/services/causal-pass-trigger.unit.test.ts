/**
 * Pure-predicate unit tests for the causal-pass trigger (doc 41 §6, §12 #6; bead
 * nmemo-vpz.6 / E6). Zero infra — runs under vitest.unit.config.ts. Each of the three
 * triggers fires independently; none firing skips the pass.
 */

import { describe, it, expect } from 'vitest';
import {
  hasCausalLanguage,
  shouldRunCausalPass,
  type CausalTriggerSignals,
} from '../../services/causal-pass-trigger.js';

const CONFIG = { factThreshold: 5 };

function signals(overrides: Partial<CausalTriggerSignals> = {}): CausalTriggerSignals {
  return {
    promotedFactCount: 0,
    sourceTexts: [],
    touchedEntityHasCausalHistory: false,
    ...overrides,
  };
}

describe('hasCausalLanguage', () => {
  it('detects causal cues, case-insensitively', () => {
    expect(hasCausalLanguage('The Series B led to the HQ relocation')).toBe(true);
    expect(hasCausalLanguage('They moved BECAUSE of the funding')).toBe(true);
    expect(hasCausalLanguage('Revenue grew due to the new contract')).toBe(true);
  });

  it('returns false for neutral text and empty input', () => {
    expect(hasCausalLanguage('Acme is headquartered in Berlin')).toBe(false);
    expect(hasCausalLanguage('')).toBe(false);
  });
});

describe('shouldRunCausalPass — triggers fire independently (doc 41 §12 #6)', () => {
  it('skips when no trigger fires', () => {
    const d = shouldRunCausalPass(
      signals({ promotedFactCount: 2, sourceTexts: ['Acme is in Berlin'] }),
      CONFIG,
    );
    expect(d.run).toBe(false);
    expect(d.reasons).toHaveLength(0);
  });

  it('(a) runs on causal language alone', () => {
    const d = shouldRunCausalPass(
      signals({ promotedFactCount: 1, sourceTexts: ['The raise triggered a hiring spree'] }),
      CONFIG,
    );
    expect(d.run).toBe(true);
    expect(d.reasons.join(' ')).toContain('causal language');
  });

  it('(b) runs when promoted-fact count >= threshold', () => {
    const d = shouldRunCausalPass(signals({ promotedFactCount: 5 }), CONFIG);
    expect(d.run).toBe(true);
    expect(d.reasons.join(' ')).toContain('promoted-fact count');
  });

  it('(b) does NOT run just below threshold', () => {
    expect(shouldRunCausalPass(signals({ promotedFactCount: 4 }), CONFIG).run).toBe(false);
  });

  it('(c) runs when a touched entity has prior causal history', () => {
    const d = shouldRunCausalPass(signals({ touchedEntityHasCausalHistory: true }), CONFIG);
    expect(d.run).toBe(true);
    expect(d.reasons.join(' ')).toContain('prior causal history');
  });

  it('records every reason that fired', () => {
    const d = shouldRunCausalPass(
      signals({
        promotedFactCount: 9,
        sourceTexts: ['profits rose because of the merger'],
        touchedEntityHasCausalHistory: true,
      }),
      CONFIG,
    );
    expect(d.run).toBe(true);
    expect(d.reasons).toHaveLength(3);
  });
});
