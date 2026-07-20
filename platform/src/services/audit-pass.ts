/**
 * Cross-corpus audit pass orchestrator (bead nmemo-uhp.12.3, Phase B) — the
 * SECOND real MCP-driven pass, sibling to causal-pass.ts. It compares a SOURCE
 * corpus (e.g. a C codebase) against a TARGET corpus (e.g. a coding standard) and
 * lays down explained/sourced bridge_edges for the (element × rule) pairs that
 * genuinely relate.
 *
 * Mirrors causal-pass.ts's store-or-LLM seam: assemble a bounded scope from what
 * the graph already holds, push it to an injectable agent invoker (tests supply a
 * fake that stages directly — no LLM), then let bridge-promotion dispose whatever
 * staged. Run lifecycle + coverage live in audit-ledger.ts (resume-by-name).
 *
 * Two phases inside runAuditPass:
 *   1. RECALL-AT-SEED (deterministic, no LLM). recallCrossCorpusCandidates runs one
 *      cross-corpus vector query over entities.embedding — the SAME aligned vectors
 *      .14 authored (source + target both embed their description when
 *      EMBED_DESCRIPTIONS is on), so a code entity finds its candidate rule. Each
 *      surviving (element, rule) pair seeds a pending audit_coverage cell. Making
 *      recall a named, deterministic step (not an opaque tool call inside the agent)
 *      is deliberate: it is exactly what the .12.4 recall@k gate measures, and it
 *      keeps the sweep bounded and resumable.
 *   2. REASON-AT-SWEEP (LLM, per cell). Drain each pending cell: mint an
 *      invocation_id, push the pair to the audit agent (which reasons
 *      violates|satisfies|not_applicable, gathering source_references via its read
 *      tools, and calls propose_bridge_edge for a real verdict), applyBridgePromotion
 *      disposes the staged edge (D4 replay-idempotent), then stamp the coverage cell
 *      per the D6 fork (bridge → verdict + edge_id; nothing kept → not_applicable).
 *
 * The bead prose says "the agent recalls candidate rules"; this narrows it
 * faithfully — the PASS recalls the candidate set deterministically (the .14 lever),
 * and the agent adjudicates each candidate. Per-cell invocation is the simplest
 * correct spine (one invocation_id ⇒ one promotion idempotency token ⇒ one coverage
 * verdict); batching cells per source element is a later efficiency lift, not a
 * correctness need (spec 04 §2: build nothing before it is needed).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  createOrLoadAuditRun,
  seedCoverageUnits,
  nextPendingAuditUnit,
  stampCoverage,
  setAuditRunStatus,
  coverageProgress,
  type AuditUnit,
  type CoverageProgress,
} from './audit-ledger.js';
import { applyBridgePromotion } from './bridge-promotion.js';

function rows(result: unknown): Array<Record<string, unknown>> {
  return result as unknown as Array<Record<string, unknown>>;
}

// ============================================
// Recall-at-seed — the deterministic cross-corpus candidate query (.14 lever)
// ============================================

/** A recalled candidate bridge: a source element that vector-matches a target rule. */
export interface CandidatePair {
  elementRef: string; // source-corpus entity id
  ruleId: string; // target-corpus entity id (the rule/element being audited against)
  similarity: number;
}

export interface RecallOptions {
  /** Top-k target candidates PER source element (fan-out cap). */
  k?: number;
  /** Cosine-similarity floor; below this a pair is not a plausible candidate. */
  threshold?: number;
  /** Hard cap on total candidate pairs returned (never silent — logged when hit). */
  maxCells?: number;
}

/**
 * The cross-corpus recall step: for every source-corpus entity, the top-k
 * target-corpus entities by embedding proximity. One LATERAL query over the aligned
 * entities.embedding vectors — no re-embedding, no LLM. This is the function the
 * .12.4 recall@k gate calls directly to measure the EMBED_DESCRIPTIONS lift.
 */
export async function recallCrossCorpusCandidates(
  sourceCorpusId: string,
  targetCorpusId: string,
  opts: RecallOptions = {},
): Promise<CandidatePair[]> {
  const k = opts.k ?? 8;
  const threshold = opts.threshold ?? 0.5;
  const maxCells = opts.maxCells ?? 2000;

  const r = rows(
    await db.execute(sql`
      SELECT s.id::text AS element_ref,
             t.id::text  AS rule_id,
             (1 - (s.embedding <=> t.embedding)) AS similarity
      FROM public.entities s
      CROSS JOIN LATERAL (
        SELECT t2.id, t2.embedding
        FROM public.entities t2
        WHERE t2.corpus_id = ${targetCorpusId}
          AND t2.embedding IS NOT NULL
        ORDER BY t2.embedding <=> s.embedding
        LIMIT ${k}
      ) t
      WHERE s.corpus_id = ${sourceCorpusId}
        AND s.embedding IS NOT NULL
        AND (1 - (s.embedding <=> t.embedding)) >= ${threshold}
      ORDER BY s.id, similarity DESC
      LIMIT ${maxCells + 1}
    `),
  );

  const capped = r.length > maxCells;
  const kept = capped ? r.slice(0, maxCells) : r;
  if (capped) {
    console.warn(
      `[audit-pass] recall ${sourceCorpusId}→${targetCorpusId} hit maxCells=${maxCells}; ` +
        `truncated (raise maxCells or narrow the corpora to cover the tail)`,
    );
  }
  return kept.map((row) => ({
    elementRef: row.element_ref as string,
    ruleId: row.rule_id as string,
    similarity: Number(row.similarity),
  }));
}

/**
 * Concept-mediated recall (doc 19 §3.3) — the symbolic-JOIN candidate source that
 * AUGMENTS {@link recallCrossCorpusCandidates} (D-C7: the concept path never
 * replaces cosine). For every source-corpus element, the target-corpus rules that
 * share >=1 concept node via the exhibits/addresses bridge_edges family:
 *
 *   code --exhibits--> concept <--addresses-- rule
 *
 * No embedding — the shared concept node IS the bridge. Returns [] until concept
 * extraction has populated exhibits/addresses edges, so this composes as a pure
 * addition to the cosine set (zero behaviour change before extraction exists).
 *
 * `similarity` is 0 — a concept-derived cell carries no cosine colour; the union
 * in runAuditPass lets a cosine hit on the same cell supply the real value.
 */
export async function recallConceptCandidates(
  sourceCorpusId: string,
  targetCorpusId: string,
): Promise<CandidatePair[]> {
  const r = rows(
    await db.execute(sql`
      SELECT be_code.a_ref::text AS element_ref,
             be_rule.a_ref::text AS rule_id
      FROM public.bridge_edges be_code
      JOIN public.bridge_edges be_rule ON be_rule.b_ref = be_code.b_ref
      WHERE be_code.source_corpus_id = ${sourceCorpusId}
        AND be_code.relation = 'exhibits'  AND be_code.b_kind = 'entity' AND be_code.expired_at IS NULL
        AND be_rule.source_corpus_id = ${targetCorpusId}
        AND be_rule.relation = 'addresses' AND be_rule.b_kind = 'entity' AND be_rule.expired_at IS NULL
      GROUP BY be_code.a_ref, be_rule.a_ref
    `),
  );
  return r.map((row) => ({
    elementRef: row.element_ref as string,
    ruleId: row.rule_id as string,
    similarity: 0,
  }));
}

// ============================================
// The agent invoker seam (default = production; tests inject a fake)
// ============================================

/** The per-cell scope pushed to the audit agent — a pair to adjudicate + its context. */
export interface AuditCellScope {
  runId: string;
  invocationId: string;
  sourceCorpusId: string;
  targetCorpusId: string;
  similarity: number;
  element: { ref: string; name: string; type: string; description: string | null };
  rule: { ref: string; name: string; type: string; description: string | null };
}

/**
 * The seam runAuditPass injects (default = {@link defaultInvokeAuditAgent}). DB tests
 * supply a fake that writes staging_bridge_edges directly (via propose_bridge_edge),
 * exercising the dispose+stamp side without an LLM — mirrors causal-pass's
 * CausalAgentInvoker.
 */
export type AuditAgentInvoker = (scope: AuditCellScope) => Promise<void>;

/** Production invoker, bound lazily to avoid a static import of the large causal-agent module. */
const defaultInvokeAuditAgent: AuditAgentInvoker = async (scope) => {
  const { invokeAuditAgent } = await import('./causal-agent.js');
  await invokeAuditAgent(scope);
};

// ============================================
// runAuditPass
// ============================================

export interface RunAuditPassParams {
  /** Run name — resume-by-name (a re-run with the same name continues the sweep). */
  name: string;
  sourceCorpusId: string;
  targetCorpusId: string;
  /** Identifies the rule standard; a mismatch on resume throws (audit-ledger). */
  ruleSetHash: string;
  modelVersion?: string | null;
  recall?: RecallOptions;
}

export interface RunAuditPassOptions {
  /** Injectable agent invoker (default = invokeAuditAgent). Tests supply a fake. */
  invokeAuditAgent?: AuditAgentInvoker;
}

export interface RunAuditPassResult {
  runId: string;
  created: boolean;
  /** New pending cells seeded this call (0 on a fully-seeded resume). */
  seeded: number;
  /** Cells adjudicated this call (drained from pending). */
  swept: number;
  progress: CoverageProgress;
}

/** Slim entity row for scope assembly. */
interface EntityLite {
  ref: string;
  name: string;
  type: string;
  description: string | null;
}

async function loadEntities(ids: string[]): Promise<Map<string, EntityLite>> {
  const map = new Map<string, EntityLite>();
  if (ids.length === 0) return map;
  // sql.join builds an IN-list of bound params ($1, $2, …); a bare `${ids}` array
  // would expand to a tuple that ANY() rejects ("requires array on right side").
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const r = rows(
    await db.execute(sql`
      SELECT id::text AS id, canonical_name, entity_type, description
      FROM public.entities
      WHERE id::text IN (${idList})
    `),
  );
  for (const row of r) {
    map.set(row.id as string, {
      ref: row.id as string,
      name: (row.canonical_name as string) ?? '',
      type: (row.entity_type as string) ?? '',
      description: (row.description as string | null) ?? null,
    });
  }
  return map;
}

/**
 * The verdict stamped for a swept cell comes from PROVENANCE (D6 fork), read off
 * the canonical graph after promotion: a live bridge for this exact (element, rule)
 * pair means the agent asserted a real relation → verdict = the bridge's relation,
 * edge_id set; no bridge means "checked, nothing worth keeping" → not_applicable,
 * edge_id NULL.
 */
async function liveBridgeFor(
  elementRef: string,
  ruleId: string,
): Promise<{ edgeId: string; relation: string } | null> {
  const r = rows(
    await db.execute(sql`
      SELECT id::text AS id, relation
      FROM public.bridge_edges
      WHERE a_ref = ${elementRef}::uuid AND b_ref = ${ruleId}::uuid AND expired_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `),
  );
  if (r.length === 0) return null;
  return { edgeId: r[0]!.id as string, relation: r[0]!.relation as string };
}

/**
 * Run (or resume) a cross-corpus audit pass. Idempotent + resumable: seeding uses
 * ON CONFLICT DO NOTHING and the sweep drains pending cells, so a crashed/paused run
 * re-run under the same name continues exactly where it stopped (audit-ledger D4).
 */
export async function runAuditPass(
  params: RunAuditPassParams,
  opts: RunAuditPassOptions = {},
): Promise<RunAuditPassResult> {
  const { run, created } = await createOrLoadAuditRun({
    name: params.name,
    sourceCorpusId: params.sourceCorpusId,
    targetCorpusId: params.targetCorpusId,
    ruleSetHash: params.ruleSetHash,
    modelVersion: params.modelVersion ?? null,
  });
  await setAuditRunStatus(run.id, 'running');

  // 1. Recall-at-seed — deterministic cross-corpus candidate generation. Cosine
  // recall (the .14 lever) UNIONed with concept-JOIN recall (doc 19 §3.3, D-C7:
  // the symbolic path augments — never replaces — cosine). Deduped by cell; a
  // cosine hit supplies the similarity colour, concept-only cells keep 0.
  const conceptCandidates = await recallConceptCandidates(
    params.sourceCorpusId,
    params.targetCorpusId,
  );
  const cosineCandidates = await recallCrossCorpusCandidates(
    params.sourceCorpusId,
    params.targetCorpusId,
    params.recall,
  );
  const byCell = new Map<string, CandidatePair>();
  for (const c of conceptCandidates) byCell.set(`${c.elementRef} ${c.ruleId}`, c);
  for (const c of cosineCandidates) byCell.set(`${c.elementRef} ${c.ruleId}`, c);
  const candidates = [...byCell.values()];
  const units: AuditUnit[] = candidates.map((c) => ({ elementRef: c.elementRef, ruleId: c.ruleId }));
  const seeded = await seedCoverageUnits(run.id, units);
  // Similarity is scope colour for the agent prompt; index it for O(1) lookup.
  const simByCell = new Map<string, number>(
    candidates.map((c) => [`${c.elementRef} ${c.ruleId}`, c.similarity]),
  );

  // 2. Reason-at-sweep — drain pending cells, one invocation per cell.
  const invoke = opts.invokeAuditAgent ?? defaultInvokeAuditAgent;
  let swept = 0;
  for (;;) {
    const unit = await nextPendingAuditUnit(run.id);
    if (!unit) break;

    const invocationId = randomUUID();
    const ents = await loadEntities([unit.elementRef, unit.ruleId]);
    const element = ents.get(unit.elementRef) ?? {
      ref: unit.elementRef,
      name: '',
      type: '',
      description: null,
    };
    const rule = ents.get(unit.ruleId) ?? { ref: unit.ruleId, name: '', type: '', description: null };
    const scope: AuditCellScope = {
      runId: run.id,
      invocationId,
      sourceCorpusId: params.sourceCorpusId,
      targetCorpusId: params.targetCorpusId,
      similarity: simByCell.get(`${unit.elementRef} ${unit.ruleId}`) ?? 0,
      element,
      rule,
    };

    // Push to the agent (best-effort). A failed invocation leaves any staged edge for
    // the next resume; promotion + stamp below still run so a partial stage disposes.
    try {
      await invoke(scope);
    } catch (err) {
      console.warn(
        `[audit-pass] run=${run.id.slice(0, 8)} cell=(${unit.elementRef.slice(0, 8)},${unit.ruleId.slice(0, 8)}) ` +
          `agent invocation failed (${err instanceof Error ? err.message : String(err)}); disposing whatever staged`,
      );
    }

    // Dispose whatever the agent staged for this invocation (D4 replay-idempotent).
    await applyBridgePromotion(invocationId);

    // Stamp the coverage cell per the D6 fork (provenance-read from canonical).
    const bridge = await liveBridgeFor(unit.elementRef, unit.ruleId);
    if (bridge) {
      await stampCoverage({
        runId: run.id,
        elementRef: unit.elementRef,
        ruleId: unit.ruleId,
        verdict: bridge.relation as 'violates' | 'satisfies' | 'not_applicable',
        edgeId: bridge.edgeId,
        invocationId,
      });
    } else {
      await stampCoverage({
        runId: run.id,
        elementRef: unit.elementRef,
        ruleId: unit.ruleId,
        verdict: 'not_applicable',
        invocationId,
      });
    }
    swept += 1;
  }

  await setAuditRunStatus(run.id, 'completed');
  return { runId: run.id, created, seeded, swept, progress: await coverageProgress(run.id) };
}
