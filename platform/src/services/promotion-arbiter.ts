/**
 * Promotion-escalation arbiter seam (E5, doc 41 §8a.5, §12 #4).
 *
 * Promotion's first (pure) planning pass surfaces escalations the deterministic
 * backbone cannot settle — identity (a cluster word-prefix-matching ≥2 distinct
 * canonical entities) and conflict (an exclusive-group collision valid_at ordering
 * cannot break). This module turns each escalation into a {@link Verdict}:
 *
 *   1. REUSE a verdict already recorded for this epoch (the replay path — no LLM), OR
 *   2. push a focused DOSSIER to the arbiter (reconciliation_agent recast, Haiku),
 *      which records its decision via the propose_*_verdict tools, then read it back.
 *
 * The verdicts feed a SECOND, verdict-aware `planPromotion` pass (promotion.ts) —
 * "the arbiter decides; promotion executes." Dossiers are built PURELY from the
 * prior canonical + staged proposals promotion already loaded; the arbiter starts
 * informed and uses its live read-tools only to go deeper (doc 41 §8a.5).
 *
 * Replay determinism (doc 41 §12 #4): escalationKey is value-derived (independent of
 * proposal arrival order), so a replayed promotion of the same epoch finds the same
 * keys with their verdicts already recorded and reuses them without the LLM.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { arbiterVerdicts, type ArbiterVerdictRow } from '../db/schema.js';
import {
  escalationKey,
  type Escalation,
  type Verdict,
  type IdentityDecision,
  type PriorCanonical,
  type StagedProposals,
  type ResolvedRef,
} from './promotion-plan.js';

// ============================================
// Dossier — the focused context promotion pushes to the arbiter (§8a.5)
// ============================================

export interface IdentityDossier {
  escalationKey: string;
  kind: 'identity';
  reason: string;
  /** The short cluster name that word-prefix-matched several canonical entities. */
  clusterName: string;
  type: string;
  candidates: Array<{
    id: string;
    name: string;
    type: string;
    sampleFacts: Array<{ predicate: string; object: string | null; validAt: string | null }>;
  }>;
}

export interface ConflictDossier {
  escalationKey: string;
  kind: 'conflict';
  reason: string;
  exclusiveGroup: string;
  subject: { ref: ResolvedRef; name: string | null };
  facts: Array<{
    factId: string;
    origin: 'staged' | 'prior';
    predicate: string;
    object: string | null;
    validAt: string | null;
    reasoning: string | null;
  }>;
}

export type EscalationDossier = IdentityDossier | ConflictDossier;

/** Pushes dossiers to the arbiter; the arbiter records verdicts via its tools. */
export type ArbiterInvoker = (epochId: string, dossiers: EscalationDossier[]) => Promise<void>;

// ============================================
// Pure dossier construction (from prior + staged already in memory)
// ============================================

const entityName = (prior: PriorCanonical, id: string): string | null =>
  prior.entities.find((e) => e.id === id)?.name ?? null;

const SAMPLE_FACTS_PER_CANDIDATE = 8;

/** Build the dossier for one escalation — pure, no DB (doc 41 §8a.5). */
export function buildDossier(
  prior: PriorCanonical,
  staged: StagedProposals,
  esc: Escalation,
): EscalationDossier {
  const key = escalationKey(esc);
  if (esc.kind === 'identity') {
    const candidates = esc.candidateIds.map((id) => {
      const e = prior.entities.find((x) => x.id === id);
      const sampleFacts = prior.activeFacts
        .filter((f) => f.subjectEntityId === id)
        .slice(0, SAMPLE_FACTS_PER_CANDIDATE)
        .map((f) => ({
          predicate: f.predicate,
          object: f.objectValue ?? f.objectEntityId,
          validAt: f.validAt?.toISOString() ?? null,
        }));
      return { id, name: e?.name ?? '(unknown)', type: e?.type ?? esc.type, sampleFacts };
    });
    return {
      escalationKey: key,
      kind: 'identity',
      reason: esc.reason,
      clusterName: esc.clusterName,
      type: esc.type,
      candidates,
    };
  }

  const facts = esc.factIds.map((fid) => {
    const sf = staged.facts.find((f) => f.stagedFactId === fid);
    if (sf) {
      return {
        factId: fid,
        origin: 'staged' as const,
        predicate: sf.predicate,
        object: sf.objectValue ?? sf.objectHandle,
        validAt: sf.validAt?.toISOString() ?? null,
        reasoning: sf.reasoning,
      };
    }
    const pf = prior.activeFacts.find((f) => f.id === fid);
    return {
      factId: fid,
      origin: 'prior' as const,
      predicate: pf?.predicate ?? '(unknown)',
      object: pf?.objectValue ?? pf?.objectEntityId ?? null,
      validAt: pf?.validAt?.toISOString() ?? null,
      reasoning: null,
    };
  });
  return {
    escalationKey: key,
    kind: 'conflict',
    reason: esc.reason,
    exclusiveGroup: esc.exclusiveGroup,
    subject: {
      ref: esc.subjectRef,
      name: esc.subjectRef.kind === 'canonical' ? entityName(prior, esc.subjectRef.id) : null,
    },
    facts,
  };
}

// ============================================
// Verdict row → typed Verdict
// ============================================

/**
 * Reconstruct a {@link Verdict} from a stored row: the verdict JSONB holds the
 * decision fields, `kind` + `escalation_key` come from the row columns (so the
 * verdict tool need not echo them). Returns null for an undecided (verdict-null) row.
 */
export function rowToVerdict(row: ArbiterVerdictRow): Verdict | null {
  if (row.verdict == null) return null;
  const v = row.verdict as Record<string, unknown>;
  if (row.kind === 'identity') {
    return {
      kind: 'identity',
      escalationKey: row.escalationKey,
      members: Array.isArray(v.members) ? (v.members as string[]) : [],
      decision: (v.decision as IdentityDecision) ?? 'distinct',
      canonicalTarget: (v.canonicalTarget as string | null) ?? null,
      reasoning: (v.reasoning as string) ?? '',
    };
  }
  return {
    kind: 'conflict',
    escalationKey: row.escalationKey,
    expire: Array.isArray(v.expire) ? (v.expire as Array<{ factId: string; reason: string }>) : [],
    correctedValidAt: (v.correctedValidAt as Record<string, string> | null) ?? null,
    notExclusive: v.notExclusive === true,
    reasoning: (v.reasoning as string) ?? '',
  };
}

// ============================================
// resolveEscalations — store-or-arbiter, with replay reuse
// ============================================

export async function resolveEscalations(
  epochId: string,
  prior: PriorCanonical,
  staged: StagedProposals,
  escalations: Escalation[],
  opts: { invokeArbiter?: ArbiterInvoker } = {},
): Promise<Verdict[]> {
  if (escalations.length === 0) return [];
  const keys = escalations.map(escalationKey);

  // 1. Replay path — reuse verdicts already recorded for this epoch (no LLM).
  const existing = await db
    .select()
    .from(arbiterVerdicts)
    .where(and(eq(arbiterVerdicts.epochId, epochId), inArray(arbiterVerdicts.escalationKey, keys)));
  const decided = new Map<string, Verdict>();
  for (const row of existing) {
    const v = rowToVerdict(row);
    if (v) decided.set(row.escalationKey, v);
  }

  // 2. Undecided escalations → pre-record dossier, invoke the arbiter, read back.
  const undecided = escalations.filter((e) => !decided.has(escalationKey(e)));
  if (undecided.length > 0) {
    const dossiers = undecided.map((e) => buildDossier(prior, staged, e));
    for (const d of dossiers) {
      // Pre-record the dossier (verdict null) so a verdict tool has a row to fill
      // and a retry is idempotent ((epoch_id, escalation_key) is unique).
      await db
        .insert(arbiterVerdicts)
        .values({ epochId, escalationKey: d.escalationKey, kind: d.kind, dossier: d })
        .onConflictDoNothing();
    }
    const invokeArbiter = opts.invokeArbiter ?? defaultInvokeArbiter;
    try {
      await invokeArbiter(epochId, dossiers);
    } catch (err) {
      // The arbiter is best-effort: a failure leaves the conservative default in
      // place (the graph still promotes deterministically — doc 41 §12 #9).
      console.warn(
        `[promotion] arbiter invocation failed (${(err as Error).message}); ` +
          `keeping conservative defaults for ${undecided.length} escalation(s)`,
      );
    }
    const after = await db
      .select()
      .from(arbiterVerdicts)
      .where(
        and(
          eq(arbiterVerdicts.epochId, epochId),
          inArray(arbiterVerdicts.escalationKey, undecided.map(escalationKey)),
        ),
      );
    for (const row of after) {
      const v = rowToVerdict(row);
      if (v) decided.set(row.escalationKey, v);
    }
  }

  const stillUndecided = escalations.length - decided.size;
  if (stillUndecided > 0) {
    console.warn(
      `[promotion] epoch=${epochId.slice(0, 8)} ${stillUndecided}/${escalations.length} ` +
        `escalation(s) left to conservative default (no arbiter verdict)`,
    );
  }
  return [...decided.values()];
}

// ============================================
// Default arbiter invoker — wired in E5 Task #7 (reconciliation_agent recast)
// ============================================

/**
 * The production arbiter invocation (recast `invokeReconciliationAgent`): pushes the
 * dossiers to the Haiku arbiter via ml-services; the agent records verdicts through
 * the propose_*_verdict tools. Implemented in {@link ./causal-agent.js} and bound
 * here lazily to avoid a static import cycle.
 */
const defaultInvokeArbiter: ArbiterInvoker = async (epochId, dossiers) => {
  const { invokeArbiterAgent } = await import('./causal-agent.js');
  await invokeArbiterAgent(epochId, dossiers);
};
