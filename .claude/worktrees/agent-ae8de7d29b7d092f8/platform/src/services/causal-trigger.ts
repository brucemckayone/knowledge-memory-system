/**
 * Conditional Causal Trigger (B07)
 *
 * Determines whether the causal reasoning agent should run after extract().
 * The agent only runs when there's sufficient signal — not on every ingest.
 *
 * Conditions (any one triggers):
 * (a) New facts involve entities that already have causal history in Graph C
 * (b) More than N facts were created in this ingest (configurable threshold)
 * (c) Explicit causal language markers detected in source text
 */

import { db } from '../db/index.js';
import { causalEvents } from '../db/schema.js';
import { inArray } from 'drizzle-orm';

export interface TriggerInput {
  sourceText: string;
  entityIds: string[];
  newFactCount: number;
}

export interface TriggerResult {
  shouldRun: boolean;
  reasons: string[];
}

/** Configurable threshold for condition (b) */
const FACT_COUNT_THRESHOLD = 3;

/** Causal language markers for condition (c) */
const CAUSAL_MARKERS = [
  'because',
  'caused by',
  'due to',
  'led to',
  'resulted in',
  'as a result',
  'which made',
  'therefore',
];

/**
 * Check condition (a): do any of the involved entities have existing causal history?
 */
async function hasExistingCausalHistory(entityIds: string[]): Promise<boolean> {
  if (entityIds.length === 0) return false;

  const events = await db
    .select({ id: causalEvents.id })
    .from(causalEvents)
    .where(inArray(causalEvents.subjectEntityId, entityIds))
    .limit(1);

  return events.length > 0;
}

/**
 * Check condition (b): were more than N facts created?
 */
function exceedsFactThreshold(newFactCount: number, threshold = FACT_COUNT_THRESHOLD): boolean {
  return newFactCount > threshold;
}

/**
 * Check condition (c): does the source text contain explicit causal language?
 */
export function containsCausalLanguage(text: string): boolean {
  const lower = text.toLowerCase();
  return CAUSAL_MARKERS.some(marker => lower.includes(marker));
}

/**
 * Evaluate whether the causal agent should run after this extraction.
 * Returns the decision and the reasons that triggered it.
 */
export async function shouldRunCausalAgent(
  input: TriggerInput,
  options: { factThreshold?: number } = {},
): Promise<TriggerResult> {
  const reasons: string[] = [];
  const { factThreshold = FACT_COUNT_THRESHOLD } = options;

  // Condition (c) — cheapest check first (no DB query)
  if (containsCausalLanguage(input.sourceText)) {
    reasons.push(`causal language detected in source text`);
  }

  // Condition (b) — cheap numeric check
  if (exceedsFactThreshold(input.newFactCount, factThreshold)) {
    reasons.push(`${input.newFactCount} facts created (threshold: ${factThreshold})`);
  }

  // Condition (a) — requires DB query, skip if already triggered
  if (reasons.length === 0 && input.entityIds.length > 0) {
    if (await hasExistingCausalHistory(input.entityIds)) {
      reasons.push(`entities have existing causal history`);
    }
  }

  return {
    shouldRun: reasons.length > 0,
    reasons,
  };
}
