/**
 * Pattern Lifecycle Service (Phase 6 — doc 17, nmemo-d9v)
 *
 * `causal_patterns` was created with a full lifecycle schema
 * (staging → candidate → provisional → canonical) in 002_causal_graph.sql but
 * had zero code touching it until this phase. `causal_edges.pattern_id` is
 * wired forward-compat from Phase 4. This service brings patterns alive:
 *
 *   - `detectCausalPatterns` walks active causal chains, normalises each chain
 *     to an abstract template (entity_type + predicate_category), clusters
 *     structurally identical templates, and upserts to staging at a
 *     configurable instance threshold (default 3).
 *   - `promotePatterns` drives the lifecycle staging → candidate → provisional
 *     → canonical with status-guarded UPDATE ... WHERE status=$prev RETURNING
 *     (a SQL CAS — no row locks, idempotent across pipeline + manual API
 *     races). Demotes on inactivity. Rejects staging that never activates.
 *   - `nameCandidatePatterns` synchronously calls Haiku for newly-promoted
 *     candidates, with try/catch + name=NULL fallback so naming failures
 *     never block promotion.
 *   - `matchEdgeToPattern` fires fire-and-forget from `createCausalEdge` —
 *     checks if the new edge starts/continues a provisional or canonical
 *     pattern and sets `pattern_id` + `pattern_position`. Never throws back
 *     into edge creation.
 *   - `findCausalGhosts` surfaces expected-but-missing N-1-of-N pattern steps
 *     for an entity (used by the reasoning agent during patrol).
 *   - `activePatterns` filters the catalog by status + entity involvement
 *     for MCP/HTTP/viz consumers.
 *
 * Heuristics implemented in this group (G4 — d9v.7 + d9v.8):
 *   - Migration 012 extends `valid_pattern_status` to include `'rejected'`.
 *   - `collectChains` — recursive CTE walking active causal_edges from events
 *     within `lookbackDays`. Cycle protection via path-array exclusion.
 *   - `normaliseChain` + `detectCausalPatterns` — clusters chains by template
 *     hash, upserts to staging at `instanceThreshold`, stamps participating
 *     edges with `pattern_id` + `pattern_position`.
 *   - `promotePatterns` — single-pass lifecycle driver. Status-guarded
 *     UPDATE for each transition (Q5 SQL CAS). Snapshots eligibility
 *     BEFORE applying any UPDATE so demotions step at most one level per
 *     call. SYNC-calls `nameCandidatePatterns` on rows actually flipped to
 *     `candidate` (Q3).
 *   - `nameCandidatePatterns` — Haiku low-effort JSON name + description for
 *     patterns the CAS flipped to `candidate`. Try/catch + name=NULL on
 *     failure so naming never blocks promotion. Idempotent: skips patterns
 *     that already have a name set.
 *   - `matchEdgeToPattern` — fire-and-forget from `createCausalEdge` after
 *     INSERT/corroborate succeeds. Looks for any provisional/canonical
 *     pattern whose template has a 2-window matching the edge's
 *     (cause_type|cause_predicate, effect_type|effect_predicate) shape and
 *     stamps `pattern_id` + `pattern_position`. Wrapped try/catch — never
 *     surfaces back into edge creation.
 *
 * Later groups add ghost detection and the active-patterns query.
 */

import { sql } from 'drizzle-orm';
import { rawQuery } from '../db/raw.js';
import { ml } from './ml-client.js';

// ============================================
// Types
// ============================================

export interface DetectOptions {
  /** Minimum chain length to consider for a template. Default 2. */
  minChainLength?: number;
  /** Maximum chain length to walk during collection. Default 6. */
  maxChainLength?: number;
  /** Only include chains whose first cause event occurred within this window. Default 30. */
  lookbackDays?: number;
  /** Cluster size required to upsert into staging. Default 3. */
  instanceThreshold?: number;
  /** Hard cap on the number of chains the CTE returns. Default 1000. */
  maxChains?: number;
}

export interface DetectResult {
  chainsExamined: number;
  templatesFound: number;
  newStaging: number;
  updatedExisting: number;
}

/** A single forward chain through the causal graph (cause → effect → effect → …). */
export interface Chain {
  edgeIds: string[];
  length: number;
}

/**
 * One node in a normalised pattern template — corresponds to one event in the
 * underlying chain. Entity-specific identity is dropped; only the type plus
 * predicate category remain. `predicate_category` falls back to the literal
 * predicate string when `fact_predicates.category` is NULL.
 */
export interface TemplateNode {
  entity_type: string | null;
  predicate_category: string;
}

/** A chain with its normalised template attached. */
export interface NormalisedChain extends Chain {
  template: TemplateNode[];
  templateHash: string;
}

const DEFAULTS: Required<DetectOptions> = {
  minChainLength: 2,
  maxChainLength: 6,
  lookbackDays: 30,
  instanceThreshold: 3,
  maxChains: 1000,
};

// ============================================
// Detection — chain collection (G1)
// ============================================

/**
 * Walk active `causal_edges` starting from edges whose cause event occurred
 * within `lookbackDays`. Returns linear forward chains of length
 * `[minChainLength, maxChainLength]`. Cycle protection: an edge cannot appear
 * twice in the same chain (path-array exclusion in the recursive term).
 *
 * Output is the raw set of edge-id sequences, capped at `maxChains`. G2 layers
 * normalisation + clustering + upsert on top of these chains.
 */
export async function collectChains(opts: DetectOptions = {}): Promise<Chain[]> {
  const o = { ...DEFAULTS, ...opts };

  type Row = {
    edgePath: string[];
    length: number;
  };

  const rows = await rawQuery<Row>(sql`
    WITH RECURSIVE chain AS (
      SELECT
        ARRAY[e.id]::uuid[] AS edge_path,
        e.cause_event_id     AS first_cause,
        e.effect_event_id    AS current_effect,
        1                    AS length
      FROM public.causal_edges e
      JOIN public.causal_events ce ON ce.id = e.cause_event_id
      WHERE e.expired_at IS NULL
        AND ce.occurred_at >= NOW() - (${o.lookbackDays}::int || ' days')::interval

      UNION ALL

      SELECT
        c.edge_path || n.id,
        c.first_cause,
        n.effect_event_id,
        c.length + 1
      FROM chain c
      JOIN public.causal_edges n
        ON n.cause_event_id = c.current_effect
      WHERE n.expired_at IS NULL
        AND c.length < ${o.maxChainLength}::int
        AND NOT (n.id = ANY(c.edge_path))
    )
    SELECT
      (edge_path)::text[]::uuid[]::text[] AS edge_path,
      length
    FROM chain
    WHERE length >= ${o.minChainLength}::int
    ORDER BY length DESC, first_cause
    LIMIT ${o.maxChains}::int
  `);

  return rows.map((r) => ({
    edgeIds: r.edgePath,
    length: r.length,
  }));
}

// ============================================
// Detection — normalisation (G2)
// ============================================

/**
 * Resolve each chain's edges to the (cause, effect) event pair, then map every
 * unique event to its `(entity_type, predicate_category)` template node. The
 * predicate-category fallback to the literal predicate string is applied here
 * so chains using uncatalogued predicates still cluster deterministically
 * (rather than collapsing every NULL category into the same bucket — the spec
 * fallback per Q2).
 */
export async function normaliseChain(chain: Chain): Promise<NormalisedChain> {
  if (chain.edgeIds.length === 0) {
    return { ...chain, template: [], templateHash: canonicalHash([]) };
  }

  type EdgeRow = {
    id: string;
    causeEventId: string;
    effectEventId: string;
  };

  const edgeIdsLiteral = `{${chain.edgeIds.join(',')}}`;

  const edgeRows = await rawQuery<EdgeRow>(sql`
    SELECT id, cause_event_id, effect_event_id
    FROM public.causal_edges
    WHERE id = ANY(${edgeIdsLiteral}::uuid[])
  `);

  const edgeById = new Map(edgeRows.map((e) => [e.id, e]));

  // Walk the chain in order to recover the canonical event sequence
  // [cause_of_edge_0, effect_of_edge_0, effect_of_edge_1, ...]
  const eventIds: string[] = [];
  for (let i = 0; i < chain.edgeIds.length; i++) {
    const edge = edgeById.get(chain.edgeIds[i]!);
    if (!edge) {
      throw new Error(`normaliseChain: edge ${chain.edgeIds[i]} missing from causal_edges (was it expired?)`);
    }
    if (i === 0) eventIds.push(edge.causeEventId);
    eventIds.push(edge.effectEventId);
  }

  type EventRow = {
    id: string;
    entityType: string | null;
    predicate: string | null;
    predicateCategory: string | null;
  };

  const eventIdsLiteral = `{${eventIds.join(',')}}`;
  const eventRows = await rawQuery<EventRow>(sql`
    SELECT
      ce.id,
      ent.entity_type,
      ce.predicate,
      fp.category AS predicate_category
    FROM public.causal_events ce
    LEFT JOIN public.entities ent ON ent.id = ce.subject_entity_id
    LEFT JOIN public.fact_predicates fp ON fp.predicate = ce.predicate
    WHERE ce.id = ANY(${eventIdsLiteral}::uuid[])
  `);

  const eventById = new Map(eventRows.map((e) => [e.id, e]));

  const template: TemplateNode[] = eventIds.map((eid) => {
    const ev = eventById.get(eid);
    return {
      entity_type: ev?.entityType ?? null,
      // Q2 fallback: literal predicate string when fact_predicates.category is NULL
      predicate_category: ev?.predicateCategory ?? ev?.predicate ?? '',
    };
  });

  return { ...chain, template, templateHash: canonicalHash(template) };
}

/**
 * Canonicalise a template to a stable string for clustering. We keep the field
 * order fixed (entity_type, predicate_category) so JSON.stringify produces
 * identical output for structurally equivalent templates regardless of how
 * Postgres returned them.
 */
function canonicalHash(template: TemplateNode[]): string {
  return JSON.stringify(
    template.map((n) => ({
      entity_type: n.entity_type,
      predicate_category: n.predicate_category,
    })),
  );
}

// ============================================
// Detection — clustering + upsert (G2)
// ============================================

interface ClusterStats {
  template: TemplateNode[];
  templateHash: string;
  chains: NormalisedChain[];
}

/**
 * Phase 6 detection orchestrator (G2 — full pipeline through staging upsert).
 *
 * 1. Collect chains via the recursive CTE (G1).
 * 2. Normalise each chain to a template, hash for clustering.
 * 3. Group chains by template hash. Clusters of size ≥ `instanceThreshold`
 *    become candidate templates for upsert.
 * 4. For each cluster: find existing pattern by JSONB equality on
 *    `template_structure`. If found, accumulate `instance_count` and refresh
 *    `last_seen_at`. If new, INSERT with `status = 'staging'`.
 * 5. Stamp every participating edge with `pattern_id` + `pattern_position`.
 * 6. Recompute `avg_strength` and `avg_temporal_span` from all currently
 *    linked active edges (idempotent under repeated detection passes).
 *
 * Later groups (G3+) drive the lifecycle past staging via `promotePatterns`.
 */
export async function detectCausalPatterns(
  opts: DetectOptions = {},
): Promise<DetectResult> {
  const o = { ...DEFAULTS, ...opts };
  const chains = await collectChains(opts);

  // 1+2: normalise + cluster
  const clusters = new Map<string, ClusterStats>();
  for (const chain of chains) {
    const normalised = await normaliseChain(chain);
    const existing = clusters.get(normalised.templateHash);
    if (existing) {
      existing.chains.push(normalised);
    } else {
      clusters.set(normalised.templateHash, {
        template: normalised.template,
        templateHash: normalised.templateHash,
        chains: [normalised],
      });
    }
  }

  // 3+4+5: upsert each cluster meeting threshold + stamp edges
  let templatesFound = 0;
  let newStaging = 0;
  let updatedExisting = 0;

  for (const cluster of clusters.values()) {
    if (cluster.chains.length < o.instanceThreshold) continue;
    templatesFound++;

    const patternId = await upsertPattern(cluster);
    if (patternId.created) newStaging++;
    else updatedExisting++;

    await linkEdgesToPattern(patternId.id, cluster.chains);
    await recomputePatternAggregates(patternId.id);
  }

  return {
    chainsExamined: chains.length,
    templatesFound,
    newStaging,
    updatedExisting,
  };
}

/**
 * Upsert a pattern by JSONB-equal template_structure. Returns the pattern ID
 * and whether it was freshly inserted.
 *
 * INSERT path: status='staging', instance_count=cluster.chains.length,
 * first_seen_at=NOW(), last_seen_at=NOW(), template_length=template.length.
 *
 * UPDATE path: instance_count += new chains, last_seen_at=NOW(). Strengths
 * and temporal_span are recomputed afterwards by recomputePatternAggregates.
 */
async function upsertPattern(cluster: ClusterStats): Promise<{ id: string; created: boolean }> {
  type Row = { id: string };

  const templateJson = canonicalHash(cluster.template);
  const newCount = cluster.chains.length;
  const templateLength = cluster.template.length;

  const existing = await rawQuery<Row>(sql`
    SELECT id
    FROM public.causal_patterns
    WHERE template_structure = ${templateJson}::jsonb
    LIMIT 1
  `);

  if (existing.length > 0) {
    await rawQuery(sql`
      UPDATE public.causal_patterns
      SET instance_count = instance_count + ${newCount}::int,
          last_seen_at   = NOW(),
          updated_at     = NOW()
      WHERE id = ${existing[0]!.id}::uuid
    `);
    return { id: existing[0]!.id, created: false };
  }

  const inserted = await rawQuery<Row>(sql`
    INSERT INTO public.causal_patterns
      (template_structure, template_length, status, instance_count,
       first_seen_at, last_seen_at)
    VALUES
      (${templateJson}::jsonb, ${templateLength}::int, 'staging',
       ${newCount}::int, NOW(), NOW())
    RETURNING id
  `);

  return { id: inserted[0]!.id, created: true };
}

/**
 * Stamp `pattern_id` + `pattern_position` on every edge that participates in
 * any chain belonging to this cluster. An edge that appears in multiple
 * chains gets the position of its FIRST appearance — this matches the
 * reasoning agent's expectation when traversing patterns from a starting
 * edge. Last-write-wins across detection passes.
 */
async function linkEdgesToPattern(patternId: string, chains: NormalisedChain[]): Promise<void> {
  const positionByEdge = new Map<string, number>();
  for (const chain of chains) {
    chain.edgeIds.forEach((edgeId, idx) => {
      if (!positionByEdge.has(edgeId)) {
        positionByEdge.set(edgeId, idx);
      }
    });
  }

  for (const [edgeId, position] of positionByEdge) {
    await rawQuery(sql`
      UPDATE public.causal_edges
      SET pattern_id       = ${patternId}::uuid,
          pattern_position = ${position}::int
      WHERE id = ${edgeId}::uuid
        AND expired_at IS NULL
    `);
  }
}

/**
 * Refresh aggregate metrics on the pattern from all currently-linked active
 * edges. Idempotent: calling repeatedly produces the same row state regardless
 * of how `instance_count` evolves. Computed in-DB to avoid pulling all edges.
 */
async function recomputePatternAggregates(patternId: string): Promise<void> {
  await rawQuery(sql`
    UPDATE public.causal_patterns p
    SET avg_strength      = sub.avg_str,
        avg_temporal_span = sub.avg_span,
        updated_at        = NOW()
    FROM (
      SELECT pattern_id,
             AVG(strength)::float                                       AS avg_str,
             (AVG(EXTRACT(EPOCH FROM temporal_span)) * INTERVAL '1 second') AS avg_span
      FROM public.causal_edges
      WHERE pattern_id = ${patternId}::uuid
        AND expired_at IS NULL
      GROUP BY pattern_id
    ) sub
    WHERE p.id = sub.pattern_id
  `);
}

// ============================================
// Lifecycle — promotion + demotion + rejection (G3)
// ============================================

export type PatternStatus = 'staging' | 'candidate' | 'provisional' | 'canonical' | 'rejected';

export const PATTERN_STATUSES: readonly PatternStatus[] = [
  'staging',
  'candidate',
  'provisional',
  'canonical',
  'rejected',
] as const;

/**
 * Lifecycle thresholds — env-tunable per spec 17:206-212. Defaults track the
 * spec exactly; tests override via `PromoteOptions` rather than mutating
 * these constants so we keep the production path predictable.
 */
export const LIFECYCLE_DEFAULTS = {
  /** staging → candidate: instance_count threshold + recency window (days). */
  stagingToCandidate: { instances: 5, lookbackDays: 14 },
  /** candidate → provisional: instance_count + activations in last 30d. */
  candidateToProvisional: { instances: 10, activations30d: 3 },
  /** provisional → canonical: dwell time in provisional (days) + activations. */
  provisionalToCanonical: { dwellDays: 14, activations30d: 5 },
  /** Demote one level when activation_count_30d == 0 for this many days. */
  demotion: { idleDays: 30 },
  /** staging → rejected: never activated within this many days of first_seen_at. */
  rejection: { stagingDays: 14 },
} as const;

export interface PromoteOptions {
  /** Override for tests — must match the LIFECYCLE_DEFAULTS shape. */
  thresholds?: Partial<typeof LIFECYCLE_DEFAULTS>;
}

export interface PromotionEvent {
  id: string;
  from: PatternStatus;
  to: PatternStatus;
  /** Pattern name at the time of transition (may be NULL — naming runs in G4). */
  name: string | null;
}

export interface RejectionEvent {
  id: string;
  reason: string;
}

export interface PromoteResult {
  promoted: PromotionEvent[];
  demoted: PromotionEvent[];
  rejected: RejectionEvent[];
}

interface PatternSnapshot {
  id: string;
  status: PatternStatus;
  name: string | null;
  instanceCount: number;
  activationCount30d: number;
  firstSeenAt: Date;
  lastSeenAt: Date | null;
  promotedAt: Date | null;
}

/**
 * Single-pass promotion + demotion + rejection driver.
 *
 * Algorithm:
 *   1. Refresh `activation_count_30d` for every non-rejected pattern from the
 *      live `causal_edges` table (count of edges with `pattern_id = id` and
 *      `created_at >= NOW() - 30 days`). This makes the column self-healing
 *      against edge expiry / pattern reassignment.
 *   2. Snapshot all non-rejected patterns at this moment.
 *   3. From the snapshot, compute eligibility for each transition.
 *   4. Apply each transition with `UPDATE ... WHERE id = ANY($eligible) AND
 *      status = $prev RETURNING *`. The status guard is the SQL CAS — if a
 *      concurrent caller beat us, the WHERE returns 0 rows and we skip.
 *   5. Demotions are computed off the SAME snapshot so a pattern moves at
 *      most one level per call (the spec contract).
 *
 * Returns the lists of promoted, demoted, and rejected pattern IDs with
 * their before/after status — the reasoning agent or a future hook can fan
 * those out (G4 wires Haiku naming on `promoted` rows where `to === 'candidate'`).
 */
export async function promotePatterns(opts: PromoteOptions = {}): Promise<PromoteResult> {
  const t = mergeThresholds(opts.thresholds);

  await refreshActivationCounts();
  const snapshot = await snapshotPatterns();

  const stagingToCandidateIds = snapshot
    .filter((p) =>
      p.status === 'staging' &&
      p.instanceCount >= t.stagingToCandidate.instances &&
      withinDays(p.lastSeenAt, t.stagingToCandidate.lookbackDays),
    )
    .map((p) => p.id);

  const candidateToProvisionalIds = snapshot
    .filter((p) =>
      p.status === 'candidate' &&
      p.instanceCount >= t.candidateToProvisional.instances &&
      p.activationCount30d >= t.candidateToProvisional.activations30d,
    )
    .map((p) => p.id);

  const provisionalToCanonicalIds = snapshot
    .filter((p) =>
      p.status === 'provisional' &&
      olderThanDays(p.promotedAt, t.provisionalToCanonical.dwellDays) &&
      p.activationCount30d >= t.provisionalToCanonical.activations30d,
    )
    .map((p) => p.id);

  // Demotion: any non-staging pattern with zero activations in 30d AND whose
  // last_seen (or first_seen as fallback) is past the idle window. Each pattern
  // demotes at most one level per call because the snapshot fixed its status
  // at function entry.
  const demoteCandidates = snapshot.filter((p) =>
    p.status !== 'staging' &&
    p.status !== 'rejected' &&
    p.activationCount30d === 0 &&
    olderThanDays(p.lastSeenAt ?? p.firstSeenAt, t.demotion.idleDays),
  );

  const canonicalDemoteIds = demoteCandidates.filter((p) => p.status === 'canonical').map((p) => p.id);
  const provisionalDemoteIds = demoteCandidates.filter((p) => p.status === 'provisional').map((p) => p.id);
  const candidateDemoteIds = demoteCandidates.filter((p) => p.status === 'candidate').map((p) => p.id);

  // Rejection: staging with zero activations and aged out.
  const rejectionIds = snapshot
    .filter((p) =>
      p.status === 'staging' &&
      p.activationCount30d === 0 &&
      olderThanDays(p.firstSeenAt, t.rejection.stagingDays),
    )
    .map((p) => p.id);

  const promoted: PromotionEvent[] = [];
  const demoted: PromotionEvent[] = [];
  const rejected: RejectionEvent[] = [];

  // Apply promotions in order — staging→candidate first so we can name new
  // candidates before the rest of the pipeline runs.
  const stagingToCandidateRows = await casTransition(stagingToCandidateIds, 'staging', 'candidate', { setPromotedAt: true });
  promoted.push(...stagingToCandidateRows);

  // Q3: synchronous Haiku naming for newly-promoted candidates. Failures
  // surface as name=NULL but never block promotion.
  if (stagingToCandidateRows.length > 0) {
    await nameCandidatePatterns(stagingToCandidateRows.map((r) => r.id));
  }

  promoted.push(...(await casTransition(candidateToProvisionalIds, 'candidate', 'provisional', { setPromotedAt: true })));
  promoted.push(...(await casTransition(provisionalToCanonicalIds, 'provisional', 'canonical', { setPromotedAt: true })));

  // Apply demotions — order independent because the eligibility was computed
  // off the snapshot, but for clarity demote canonical first.
  demoted.push(...(await casTransition(canonicalDemoteIds, 'canonical', 'provisional')));
  demoted.push(...(await casTransition(provisionalDemoteIds, 'provisional', 'candidate')));
  demoted.push(...(await casTransition(candidateDemoteIds, 'candidate', 'staging')));

  // Rejection — terminal. Sets rejected_at + rejection_reason.
  if (rejectionIds.length > 0) {
    const rejectedRows = await rawQuery<{ id: string }>(sql`
      UPDATE public.causal_patterns
      SET status           = 'rejected',
          rejected_at      = NOW(),
          rejection_reason = 'No activations within rejection window',
          updated_at       = NOW()
      WHERE id = ANY(${`{${rejectionIds.join(',')}}`}::uuid[])
        AND status = 'staging'
      RETURNING id
    `);
    for (const r of rejectedRows) {
      rejected.push({ id: r.id, reason: 'No activations within rejection window' });
    }
  }

  return { promoted, demoted, rejected };
}

function mergeThresholds(overrides?: Partial<typeof LIFECYCLE_DEFAULTS>): typeof LIFECYCLE_DEFAULTS {
  if (!overrides) return LIFECYCLE_DEFAULTS;
  return {
    stagingToCandidate: { ...LIFECYCLE_DEFAULTS.stagingToCandidate, ...overrides.stagingToCandidate },
    candidateToProvisional: { ...LIFECYCLE_DEFAULTS.candidateToProvisional, ...overrides.candidateToProvisional },
    provisionalToCanonical: { ...LIFECYCLE_DEFAULTS.provisionalToCanonical, ...overrides.provisionalToCanonical },
    demotion: { ...LIFECYCLE_DEFAULTS.demotion, ...overrides.demotion },
    rejection: { ...LIFECYCLE_DEFAULTS.rejection, ...overrides.rejection },
  };
}

function withinDays(when: Date | null, days: number): boolean {
  if (!when) return false;
  return Date.now() - when.getTime() <= days * 86400 * 1000;
}

function olderThanDays(when: Date | null, days: number): boolean {
  if (!when) return false;
  return Date.now() - when.getTime() >= days * 86400 * 1000;
}

/**
 * Recompute `activation_count_30d` for every non-rejected pattern from
 * `causal_edges`. An "activation" is an edge linked to the pattern within
 * the last 30 days (`created_at >= NOW() - 30 days` and `expired_at IS NULL`).
 *
 * Self-healing: works regardless of whether `matchEdgeToPattern` (G4) has
 * had a chance to incrementally bump the column.
 */
async function refreshActivationCounts(): Promise<void> {
  await rawQuery(sql`
    UPDATE public.causal_patterns p
    SET activation_count_30d = COALESCE(sub.cnt, 0),
        updated_at           = NOW()
    FROM (
      SELECT cp.id AS pattern_id,
             COUNT(ce.id)::int AS cnt
      FROM public.causal_patterns cp
      LEFT JOIN public.causal_edges ce
        ON ce.pattern_id = cp.id
        AND ce.expired_at IS NULL
        AND ce.created_at >= NOW() - INTERVAL '30 days'
      WHERE cp.status != 'rejected'
      GROUP BY cp.id
    ) sub
    WHERE p.id = sub.pattern_id
  `);
}

async function snapshotPatterns(): Promise<PatternSnapshot[]> {
  // Aliasing `activation_count_30d` to `activations30d` works around a
  // limitation of the snake-to-camel transformer in src/db/raw.ts which only
  // handles `_<lowercase letter>` and would leave `_30d` intact, producing
  // the awkward field name `activationCount_30d` instead of `activationCount30d`.
  type Row = {
    id: string;
    status: PatternStatus;
    name: string | null;
    instanceCount: number;
    activations30d: number;
    firstSeenAt: Date | string;
    lastSeenAt: Date | string | null;
    promotedAt: Date | string | null;
  };

  const rows = await rawQuery<Row>(sql`
    SELECT id,
           status,
           name,
           instance_count,
           activation_count_30d AS activations30d,
           first_seen_at,
           last_seen_at,
           promoted_at
    FROM public.causal_patterns
    WHERE status != 'rejected'
  `);

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    name: r.name,
    instanceCount: r.instanceCount,
    activationCount30d: r.activations30d ?? 0,
    firstSeenAt: toDate(r.firstSeenAt)!,
    lastSeenAt: toDate(r.lastSeenAt),
    promotedAt: toDate(r.promotedAt),
  }));
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
}

interface CasOptions {
  setPromotedAt?: boolean;
}

/**
 * Status-guarded UPDATE for one transition. Returns the rows that the CAS
 * actually flipped (a concurrent caller beat us on rows that don't appear
 * in the result set).
 */
async function casTransition(
  ids: string[],
  fromStatus: PatternStatus,
  toStatus: PatternStatus,
  opts: CasOptions = {},
): Promise<PromotionEvent[]> {
  if (ids.length === 0) return [];

  const idsLiteral = `{${ids.join(',')}}`;

  type Row = { id: string; name: string | null };

  const rows = opts.setPromotedAt
    ? await rawQuery<Row>(sql`
        UPDATE public.causal_patterns
        SET status      = ${toStatus},
            promoted_at = NOW(),
            updated_at  = NOW()
        WHERE id = ANY(${idsLiteral}::uuid[])
          AND status = ${fromStatus}
        RETURNING id, name
      `)
    : await rawQuery<Row>(sql`
        UPDATE public.causal_patterns
        SET status     = ${toStatus},
            updated_at = NOW()
        WHERE id = ANY(${idsLiteral}::uuid[])
          AND status = ${fromStatus}
        RETURNING id, name
      `);

  return rows.map((r) => ({ id: r.id, from: fromStatus, to: toStatus, name: r.name }));
}

// ============================================
// Naming — Haiku low-effort JSON (G4)
// ============================================

interface PatternNamingResult {
  name: string;
  description: string;
}

/**
 * Synchronously name and describe each pattern in `patternIds` using Haiku
 * low-effort JSON output. Idempotent: skips patterns that already have a
 * name set (so re-running promotePatterns or doing a manual /api/patterns/name
 * call won't double-charge).
 *
 * Failure handling (Q3): a try/catch around each call ensures one bad pattern
 * doesn't block the others, and ML-service failures leave the row at name=NULL
 * (the column default) rather than throwing back into promotePatterns.
 */
export async function nameCandidatePatterns(patternIds: string[]): Promise<void> {
  if (patternIds.length === 0) return;

  for (const id of patternIds) {
    try {
      const [row] = await rawQuery<{
        id: string;
        name: string | null;
        templateStructure: TemplateNode[];
        instanceCount: number;
        avgStrength: number | null;
      }>(sql`
        SELECT id, name, template_structure, instance_count, avg_strength
        FROM public.causal_patterns
        WHERE id = ${id}::uuid
      `);
      if (!row) continue;
      if (row.name) continue; // idempotent — spec rule

      const prompt = buildNamingPrompt(row.templateStructure, row.instanceCount, row.avgStrength);
      const result = await ml.generateJson<PatternNamingResult>(prompt);

      // Reject malformed responses up front so we don't write garbage.
      if (typeof result?.name !== 'string' || typeof result?.description !== 'string') {
        console.warn(`[nameCandidatePatterns] malformed JSON for ${id} — keeping name=NULL`);
        continue;
      }

      await rawQuery(sql`
        UPDATE public.causal_patterns
        SET name        = ${result.name.slice(0, 255)},
            description = ${result.description},
            updated_at  = NOW()
        WHERE id = ${id}::uuid
      `);
    } catch (err) {
      console.warn(`[nameCandidatePatterns] failed for ${id}:`, err instanceof Error ? err.message : err);
    }
  }
}

function buildNamingPrompt(template: TemplateNode[], instanceCount: number, avgStrength: number | null): string {
  return [
    'This recurring causal pattern has emerged in the knowledge graph:',
    JSON.stringify(template, null, 2),
    `Observed ${instanceCount} times. Average causal strength: ${avgStrength?.toFixed(2) ?? 'unknown'}.`,
    'Generate:',
    '  1. A short, action-oriented name (3-6 words) — what this pattern represents.',
    '  2. A one-sentence description explaining the causal relationship the pattern captures.',
    'Respond with ONLY raw JSON in the form: {"name": "...", "description": "..."}',
  ].join('\n');
}

// ============================================
// Edge-time matching (G4)
// ============================================

export interface MatchResult {
  patternId: string;
  patternPosition: number;
}

/**
 * Try to match a newly-created edge against any provisional/canonical pattern
 * — if its (cause_type, cause_predicate) → (effect_type, effect_predicate)
 * matches a 2-window in the template, stamp `pattern_id` and `pattern_position`
 * on the edge and bump the pattern's `last_seen_at`. The activation counter
 * stays self-healing (recomputed by `promotePatterns`'s refresh step from
 * `causal_edges.created_at`); we don't need a separate increment here.
 *
 * Returns the match if one was applied, or `null` if no pattern matched.
 *
 * Designed to be called fire-and-forget from `createCausalEdge` after
 * INSERT/corroborate succeeds. The wrapping caller wraps in try/catch — but
 * the function itself returns silently on no-match, never throws on missing
 * data, and only surfaces errors for genuinely unexpected DB failures.
 */
export async function matchEdgeToPattern(edgeId: string): Promise<MatchResult | null> {
  // Fetch the edge and its events with normalised metadata
  type EdgeRow = {
    id: string;
    causeEventId: string;
    effectEventId: string;
    causeEntityType: string | null;
    causePredicateCategory: string | null;
    causePredicate: string | null;
    effectEntityType: string | null;
    effectPredicateCategory: string | null;
    effectPredicate: string | null;
  };

  const [edge] = await rawQuery<EdgeRow>(sql`
    SELECT
      e.id,
      e.cause_event_id,
      e.effect_event_id,
      cause_ent.entity_type AS cause_entity_type,
      cause_fp.category     AS cause_predicate_category,
      cause_ev.predicate    AS cause_predicate,
      effect_ent.entity_type AS effect_entity_type,
      effect_fp.category     AS effect_predicate_category,
      effect_ev.predicate    AS effect_predicate
    FROM public.causal_edges e
    JOIN public.causal_events cause_ev  ON cause_ev.id  = e.cause_event_id
    JOIN public.causal_events effect_ev ON effect_ev.id = e.effect_event_id
    LEFT JOIN public.entities cause_ent  ON cause_ent.id  = cause_ev.subject_entity_id
    LEFT JOIN public.entities effect_ent ON effect_ent.id = effect_ev.subject_entity_id
    LEFT JOIN public.fact_predicates cause_fp  ON cause_fp.predicate  = cause_ev.predicate
    LEFT JOIN public.fact_predicates effect_fp ON effect_fp.predicate = effect_ev.predicate
    WHERE e.id = ${edgeId}::uuid
      AND e.expired_at IS NULL
  `);

  if (!edge) return null;

  const causeNode: TemplateNode = {
    entity_type: edge.causeEntityType ?? null,
    predicate_category: edge.causePredicateCategory ?? edge.causePredicate ?? '',
  };
  const effectNode: TemplateNode = {
    entity_type: edge.effectEntityType ?? null,
    predicate_category: edge.effectPredicateCategory ?? edge.effectPredicate ?? '',
  };

  // Pull provisional + canonical patterns. Staging/candidate are excluded per
  // spec 17:573 — only stable patterns claim new edges.
  const candidates = await rawQuery<{
    id: string;
    templateStructure: TemplateNode[];
  }>(sql`
    SELECT id, template_structure
    FROM public.causal_patterns
    WHERE status IN ('provisional', 'canonical')
  `);

  for (const pattern of candidates) {
    let tpl = pattern.templateStructure;
    if (typeof tpl === 'string') {
      try { tpl = JSON.parse(tpl); } catch { continue; }
    }
    if (!Array.isArray(tpl)) continue;
    for (let i = 0; i + 1 < tpl.length; i++) {
      if (
        templateNodeEquals(tpl[i]!, causeNode) &&
        templateNodeEquals(tpl[i + 1]!, effectNode)
      ) {
        await rawQuery(sql`
          UPDATE public.causal_edges
          SET pattern_id       = ${pattern.id}::uuid,
              pattern_position = ${i}::int
          WHERE id = ${edgeId}::uuid
            AND expired_at IS NULL
        `);
        await rawQuery(sql`
          UPDATE public.causal_patterns
          SET last_seen_at = NOW(),
              updated_at   = NOW()
          WHERE id = ${pattern.id}::uuid
        `);
        return { patternId: pattern.id, patternPosition: i };
      }
    }
  }

  return null;
}

function templateNodeEquals(a: TemplateNode, b: TemplateNode): boolean {
  return a.entity_type === b.entity_type && a.predicate_category === b.predicate_category;
}
