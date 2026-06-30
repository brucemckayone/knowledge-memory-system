/**
 * Causal pass orchestrator (DB layer) — the post-promotion, conditional, delta-scoped
 * seam (doc 41 §6, §8a.6, §12 #6; bead nmemo-vpz.6 / E6). Mirrors promotion-arbiter's
 * store-or-LLM seam: assemble inputs from what promotion already produced, evaluate
 * the pure trigger, push a bounded scope to the agent (injectable for tests), then let
 * causal-promotion dispose whatever the agent staged.
 *
 * Called AFTER promote() returns — never inside it — so promote() stays deterministic
 * and replayable; the causal pass is the one agent that reads live canonical, correctly,
 * because it runs when the graph is clean and settled (doc 41 §6).
 */

import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { causalEvents, type CausalEvent, type CausalEdge } from '../db/schema.js';
import { getEntityCausalHistory } from './causal.js';
import { applyCausalPromotion, type CausalPromotionResult } from './causal-promotion.js';
import { shouldRunCausalPass, type CausalTriggerDecision } from './causal-pass-trigger.js';
import type { PromotionResult } from './promotion.js';
import type { CausalAgentInvoker } from './causal-agent.js';

// ============================================
// Scope — the bounded settled subgraph pushed to the agent (doc 41 §6, §8a.6)
// ============================================

/** A causal event, slimmed to what the agent reasons over (no embeddings/blobs). */
interface ScopeEvent {
  id: string;
  factId: string | null;
  transitionType: string;
  subjectEntityId: string | null;
  predicate: string | null;
  occurredAt: string | null;
  sourceText: string | null;
}

/** An existing causal edge in the neighbourhood (existing structure the agent must respect). */
interface ScopeEdge {
  id: string;
  causeEventId: string;
  effectEventId: string;
  reasoning: string;
}

export interface CausalScope {
  epochId: string;
  /** Events minted by THIS promotion — the new transitions to reason over. */
  newEvents: ScopeEvent[];
  /** Prior causal events on the touched entities — the existing timeline. */
  neighbourhoodEvents: ScopeEvent[];
  /** Prior active causal edges among the neighbourhood — the existing structure. */
  neighbourhoodEdges: ScopeEdge[];
  /** True when the scope hit CAUSAL_PASS_SCOPE_CAP and was truncated (never silent). */
  capped: boolean;
}

export interface CausalPassResult {
  epochId: string;
  decision: CausalTriggerDecision;
  ran: boolean;
  /** Events pushed to the agent (new + neighbourhood), when it ran. */
  scopeSize?: number;
  /** What causal-promotion disposed, when it ran. */
  promotion?: CausalPromotionResult;
}

const toScopeEvent = (e: CausalEvent): ScopeEvent => ({
  id: e.id,
  factId: e.factId ?? null,
  transitionType: e.transitionType,
  subjectEntityId: e.subjectEntityId ?? null,
  predicate: e.predicate ?? null,
  occurredAt: e.occurredAt ? e.occurredAt.toISOString() : null,
  sourceText: e.sourceText ?? null,
});

const toScopeEdge = (e: CausalEdge): ScopeEdge => ({
  id: e.id,
  causeEventId: e.causeEventId,
  effectEventId: e.effectEventId,
  reasoning: e.reasoning,
});

/** Production invoker, bound lazily to avoid a static import of the large causal-agent module. */
const defaultInvokeCausalAgent: CausalAgentInvoker = async (epochId, scope) => {
  const { invokeCausalAgent } = await import('./causal-agent.js');
  await invokeCausalAgent(epochId, scope);
};

export interface RunCausalPassOptions {
  /** Injectable agent invoker (default = invokeCausalAgent). Tests supply a fake. */
  invokeCausalAgent?: CausalAgentInvoker;
}

/**
 * Run the causal pass for one epoch's promotion (doc 41 §6). Conditional + delta-scoped:
 *   1. load the minted (settled) events,
 *   2. gather each touched entity's causal neighbourhood (and whether it has prior history),
 *   3. evaluate the pure trigger — skip unless (a) causal language, (b) ≥N facts, or (c) history,
 *   4. push a capped scope to the agent (best-effort),
 *   5. dispose whatever it staged via applyCausalPromotion.
 */
export async function runCausalPass(
  epochId: string,
  promotion: PromotionResult,
  opts: RunCausalPassOptions = {},
): Promise<CausalPassResult> {
  // No settled transitions → nothing causal to reason about; skip without a query.
  if (promotion.mintedCausalEventIds.length === 0) {
    return { epochId, decision: { run: false, reasons: [] }, ran: false };
  }

  // 1. The minted (settled) events — the new transitions the pass reasons over.
  const newEventRows = await db
    .select()
    .from(causalEvents)
    .where(inArray(causalEvents.id, promotion.mintedCausalEventIds));

  // 2. Touched entities = subjects of the minted events. Cap how many we probe.
  const touchedEntityIds = [
    ...new Set(newEventRows.map((e) => e.subjectEntityId).filter((id): id is string => !!id)),
  ].slice(0, config.CAUSAL_PASS_SCOPE_CAP);

  // 3. Neighbourhood — each touched entity's PRIOR causal events + edges. Any existing
  //    edge (only the causal pass creates edges) means prior causal history (trigger c).
  const mintedSet = new Set(promotion.mintedCausalEventIds);
  const neighbourhoodEventsById = new Map<string, CausalEvent>();
  const neighbourhoodEdgesById = new Map<string, CausalEdge>();
  let touchedEntityHasCausalHistory = false;
  for (const entityId of touchedEntityIds) {
    const { events, edges } = await getEntityCausalHistory(entityId);
    if (edges.length > 0) touchedEntityHasCausalHistory = true;
    for (const ev of events) {
      if (!mintedSet.has(ev.id)) neighbourhoodEventsById.set(ev.id, ev); // exclude the new ones
    }
    for (const ed of edges) neighbourhoodEdgesById.set(ed.id, ed);
  }

  // 4. Trigger (doc 41 §12 #6). Source text = the promoted grounding text carried on
  //    the minted events (proposer reasoning / expiry+corroboration reasons); scanning
  //    raw source memories is a hardening refinement.
  const sourceTexts = newEventRows.map((e) => e.sourceText).filter((t): t is string => !!t);
  const promotedFactCount = promotion.insertedFactIds.length + promotion.corroboratedFactIds.length;
  const decision = shouldRunCausalPass(
    { promotedFactCount, sourceTexts, touchedEntityHasCausalHistory },
    { factThreshold: config.CAUSAL_PASS_FACT_THRESHOLD },
  );

  if (!decision.run) {
    return { epochId, decision, ran: false };
  }

  // 5. Assemble the capped scope. The cap counts events (new first, then neighbourhood);
  //    edges ride along with the neighbourhood they connect.
  const cap = config.CAUSAL_PASS_SCOPE_CAP;
  const newEvents = newEventRows.slice(0, cap).map(toScopeEvent);
  const remaining = Math.max(0, cap - newEvents.length);
  const neighbourhoodAll = [...neighbourhoodEventsById.values()];
  const neighbourhoodEvents = neighbourhoodAll.slice(0, remaining).map(toScopeEvent);
  const capped = newEventRows.length + neighbourhoodAll.length > cap;
  if (capped) {
    console.warn(
      `[causal-pass] epoch=${epochId.slice(0, 8)} scope hit cap ${cap} ` +
        `(${newEventRows.length} new + ${neighbourhoodAll.length} neighbourhood events); truncated`,
    );
  }
  const scope: CausalScope = {
    epochId,
    newEvents,
    neighbourhoodEvents,
    neighbourhoodEdges: [...neighbourhoodEdgesById.values()].map(toScopeEdge),
    capped,
  };

  // 6. Push to the agent (best-effort). A failed invocation leaves any staged edges for
  //    the next pass; promotion already committed (doc 41 §12 #9).
  const invoke = opts.invokeCausalAgent ?? defaultInvokeCausalAgent;
  try {
    await invoke(epochId, scope);
  } catch (err) {
    console.warn(
      `[causal-pass] epoch=${epochId.slice(0, 8)} agent invocation failed ` +
        `(${err instanceof Error ? err.message : String(err)}); disposing whatever staged`,
    );
  }

  // 7. Dispose whatever the agent staged into causal_edges.
  const promotionResult = await applyCausalPromotion(epochId);

  return {
    epochId,
    decision,
    ran: true,
    scopeSize: newEvents.length + neighbourhoodEvents.length,
    promotion: promotionResult,
  };
}
