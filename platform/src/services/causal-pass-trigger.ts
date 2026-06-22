/**
 * Causal-pass trigger — the pure, DB-free predicate that decides whether the
 * post-promotion causal pass runs for one promotion (doc 41 §6, §12 #6; bead
 * nmemo-vpz.6 / E6).
 *
 * The pass is conditional (doc 04 triggers) so it stays bounded — a single informed
 * pass over the delta, not a full re-reason. It runs if ANY of:
 *   (a) explicit causal language in the promoted source text(s),
 *   (b) the promotion settled at least N facts (config),
 *   (c) a touched entity already has prior causal history.
 *
 * Criterion (c) is inherently a DB question; `causal-pass.ts` (the DB layer) answers
 * it once and passes the boolean in, so this predicate stays pure and unit-testable
 * with zero infra (the promotion-plan.ts discipline). Never imports the DB pool.
 */

/**
 * Causal cue words/phrases. Conservative + lowercase; matched as plain substrings
 * (case-insensitive) over the promoted source text. The list is intentionally narrow
 * — a false negative just skips a pass the next delta can still catch via (b)/(c),
 * whereas a false positive wastes an LLM call. Tighten/extend during hardening.
 */
const CAUSAL_CUES = [
  'because',
  'caused',
  'cause of',
  'led to',
  'leading to',
  'due to',
  'resulted in',
  'result of',
  'as a result',
  'triggered',
  'enabled',
  'drove',
  'prompted',
  'consequently',
  'therefore',
  'thanks to',
  'owing to',
  'in order to',
  'so that',
  'gave rise to',
  'brought about',
  'contributed to',
  'sparked',
];

/** True if the text contains an explicit causal cue (pure, case-insensitive). */
export function hasCausalLanguage(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return CAUSAL_CUES.some((cue) => t.includes(cue));
}

export interface CausalTriggerSignals {
  /** Facts this promotion settled (inserted + corroborated active facts). */
  promotedFactCount: number;
  /** Source text(s) behind the promoted facts — scanned for causal language. */
  sourceTexts: string[];
  /** Precomputed by the DB layer: does any touched entity have prior causal edges? */
  touchedEntityHasCausalHistory: boolean;
}

export interface CausalTriggerConfig {
  /** Trigger (b) threshold N (config.CAUSAL_PASS_FACT_THRESHOLD). */
  factThreshold: number;
}

export interface CausalTriggerDecision {
  run: boolean;
  /** Which triggers fired (for logging). Empty iff run === false. */
  reasons: string[];
}

/**
 * Evaluate the conditional trigger (doc 41 §12 #6). Pure: same signals + config
 * always yield the same decision. Records every reason that fired so the caller can
 * log WHY the pass ran (or that it was skipped).
 */
export function shouldRunCausalPass(
  signals: CausalTriggerSignals,
  config: CausalTriggerConfig,
): CausalTriggerDecision {
  const reasons: string[] = [];
  if (signals.sourceTexts.some(hasCausalLanguage)) {
    reasons.push('causal language in promoted source text');
  }
  if (signals.promotedFactCount >= config.factThreshold) {
    reasons.push(`promoted-fact count ${signals.promotedFactCount} >= threshold ${config.factThreshold}`);
  }
  if (signals.touchedEntityHasCausalHistory) {
    reasons.push('a touched entity has prior causal history');
  }
  return { run: reasons.length > 0, reasons };
}
