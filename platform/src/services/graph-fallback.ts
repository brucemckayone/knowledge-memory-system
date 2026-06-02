/**
 * Graph-Anchored Fallback Retrieval — neighbour expansion + evidence-unit fetch
 * (bead nmemo-0wq.2; design doc 38 §3, §7, §8.1).
 *
 * This is the EXPANSION + EVIDENCE-FETCH PRIMITIVE only. Given one or more
 * anchor entities (seeded elsewhere — §4 is bead .3's job), it walks the Graph S
 * fact edges to neighbour entities, ranks/caps the neighbours (§3.3), and for
 * each surviving neighbour fact fetches the UNIT-grained evidence behind it via
 * the additive fact_units links (yxj.6 / doc 38 §7) joined to the Qdrant unit
 * points. It does NOT decide whether flat retrieval failed (§6 trigger),
 * does NOT re-rank against a query (§5), and does NOT wire into the query path —
 * those are bead nmemo-0wq.3.
 *
 * UNIT GRAIN IS THE LOAD-BEARING CONSTRAINT (doc 38 §1): we return the small
 * embedding unit text behind a fact, never the whole parent window. When yxj.6
 * could only attribute a fact to its parent window (`window_fallback`), we
 * surface that single window-shaped entry flagged `windowFallback: true` so the
 * caller (and the eval bead) can count how often the path had to coarsen —
 * the exception, instrumented, not the default.
 *
 * Reuses, never rebuilds: findConnectedEntities (graph.ts — AGE neighbour walk),
 * getEntityFacts (facts.ts — active facts), the fact_units table (schema.ts),
 * Qdrant retrieve (qdrant.ts) for unit text. Predicate-relevance ranking (§3.3)
 * needs the query and so belongs to the re-rank in bead .3; this primitive's
 * signature is query-free (§8.1), so it ranks on the signals it has on hand —
 * anchor proximity (hop) and pagerank tie-break — and exposes an optional
 * `predicateWeight` hook so .3 can inject the query-driven predicate weight
 * without this primitive depending on the query or any embedding call.
 */

import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { factUnits, memoryEntities } from '../db/schema.js';
import { findConnectedEntities } from './graph.js';
import { getEntityFacts } from './facts.js';
import { qdrant, COLLECTIONS, getMemoryVectors } from './qdrant.js';

/** A single piece of unit-grained evidence behind a neighbour fact (doc 38 §3.4). */
export interface EvidenceUnit {
  /** The Qdrant unit satellite point id (or the parent window id on fallback). */
  qdrantPointId: string;
  /** facts.source_memory_id — the canonical parent window; provenance unchanged. */
  parentWindowId: string | null;
  /** Unit-grained text. On window fallback this is the whole window text. */
  unitText: string | null;
  charStart: number | null;
  charEnd: number | null;
  /**
   * True when fact_units could only attribute this fact to its parent window
   * (yxj.6 `window_fallback`), so `unitText` is window-grained, not unit-grained.
   * Instrumented per §3.4 — the exception, counted, not the default.
   */
  windowFallback: boolean;
}

/** A neighbour fact reached from an anchor, with its evidence units (doc 38 §3.4). */
export interface ExpandedEvidence {
  anchorEntityId: string;
  neighbourEntityId: string;
  factId: string;
  predicate: string;
  hop: number;
  units: EvidenceUnit[];
}

export interface ExpandOptions {
  /** Hops to walk from each anchor. Default FALLBACK_MAX_HOPS (1), hard cap 2 (§3.2). */
  maxHops?: number;
  /** Max expansion candidates kept per anchor before the fetch (§3.3). Default 20. */
  maxNeighbours?: number;
  /**
   * Optional query-driven predicate weight hook (§3.3 predicate relevance).
   * The query-free primitive cannot compute this itself; bead .3 injects it.
   * Higher = more relevant. Defaults to 0 for every predicate (hop + pagerank
   * alone decide ordering) when omitted.
   */
  predicateWeight?: (predicate: string) => number;
}

const DEFAULT_MAX_HOPS = (() => {
  const v = Number(process.env.FALLBACK_MAX_HOPS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
})();

const DEFAULT_MAX_NEIGHBOURS = (() => {
  const v = Number(process.env.FALLBACK_MAX_NEIGHBOURS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 20;
})();

/** Hard cap on hops regardless of caller/env (§3.2). */
const HARD_MAX_HOPS = 2;

/** A candidate neighbour fact awaiting ranking + evidence fetch. */
interface NeighbourCandidate {
  anchorEntityId: string;
  neighbourEntityId: string;
  factId: string;
  predicate: string;
  hop: number;
}

/**
 * Read pagerank for a set of entities from entity_topology (§3.3 tie-break).
 * Missing rows (no topology computed yet) map to 0 — a periphery score, so an
 * un-scored neighbour never beats a scored one on the tie-break alone.
 */
async function getPageranks(entityIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (entityIds.length === 0) return out;
  const idList = sql.join(entityIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT entity_id::text AS entity_id, pagerank
    FROM public.entity_topology
    WHERE entity_id IN (${idList})
  `)) as unknown as Array<{ entity_id: string; pagerank: number | null }>;
  for (const r of rows) out.set(r.entity_id, r.pagerank ?? 0);
  return out;
}

/**
 * Fetch unit text/offsets for a set of Qdrant unit point ids in one retrieve.
 * Missing points (the graceful missing-unit path — a fact_units row whose unit
 * point is absent from Qdrant) are simply not in the returned map; the caller
 * still emits an EvidenceUnit with null text so the link is observable.
 */
async function fetchUnitPayloads(
  pointIds: string[],
): Promise<Map<string, { unitText: string | null; parentWindowId: string | null }>> {
  const out = new Map<string, { unitText: string | null; parentWindowId: string | null }>();
  if (pointIds.length === 0) return out;
  const points = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
    ids: pointIds,
    with_payload: true,
    with_vector: false,
  });
  for (const p of points) {
    const pl = (p.payload ?? {}) as Record<string, unknown>;
    // Unit satellites carry `unit_text` + `parent_window_id`; window points (the
    // window_fallback case) carry the full window `content` and are their own parent.
    const unitText = (pl.unit_text as string | undefined) ?? (pl.content as string | undefined) ?? null;
    const parentWindowId =
      (pl.parent_window_id as string | undefined) ?? (String(p.id) as string | undefined) ?? null;
    out.set(String(p.id), { unitText, parentWindowId });
  }
  return out;
}

/**
 * Expand from anchor entities to neighbour facts and fetch their unit-grained
 * evidence (doc 38 §3, §8.1).
 *
 * Steps:
 *  1. For each anchor, AGE-walk to neighbours within the (clamped) hop budget,
 *     tracking the hop at which each neighbour was first reached (proximity).
 *     A visited-set across anchors + neighbours prevents cycles and re-walking.
 *  2. Pull active facts for each (anchor, neighbour) pair and keep only the
 *     facts that actually connect the two — the fact edge IS the reason the
 *     neighbour is interesting (§3.1). Causal edges are out of scope.
 *  3. Rank candidates: predicateWeight (query-driven, injected by .3) desc,
 *     then hop asc (closer anchors first, §3.3.2), then pagerank desc
 *     (tie-break, §3.3.3). Keep the top maxNeighbours per anchor (§3.3 cap).
 *  4. Resolve each surviving fact to its fact_units rows and retrieve the unit
 *     text from Qdrant in one batched call. window_fallback rows surface
 *     flagged; absent unit points surface with null text (graceful).
 */
export async function expandFromAnchors(
  anchorEntityIds: string[],
  opts: ExpandOptions = {},
): Promise<ExpandedEvidence[]> {
  const uniqueAnchors = [...new Set(anchorEntityIds.filter(Boolean))];
  if (uniqueAnchors.length === 0) return [];

  const requestedHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const maxHops = Math.max(1, Math.min(Math.floor(requestedHops), HARD_MAX_HOPS));
  const maxNeighbours = Math.max(1, Math.floor(opts.maxNeighbours ?? DEFAULT_MAX_NEIGHBOURS));
  const predicateWeight = opts.predicateWeight ?? (() => 0);

  // --- 1 + 2: per-anchor neighbour walk -> connecting facts ------------------
  const candidatesByAnchor = new Map<string, NeighbourCandidate[]>();
  const allNeighbourIds = new Set<string>();

  for (const anchorId of uniqueAnchors) {
    // Reach neighbours at the full hop budget in one walk; the returned set is
    // DISTINCT entities, so we recover each neighbour's first-reached hop by
    // walking incrementally (depth 1, then depth 2) and recording the first
    // depth that surfaces it. This keeps anchor-proximity ranking honest.
    const hopOf = new Map<string, number>();
    for (let depth = 1; depth <= maxHops; depth++) {
      const reached = await findConnectedEntities(anchorId, { maxDepth: depth });
      for (const n of reached) {
        if (n.entityId === anchorId) continue;
        if (!hopOf.has(n.entityId)) hopOf.set(n.entityId, depth);
      }
    }

    for (const n of hopOf.keys()) allNeighbourIds.add(n);

    // Walk fact EDGES (§3.1): a neighbour is interesting because a fact connects
    // it into the reachable set. The connecting fact need not touch the anchor
    // directly — at depth 2 it bridges a hop-1 entity to the hop-2 neighbour —
    // so we gather facts for every reached entity and keep any active fact whose
    // BOTH endpoints are reachable and whose neighbour endpoint we have a hop for.
    // The neighbour endpoint's first-reached hop is the evidence's hop. Causal
    // edges (Graph C) are out of scope. A fact is counted once per anchor, keyed
    // on its neighbour endpoint, so a fact between two neighbours surfaces once.
    const reachable = new Map<string, number>([[anchorId, 0], ...hopOf]);
    const candidates: NeighbourCandidate[] = [];
    const seenFact = new Set<string>();
    for (const entId of reachable.keys()) {
      const facts = await getEntityFacts(entId);
      for (const f of facts) {
        if (seenFact.has(f.id)) continue;
        const s = f.subjectEntityId;
        const o = f.objectEntityId;
        if (!o) continue; // value-only facts have no traversable neighbour
        if (!reachable.has(s) || !reachable.has(o)) continue;
        // Pick the endpoint that is a NEIGHBOUR (not the anchor) as the
        // evidence's neighbour; its hop drives proximity ranking.
        const neighbourId = s === anchorId ? o : o === anchorId ? s : (hopOf.has(o) ? o : s);
        const hop = hopOf.get(neighbourId);
        if (hop === undefined) continue;
        seenFact.add(f.id);
        candidates.push({
          anchorEntityId: anchorId,
          neighbourEntityId: neighbourId,
          factId: f.id,
          predicate: f.predicate,
          hop,
        });
      }
    }
    candidatesByAnchor.set(anchorId, candidates);
  }

  // --- 3: rank + cap per anchor ---------------------------------------------
  const pageranks = await getPageranks([...allNeighbourIds]);
  const ranked: NeighbourCandidate[] = [];
  for (const candidates of candidatesByAnchor.values()) {
    candidates.sort((a, b) => {
      const pw = predicateWeight(b.predicate) - predicateWeight(a.predicate);
      if (pw !== 0) return pw;
      if (a.hop !== b.hop) return a.hop - b.hop; // closer anchors first
      const pr = (pageranks.get(b.neighbourEntityId) ?? 0) - (pageranks.get(a.neighbourEntityId) ?? 0);
      return pr; // pagerank tie-break only
    });
    ranked.push(...candidates.slice(0, maxNeighbours));
  }
  if (ranked.length === 0) return [];

  // --- 4: fact -> fact_units -> Qdrant retrieve (one batched fetch) ----------
  const factIds = [...new Set(ranked.map((c) => c.factId))];
  const linkRows = await db
    .select()
    .from(factUnits)
    .where(inArray(factUnits.factId, factIds));

  const linksByFact = new Map<string, typeof linkRows>();
  const allPointIds = new Set<string>();
  for (const row of linkRows) {
    allPointIds.add(row.unitPointId);
    const list = linksByFact.get(row.factId) ?? [];
    list.push(row);
    linksByFact.set(row.factId, list);
  }

  const payloads = await fetchUnitPayloads([...allPointIds]);

  return ranked.map((c) => {
    const links = linksByFact.get(c.factId) ?? [];
    const units: EvidenceUnit[] = links.map((l) => {
      const windowFallback = l.matchKind === 'window_fallback';
      const payload = payloads.get(l.unitPointId);
      return {
        qdrantPointId: l.unitPointId,
        // window_fallback row is keyed on the parent window id itself.
        parentWindowId: windowFallback ? l.unitPointId : payload?.parentWindowId ?? null,
        unitText: payload?.unitText ?? null,
        charStart: l.charStart,
        charEnd: l.charEnd,
        windowFallback,
      };
    });
    return {
      anchorEntityId: c.anchorEntityId,
      neighbourEntityId: c.neighbourEntityId,
      factId: c.factId,
      predicate: c.predicate,
      hop: c.hop,
      units,
    };
  });
}

// ===========================================================================
// bead nmemo-0wq.3 — query-failure trigger + re-rank, integrated (doc 38 §4/§5/§6)
//
// This builds the COMPOSED retrieval on top of expandFromAnchors (the .2
// primitive): decide whether flat retrieval failed (§6), seed anchors from the
// failed flat result (§4), expand (§3, via expandFromAnchors), then re-rank the
// fetched evidence UNITS by unit-grained cosine vs the query (§5). The trigger
// fires ONLY on failure so successful flat queries are untouched (the .3
// acceptance constraint). No LLM re-ranker — cosine + structural signals only.
// ===========================================================================

/**
 * The minimal shape the trigger reads off a flat retrieval result (doc 38 §6.1).
 * Mirrors `UnitGroupedHit` (qdrant.ts) but kept structural so any flat path —
 * the /api/reason/query boundary, the agent's search_memories tool, a test —
 * can feed it without importing the Qdrant types.
 */
export interface FlatHit {
  /** Parent window id of the hit. */
  id: string;
  /** Top cosine score of the hit (best unit score for unit-grained hits). */
  score: number;
}

/** A single re-ranked unit of fallback evidence handed to the caller (doc 38 §5.3). */
export interface RankedUnit {
  qdrantPointId: string;
  parentWindowId: string | null;
  unitText: string | null;
  factId: string;
  predicate: string;
  neighbourEntityId: string;
  hop: number;
  /** Composite re-rank score (§5.2): w_sim·cosine + w_pred·predWeight + w_hop·(1/hop). */
  rerankScore: number;
  /** Bare cosine(query, unit) before the composite weighting — for eval/instrumentation. */
  cosine: number;
  windowFallback: boolean;
}

/** Cosine floor below which the top flat hit is "not really about this" (§6.1). */
const TRIGGER_MIN_SCORE = (() => {
  const v = Number(process.env.FALLBACK_TRIGGER_MIN_SCORE);
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
})();

/** Max anchors seeded per fallback (§4.1). */
const MAX_ANCHORS = (() => {
  const v = Number(process.env.FALLBACK_MAX_ANCHORS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 5;
})();

/** Top-N re-ranked units returned (§5.3). */
const RERANK_LIMIT = (() => {
  const v = Number(process.env.FALLBACK_RERANK_LIMIT);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 5;
})();

/** Composite re-rank weights (§5.2), env-tunable per the ship-and-tune convention. */
function rerankWeights(): { wSim: number; wPred: number; wHop: number } {
  const num = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) ? v : d;
  };
  return {
    wSim: num('FALLBACK_RERANK_W_SIM', 0.7),
    wPred: num('FALLBACK_RERANK_W_PRED', 0.2),
    wHop: num('FALLBACK_RERANK_W_HOP', 0.1),
  };
}

/**
 * Decide whether flat retrieval failed (doc 38 §6.1). Failure = no flat hit
 * clears the confidence bar: either the result set is empty, or the TOP score
 * is below the floor. Read off the flat result the caller already has — the
 * trigger costs nothing extra. Deliberately NOT triggered on "the answer was
 * wrong" (no ground truth at retrieval time); the only honest signal is
 * retrieval confidence. `minScore` overridable for tests; defaults to the env
 * floor (FALLBACK_TRIGGER_MIN_SCORE, default 0.5).
 */
export function flatRetrievalFailed(flatHits: FlatHit[], minScore: number = TRIGGER_MIN_SCORE): boolean {
  if (flatHits.length === 0) return true;
  const top = Math.max(...flatHits.map((h) => h.score));
  return top < minScore;
}

/** Cosine of two equal-length vectors. Zero-norm guards to 0 (no similarity). */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Resolve a set of flat-hit window ids to the entities mentioned in them, to
 * use as anchors (doc 38 §4.1 seed strategy 1 — the strongest seed: the flat
 * search got NEAR the right region). Joins window ids → memory_entities.
 * Empty when no hit linked to any entity.
 */
async function entitiesInFlatHits(windowIds: string[]): Promise<string[]> {
  const ids = [...new Set(windowIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ entityId: memoryEntities.entityId })
    .from(memoryEntities)
    .where(inArray(memoryEntities.memoryId, ids));
  return [...new Set(rows.map((r) => r.entityId))];
}

export interface RecallViaGraphOptions {
  /** Entity ids from query-side similarity (§4.1 seed strategy 2), injected by the caller. */
  seedEntityIds?: string[];
  /** Query-driven predicate weight (§3.3/§5.2), injected by the caller. Default 0. */
  predicateWeight?: (predicate: string) => number;
  /** Forwarded to expandFromAnchors (§3.2/§3.3). */
  maxHops?: number;
  maxNeighbours?: number;
  /** Top-N returned (defaults to env FALLBACK_RERANK_LIMIT). */
  limit?: number;
}

/**
 * Anchor (§4) → expand (§3, via expandFromAnchors) → re-rank (§5).
 *
 * The query-failure TRIGGER is the caller's responsibility via
 * flatRetrievalFailed() — this function assumes failure already detected and
 * does the recovery. It returns the top-N unit-grained evidence re-ranked by
 * cosine of each unit's STORED vector against `queryVector` (reused from the
 * flat search — no new query embedding), with §5.2's composite weighting. When
 * no anchor seeds (§4.2 no-anchor case) it returns [] — the caller surfaces the
 * original flat result unchanged. Single fire: it does not re-anchor its own
 * hits (§6.3).
 *
 * @param queryVector the query embedding already computed for the flat search.
 * @param flatHits    the (failed) flat result — its window ids seed anchors (§4.1.1).
 */
export async function recallViaGraph(
  queryVector: number[],
  flatHits: FlatHit[],
  opts: RecallViaGraphOptions = {},
): Promise<RankedUnit[]> {
  // --- §4: seed anchors. Strategy 1 (entities in surviving flat hits) first,
  //     then injected query-side entity matches (strategy 2). Dedup + cap.
  const fromHits = await entitiesInFlatHits(flatHits.map((h) => h.id));
  const anchors = [...new Set([...fromHits, ...(opts.seedEntityIds ?? [])])].slice(0, MAX_ANCHORS);
  if (anchors.length === 0) return []; // §4.2 no-anchor: empty, no error.

  // --- §3: expand (reuse the .2 primitive; thread the query-driven predicate
  //     weight through so its candidate ranking is query-aware too).
  const expanded = await expandFromAnchors(anchors, {
    maxHops: opts.maxHops,
    maxNeighbours: opts.maxNeighbours,
    predicateWeight: opts.predicateWeight,
  });
  if (expanded.length === 0) return [];

  // --- §5: re-rank fetched evidence units by unit-grained cosine vs the query.
  //     Fetch the units' STORED vectors in one batch (no re-embedding). A unit
  //     whose vector is absent from Qdrant (the graceful missing-unit path)
  //     scores cosine 0 — it still surfaces, just at the bottom.
  const predicateWeight = opts.predicateWeight ?? (() => 0);
  const { wSim, wPred, wHop } = rerankWeights();

  const pointIds = [
    ...new Set(expanded.flatMap((e) => e.units.map((u) => u.qdrantPointId))),
  ];
  const vectors = await getMemoryVectors(pointIds);

  const ranked: RankedUnit[] = [];
  for (const ev of expanded) {
    for (const u of ev.units) {
      const vec = vectors.get(u.qdrantPointId);
      const cos = vec ? cosine(queryVector, vec) : 0;
      const rerankScore = wSim * cos + wPred * predicateWeight(ev.predicate) + wHop * (1 / ev.hop);
      ranked.push({
        qdrantPointId: u.qdrantPointId,
        parentWindowId: u.parentWindowId,
        unitText: u.unitText,
        factId: ev.factId,
        predicate: ev.predicate,
        neighbourEntityId: ev.neighbourEntityId,
        hop: ev.hop,
        rerankScore,
        cosine: cos,
        windowFallback: u.windowFallback,
      });
    }
  }

  ranked.sort((a, b) => b.rerankScore - a.rerankScore);
  return ranked.slice(0, opts.limit ?? RERANK_LIMIT);
}
