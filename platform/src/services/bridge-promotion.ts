/**
 * Bridge-promotion (cross-corpus Phase A, bead nmemo-uhp.9). The apply side of the
 * audit pass's disposal. Mirrors causal-promotion.ts: a PURE planner
 * ({@link planBridgePromotion}) decides create-vs-corroborate-vs-drop, and
 * {@link applyBridgePromotion} loads the inputs the planner needs, plans, and applies
 * the result in a single transaction.
 *
 * A bridge is a saved, reasoned, sourced connection between an element in one corpus
 * and an element in another (a code element VIOLATES a rule, etc.). It reuses the
 * causal-edge row shape wholesale (NOT-NULL reasoning + source_references, partial-unique
 * dedup while live, corroborate-or-insert, stale_citation flag).
 *
 * Two rules that make bridges different from causal edges (spec §3/§4, D1/D4):
 *   - Endpoints are POLYMORPHIC UUIDs validated at disposal against the element
 *     catalogs (code_elements / rule_elements), NOT by FK. A staged row whose a_ref or
 *     b_ref is not in the catalog is DROPPED ('unresolved endpoint').
 *   - Corroboration is replay-idempotent INCLUDING corroboration_count (D4). The
 *     bridge_edges.invocation_id column is the idempotency token (the mig-034
 *     invocation_id UPSERT model that mig 051 also codifies for causal edges): a given
 *     invocation bumps a given edge at most once, so re-running applyBridgePromotion on
 *     the SAME staging leaves the count unchanged. See {@link applyBridgePromotion}.
 *
 * The doc-01 invariant (non-empty reasoning + source_references) is enforced three
 * times over: the staging_bridge_edges CHECKs (mig 054) on the way in, this module's
 * create loop re-validates, and the bridge_edges CHECKs reject on the way out.
 */

import { db, type Tx } from '../db/index.js';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import {
  bridgeEdges,
  bridgeSourceRefs,
  stagingBridgeEdges,
  codeElements,
  ruleElements,
  facts as factsTable,
} from '../db/schema.js';
import { jsonbLiteral, unwrapRows } from './audit.js';

/** The two polymorphic endpoint kinds (mirrors the bridge_edges a_kind/b_kind CHECK). */
export type ElementKind = 'code_element' | 'rule_element';

/**
 * A source reference on a bridge edge. Wider than the causal `SourceReference`:
 * `type` may name a catalog element and `relevance` is a numeric score (the
 * bridge_source_refs.relevance FLOAT column), not the causal free-text string.
 */
export interface BridgeSourceReference {
  type: string;
  id: string;
  relevance?: number | string | null;
}

/** A staged bridge edge, scoped from a `staging_bridge_edges` row. */
export interface StagedBridgeEdge {
  stagedEdgeId: string;
  aKind: ElementKind;
  aRef: string;
  bKind: ElementKind;
  bRef: string;
  sourceCorpusId: string;
  targetCorpusId: string;
  relation: string;
  severity: string | null;
  category: string | null;
  codeLocation: unknown;
  reasoning: string;
  sourceReferences: BridgeSourceReference[];
  strength: number;
}

/** A live prior bridge, scoped for the dedup-key lookup. */
export interface PriorBridge {
  id: string;
  aRef: string;
  bRef: string;
  relation: string;
}

/** A staged edge that survives disposal and will be INSERTed to canonical. */
export interface PlannedBridgeCreate {
  stagedEdgeId: string;
  staged: StagedBridgeEdge;
  /** true = cites an invalidated fact; stamped onto the fresh row (never repointed). */
  staleCitation: boolean;
  /** Why it is stale (which invalidated fact ids); null when not stale. */
  staleReason: string | null;
}

/** A staged edge whose (a_ref, b_ref, relation) matches a live prior → corroborate. */
export interface PlannedBridgeCorroborate {
  stagedEdgeId: string;
  priorEdgeId: string;
}

/** A staged edge dropped during disposal, with the reason (for logging/audit). */
export interface DroppedBridgeEdge {
  stagedEdgeId: string;
  reason: string;
}

export interface BridgePromotionPlan {
  create: PlannedBridgeCreate[];
  corroborate: PlannedBridgeCorroborate[];
  drop: DroppedBridgeEdge[];
}

export interface BridgePromotionResult {
  invocationId: string;
  /** Edges freshly INSERTed to canonical, with whether stale_citation was stamped. */
  created: Array<{ stagedEdgeId: string; edgeId: string; staleCitation: boolean }>;
  /** Staged rows that matched a live prior; `bumped` is false on an idempotent replay. */
  corroborated: Array<{ stagedEdgeId: string; edgeId: string; bumped: boolean }>;
  /** Staged rows dropped before write (unresolved endpoint or empty invariant). */
  dropped: DroppedBridgeEdge[];
}

/** Corroboration strength bump per re-assertion (mirrors causal.ts; capped at 1.0). */
const CORROBORATION_STRENGTH_DELTA = 0.05;

/** ref_types the bridge_source_refs CHECK admits — others are skipped at denorm. */
const BRIDGE_REF_TYPES = new Set(['fact', 'memory', 'code_element', 'rule_element']);

/** Stable dedup key for a bridge: one live edge per (a_ref, b_ref, relation). */
function bridgeKey(aRef: string, bRef: string, relation: string): string {
  return `${aRef}|${bRef}|${relation}`;
}

/**
 * Pure, DB-free disposal planner (spec §4). Given the live prior bridges, the staged
 * proposals, the resolved-endpoint catalog set, and the set of invalidated cited fact
 * ids, computes which edges to create (with the stale-citation flag), which to
 * corroborate, and which to drop. No DB, no mutation — same inputs always yield the
 * same plan, so the unit tests need zero infra.
 *
 * Per staged edge, in order:
 *   1. endpoint-resolve  DROP ('unresolved endpoint') if a_ref or b_ref is NOT in the
 *                        catalog set (validated vs code_elements/rule_elements at
 *                        disposal, D1 — never by FK).
 *   2. stale-citation    FLAG (never repoint) if any cited FACT ref is invalidated.
 *   3. dedup             a live prior on (a_ref, b_ref, relation) → CORROBORATE; else
 *                        → CREATE, carrying the stale flag onto the fresh row.
 *
 * `catalogRefs` is the caller's kind-checked resolution pool (code/rule element_refs
 * are drawn from disjoint uuidV5 namespaces, so a flat set is unambiguous).
 * `invalidatedFactIds` is conservative: a cited fact absent from `facts` is treated as
 * invalidated (flag it rather than silently trust a vanished citation).
 */
export function planBridgePromotion(
  prior: PriorBridge[],
  staged: StagedBridgeEdge[],
  catalogRefs: ReadonlySet<string>,
  invalidatedFactIds: ReadonlySet<string>,
): BridgePromotionPlan {
  const priorByKey = new Map<string, string>();
  for (const p of prior) {
    priorByKey.set(bridgeKey(p.aRef, p.bRef, p.relation), p.id);
  }

  const create: PlannedBridgeCreate[] = [];
  const corroborate: PlannedBridgeCorroborate[] = [];
  const drop: DroppedBridgeEdge[] = [];

  for (const e of staged) {
    // (1) endpoint-resolve vs the catalogs (D1) — NOT FK.
    const aOk = catalogRefs.has(e.aRef);
    const bOk = catalogRefs.has(e.bRef);
    if (!aOk || !bOk) {
      const missing = [
        aOk ? null : `a_ref ${e.aRef} (${e.aKind})`,
        bOk ? null : `b_ref ${e.bRef} (${e.bKind})`,
      ]
        .filter(Boolean)
        .join(', ');
      drop.push({ stagedEdgeId: e.stagedEdgeId, reason: `unresolved endpoint: ${missing}` });
      continue;
    }

    // (2) stale-citation — flag only, never repoint (mirrors the causal §6 branch).
    const invalidated = [
      ...new Set(
        e.sourceReferences.filter((r) => r.type === 'fact' && invalidatedFactIds.has(r.id)).map((r) => r.id),
      ),
    ].sort();
    const staleCitation = invalidated.length > 0;
    const staleReason = staleCitation
      ? `cites invalidated fact(s): ${invalidated.join(', ')} — re-ground or expire next pass (never auto-repointed)`
      : null;

    // (3) dedup key → corroborate vs create.
    const priorEdgeId = priorByKey.get(bridgeKey(e.aRef, e.bRef, e.relation));
    if (priorEdgeId) {
      corroborate.push({ stagedEdgeId: e.stagedEdgeId, priorEdgeId });
    } else {
      create.push({ stagedEdgeId: e.stagedEdgeId, staged: e, staleCitation, staleReason });
    }
  }

  // Canonical sort so the plan is order-independent by value (mirrors planCausalPromotion).
  const byId = (a: { stagedEdgeId: string }, b: { stagedEdgeId: string }) =>
    a.stagedEdgeId < b.stagedEdgeId ? -1 : 1;
  return {
    create: create.sort(byId),
    corroborate: corroborate.sort(byId),
    drop: drop.sort(byId),
  };
}

/**
 * Does the element catalog hold `ref` under `kind`? Checks code_elements for
 * 'code_element' and rule_elements for 'rule_element' (the D1 disposal-time
 * endpoint check; the catalogs are the resolution pool, never entities).
 */
export async function catalogHas(ref: string, kind: ElementKind): Promise<boolean> {
  const table = kind === 'code_element' ? codeElements : ruleElements;
  const found = await db
    .select({ ref: table.elementRef })
    .from(table)
    .where(eq(table.elementRef, ref))
    .limit(1);
  return found.length > 0;
}

/**
 * Build the resolved-endpoint set the pure planner validates against: every staged
 * a_ref/b_ref that its declared kind actually resolves to in the catalogs. Two bulk
 * lookups (the set form of {@link catalogHas}), scoped by kind.
 */
async function resolveCatalogRefs(staged: StagedBridgeEdge[]): Promise<Set<string>> {
  const codeRefs = new Set<string>();
  const ruleRefs = new Set<string>();
  for (const e of staged) {
    (e.aKind === 'code_element' ? codeRefs : ruleRefs).add(e.aRef);
    (e.bKind === 'code_element' ? codeRefs : ruleRefs).add(e.bRef);
  }

  const resolved = new Set<string>();
  if (codeRefs.size > 0) {
    const rows = await db
      .select({ ref: codeElements.elementRef })
      .from(codeElements)
      .where(inArray(codeElements.elementRef, [...codeRefs]));
    for (const r of rows) resolved.add(r.ref);
  }
  if (ruleRefs.size > 0) {
    const rows = await db
      .select({ ref: ruleElements.elementRef })
      .from(ruleElements)
      .where(inArray(ruleElements.elementRef, [...ruleRefs]));
    for (const r of rows) resolved.add(r.ref);
  }
  return resolved;
}

/**
 * The set of cited FACT ids that are invalidated. Conservative (mirrors
 * causal-promotion): a cited fact absent from `facts` counts as invalidated, and a
 * fact with `invalid_at` set counts; a superseded/active fact does not.
 */
async function loadInvalidatedFactIds(staged: StagedBridgeEdge[]): Promise<Set<string>> {
  const citedFactIds = [
    ...new Set(staged.flatMap((e) => e.sourceReferences.filter((r) => r.type === 'fact').map((r) => r.id))),
  ];
  // Start pessimistic — every cited fact is invalidated until the DB proves it live.
  const invalidated = new Set<string>(citedFactIds);
  if (citedFactIds.length === 0) return invalidated;

  const rows = await db
    .select({ id: factsTable.id, invalidAt: factsTable.invalidAt })
    .from(factsTable)
    .where(inArray(factsTable.id, citedFactIds));
  for (const f of rows) {
    if (!f.invalidAt) invalidated.delete(f.id); // present and not invalidated → live
  }
  return invalidated;
}

/**
 * Denormalise an edge's `source_references` array into bridge_source_refs. Skips items
 * whose `type` is not one of the four the ref_type CHECK admits; coerces relevance to
 * the FLOAT column (numeric score or NULL). Called once per FRESH create — never on
 * corroboration (the synthetic PK can't ON CONFLICT-dedup, and the create path only
 * runs when the edge is genuinely new, so the reverse index stays replay-clean).
 */
async function denormalizeSourceRefs(
  tx: Tx,
  edgeId: string,
  refs: BridgeSourceReference[],
): Promise<void> {
  const valid = refs.filter(
    (r) => r && typeof r.type === 'string' && BRIDGE_REF_TYPES.has(r.type) && typeof r.id === 'string' && r.id.length > 0,
  );
  if (valid.length === 0) return;
  await tx.insert(bridgeSourceRefs).values(
    valid.map((r) => ({
      bridgeEdgeId: edgeId,
      refType: r.type,
      refId: r.id,
      relevance: typeof r.relevance === 'number' && Number.isFinite(r.relevance) ? r.relevance : null,
    })),
  );
}

/**
 * Apply bridge-promotion for one invocation (spec §4). Loads the staged rows, gathers
 * the inputs the pure planner needs (resolved catalog endpoints + invalidated cited
 * facts + live priors), plans, then disposes the plan in ONE transaction: fresh creates
 * are INSERTed (with the stale flag stamped and source_references denormalised), and
 * matched priors are corroborated.
 *
 * D4 (replay-idempotency incl. aggregates): corroboration is keyed on the
 * bridge_edges.invocation_id token. Every create stamps invocation_id = invocationId,
 * and every corroboration bumps ONLY `WHERE invocation_id IS DISTINCT FROM invocationId`
 * (setting it to invocationId when it bumps). So re-running applyBridgePromotion on the
 * SAME staging finds every edge already stamped with this invocation and bumps nothing —
 * the row set AND corroboration_count are unchanged. This is the mig-034 invocation_id
 * UPSERT model, the same replay-safe corroboration mig 051 gave causal_edges (whose
 * ledger keys on the staged-row id instead, because causal_edges has no invocation_id
 * column). A genuinely new invocation still corroborates once.
 */
export async function applyBridgePromotion(invocationId: string): Promise<BridgePromotionResult> {
  // 1. Load this invocation's staged rows.
  const rows = await db
    .select({
      id: stagingBridgeEdges.id,
      aKind: stagingBridgeEdges.aKind,
      aRef: stagingBridgeEdges.aRef,
      bKind: stagingBridgeEdges.bKind,
      bRef: stagingBridgeEdges.bRef,
      sourceCorpusId: stagingBridgeEdges.sourceCorpusId,
      targetCorpusId: stagingBridgeEdges.targetCorpusId,
      relation: stagingBridgeEdges.relation,
      severity: stagingBridgeEdges.severity,
      category: stagingBridgeEdges.category,
      codeLocation: stagingBridgeEdges.codeLocation,
      reasoning: stagingBridgeEdges.reasoning,
      sourceReferences: stagingBridgeEdges.sourceReferences,
      strength: stagingBridgeEdges.strength,
    })
    .from(stagingBridgeEdges)
    .where(eq(stagingBridgeEdges.invocationId, invocationId));

  if (rows.length === 0) {
    return { invocationId, created: [], corroborated: [], dropped: [] };
  }

  const staged: StagedBridgeEdge[] = rows.map((r) => ({
    stagedEdgeId: r.id,
    aKind: r.aKind as ElementKind,
    aRef: r.aRef,
    bKind: r.bKind as ElementKind,
    bRef: r.bRef,
    sourceCorpusId: r.sourceCorpusId,
    targetCorpusId: r.targetCorpusId,
    relation: r.relation,
    severity: r.severity ?? null,
    category: r.category ?? null,
    codeLocation: r.codeLocation ?? null,
    reasoning: r.reasoning,
    sourceReferences: (r.sourceReferences as BridgeSourceReference[]) ?? [],
    strength: r.strength,
  }));

  // 2. Gather planner inputs (committed reads — no shared tx, per D4).
  const [catalogRefs, invalidatedFactIds] = await Promise.all([
    resolveCatalogRefs(staged),
    loadInvalidatedFactIds(staged),
  ]);

  // 3. Live priors, scoped to the staged a_refs, for the dedup-key lookup.
  const stagedARefs = [...new Set(staged.map((e) => e.aRef))];
  const priorRows = await db
    .select({
      id: bridgeEdges.id,
      aRef: bridgeEdges.aRef,
      bRef: bridgeEdges.bRef,
      relation: bridgeEdges.relation,
    })
    .from(bridgeEdges)
    .where(and(isNull(bridgeEdges.expiredAt), inArray(bridgeEdges.aRef, stagedARefs)));
  const prior: PriorBridge[] = priorRows.map((p) => ({
    id: p.id,
    aRef: p.aRef,
    bRef: p.bRef,
    relation: p.relation,
  }));

  // 4. Pure plan.
  const plan = planBridgePromotion(prior, staged, catalogRefs, invalidatedFactIds);

  const created: BridgePromotionResult['created'] = [];
  const corroborated: BridgePromotionResult['corroborated'] = [];
  const dropped: DroppedBridgeEdge[] = [...plan.drop];

  // 5. Dispose in a single transaction (no per-edge side effects, unlike causal).
  await db.transaction(async (tx) => {
    for (const c of plan.create) {
      const s = c.staged;
      // Re-validate the doc-01 invariant (reject/skip empty — mirrors the staging
      // CHECKs and createCausalEdge). The bridge_edges CHECKs would reject anyway;
      // dropping here keeps the summary honest instead of aborting the whole tx.
      if (
        !s.reasoning ||
        s.reasoning.trim().length === 0 ||
        !Array.isArray(s.sourceReferences) ||
        s.sourceReferences.length === 0
      ) {
        dropped.push({
          stagedEdgeId: c.stagedEdgeId,
          reason: 'empty reasoning or source_references (rejected at disposal)',
        });
        continue;
      }

      const codeLocation =
        s.codeLocation == null ? sql`NULL::jsonb` : jsonbLiteral(s.codeLocation);
      // ON CONFLICT against the partial-unique dedup index. A within-batch dup (two
      // staged rows on the same live key, neither in the prior snapshot) hits this and
      // is skipped rather than double-inserted.
      const inserted = await tx.execute(sql`
        INSERT INTO public.bridge_edges (
          a_kind, a_ref, b_kind, b_ref,
          source_corpus_id, target_corpus_id, relation,
          severity, category, code_location,
          reasoning, source_references,
          strength, stale_citation, stale_reason, invocation_id
        ) VALUES (
          ${s.aKind}, ${s.aRef}::uuid, ${s.bKind}, ${s.bRef}::uuid,
          ${s.sourceCorpusId}, ${s.targetCorpusId}, ${s.relation},
          ${s.severity ?? null}, ${s.category ?? null}, ${codeLocation},
          ${s.reasoning}, ${jsonbLiteral(s.sourceReferences)},
          ${s.strength}, ${c.staleCitation}, ${c.staleReason ?? null}, ${invocationId}::uuid
        )
        ON CONFLICT (a_ref, b_ref, relation) WHERE expired_at IS NULL DO NOTHING
        RETURNING id
      `);
      const edgeId = unwrapRows<{ id: string }>(inserted)[0]?.id;
      if (!edgeId) {
        dropped.push({
          stagedEdgeId: c.stagedEdgeId,
          reason: 'duplicate live (a_ref, b_ref, relation) at insert',
        });
        continue;
      }

      await denormalizeSourceRefs(tx, edgeId, s.sourceReferences);
      created.push({ stagedEdgeId: c.stagedEdgeId, edgeId, staleCitation: c.staleCitation });
    }

    for (const co of plan.corroborate) {
      // D4: bump keyed on invocation_id. The guard makes the same invocation bump this
      // edge at most once — so a replay of the same staging is a no-op on
      // corroboration_count and strength. RETURNING tells us whether the bump landed.
      const res = await tx.execute(sql`
        UPDATE public.bridge_edges
        SET corroboration_count = corroboration_count + 1,
            strength = LEAST(1.0, strength + ${CORROBORATION_STRENGTH_DELTA}),
            invocation_id = ${invocationId}::uuid
        WHERE id = ${co.priorEdgeId}::uuid
          AND expired_at IS NULL
          AND invocation_id IS DISTINCT FROM ${invocationId}::uuid
        RETURNING id
      `);
      const bumped = unwrapRows<{ id: string }>(res).length > 0;
      corroborated.push({ stagedEdgeId: co.stagedEdgeId, edgeId: co.priorEdgeId, bumped });
    }
  });

  return { invocationId, created, corroborated, dropped };
}
