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
import { factUnits } from '../db/schema.js';
import { findConnectedEntities } from './graph.js';
import { getEntityFacts } from './facts.js';
import { qdrant, COLLECTIONS } from './qdrant.js';

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
