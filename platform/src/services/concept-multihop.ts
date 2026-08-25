/**
 * Multi-hop concept-mediated cross-corpus recall (doc 34 §7.2 step 3).
 *
 * The shipped `recallConceptCandidates` (audit-pass.ts) is SINGLE-HOP: two elements meet only
 * if they point at the SAME concept node. doc 34 measured what that costs — only 4 of 104
 * concepts were touched by both sides, so the JOIN could fire through 4 pivots and reached
 * 8 of 29 elements. The intended architecture is a concept super-graph over per-corpus
 * entity+fact graphs, where a concept reaches an element THROUGH the corpus's own structure:
 *
 *   source elem --facts*(≤h)--> e_a --exhibits--> concept <--addresses-- e_b --facts*(≤h)--> target elem
 *
 * Traversal stays INSIDE a corpus (mig 052 pins a fact's endpoints to its own corpus), so the
 * only cross-corpus step is the shared concept node. That is the "corpora meet only via the
 * super-graph" property, enforced by the schema rather than by convention.
 *
 * PATH COST IS NOT OPTIONAL. doc 34 §5: unbounded traversal from a concept reaches nearly
 * everything (the god-object risk of doc-08, and the mirror of doc-32's generic-hub failure).
 * Two dampers, both explicit:
 *   - `decay^(hops_source + hops_target)` — a distant path is weaker than a direct one.
 *   - `idf(concept)` over concept document-frequency — a hub concept contributes little.
 * At hops=0 with decay=1 this reduces EXACTLY to the shipped single-hop candidate set, which
 * is the correctness anchor the accompanying harness asserts.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

const CONCEPT_CORPUS = '_concepts';

export interface MultiHopOptions {
  /** Max fact hops on EACH side (0 = the shipped single-hop shared-pivot JOIN). */
  hops?: number;
  /** Per-hop score damper in (0,1]. 1 = no distance penalty. */
  decay?: number;
  /** Drop pairs scoring below this (after decay+idf). 0 = keep everything. */
  minScore?: number;
  /** Hard cap on returned pairs; the caller is warned rather than silently truncated. */
  maxPairs?: number;
  /**
   * Concept entity ids to exclude from the pivot set entirely — they link nothing, and they
   * drop out of the `concept_df` denominator too, since df is derived from the same CTEs.
   *
   * This exists for doc-35 §6/§7.3's hub diagnostic: "coverage and AUC recomputed with the
   * top-3 highest-degree concepts excluded", the detector for doc-32's failure where reach
   * rose only because a few generic hubs joined everything. It cannot be done by filtering
   * the returned pairs — a `MultiHopPair` is already aggregated over its linking concepts and
   * does not carry per-concept contributions — so the exclusion has to happen in the query.
   */
  excludeConceptIds?: string[];
}

export interface MultiHopPair {
  elementRef: string;
  ruleId: string;
  /** Σ over shared concepts of idf(c) · decay^(hops_source + hops_target), best path per concept. */
  score: number;
  /** Distinct concept nodes linking the pair. */
  sharedConcepts: number;
  /** Cheapest total hop count over all linking concepts (0 = direct shared pivot). */
  minHops: number;
}

function rows(r: unknown): Array<Record<string, unknown>> {
  return r as unknown as Array<Record<string, unknown>>;
}

/**
 * Concept-mediated candidates between two corpora, allowing up to `hops` fact-hops on each
 * side. Deterministic; no LLM, no embeddings — purely the symbolic graph.
 */
export async function recallMultiHopConcepts(
  sourceCorpusId: string,
  targetCorpusId: string,
  opts: MultiHopOptions = {},
): Promise<MultiHopPair[]> {
  const hops = opts.hops ?? 0;
  const decay = opts.decay ?? 0.5;
  const minScore = opts.minScore ?? 0;
  const maxPairs = opts.maxPairs ?? 100_000;
  if (hops < 0 || hops > 4) throw new Error(`hops must be 0..4 (got ${hops}) — deeper is unbounded in practice`);
  if (decay <= 0 || decay > 1) throw new Error(`decay must be in (0,1] (got ${decay})`);
  const exclude = opts.excludeConceptIds ?? [];
  // Inlined as a literal list rather than a bound array: this query is already assembled with
  // sql`` interpolation, and the ids are validated UUIDs from our own concept table.
  for (const id of exclude) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`excludeConceptIds must be UUIDs (got '${id}')`);
    }
  }
  const excludeSql = exclude.length === 0
    ? sql`TRUE`
    : sql.raw(`be.b_ref NOT IN (${exclude.map((i) => `'${i}'::uuid`).join(', ')})`);

  const r = rows(
    await db.execute(sql`
      WITH RECURSIVE
      -- Undirected fact adjacency within ONE corpus. Facts never cross corpora (mig 052),
      -- so this cannot leak between corpora by construction.
      reach_src AS (
        SELECT e.id AS root, e.id AS node, 0 AS hops
        FROM public.entities e WHERE e.corpus_id = ${sourceCorpusId}
        UNION
        SELECT r.root,
               CASE WHEN f.subject_entity_id = r.node THEN f.object_entity_id ELSE f.subject_entity_id END,
               r.hops + 1
        FROM reach_src r
        JOIN public.facts f
          ON (f.subject_entity_id = r.node OR f.object_entity_id = r.node)
        WHERE r.hops < ${hops}
          AND f.corpus_id = ${sourceCorpusId}
          AND f.expired_at IS NULL
          AND CASE WHEN f.subject_entity_id = r.node THEN f.object_entity_id ELSE f.subject_entity_id END IS NOT NULL
      ),
      reach_tgt AS (
        SELECT e.id AS root, e.id AS node, 0 AS hops
        FROM public.entities e WHERE e.corpus_id = ${targetCorpusId}
        UNION
        SELECT r.root,
               CASE WHEN f.subject_entity_id = r.node THEN f.object_entity_id ELSE f.subject_entity_id END,
               r.hops + 1
        FROM reach_tgt r
        JOIN public.facts f
          ON (f.subject_entity_id = r.node OR f.object_entity_id = r.node)
        WHERE r.hops < ${hops}
          AND f.corpus_id = ${targetCorpusId}
          AND f.expired_at IS NULL
          AND CASE WHEN f.subject_entity_id = r.node THEN f.object_entity_id ELSE f.subject_entity_id END IS NOT NULL
      ),
      -- Cheapest way each root reaches each concept (a root may touch one concept by several paths).
      src_concept AS (
        SELECT r.root, be.b_ref AS concept, min(r.hops) AS hops
        FROM reach_src r
        JOIN public.bridge_edges be
          ON be.a_ref = r.node AND be.relation = 'exhibits'
         AND be.b_kind = 'entity' AND be.target_corpus_id = ${CONCEPT_CORPUS} AND be.expired_at IS NULL
        WHERE ${excludeSql}
        GROUP BY r.root, be.b_ref
      ),
      tgt_concept AS (
        SELECT r.root, be.b_ref AS concept, min(r.hops) AS hops
        FROM reach_tgt r
        JOIN public.bridge_edges be
          ON be.a_ref = r.node AND be.relation = 'addresses'
         AND be.b_kind = 'entity' AND be.target_corpus_id = ${CONCEPT_CORPUS} AND be.expired_at IS NULL
        WHERE ${excludeSql}
        GROUP BY r.root, be.b_ref
      ),
      -- Document frequency of a concept = how many roots (either side) can reach it. This is the
      -- anti-hub term: a concept everything reaches carries almost no information.
      concept_df AS (
        SELECT concept, count(*)::numeric AS df FROM (
          SELECT concept, root FROM src_concept UNION ALL SELECT concept, root FROM tgt_concept
        ) x GROUP BY concept
      ),
      total AS (SELECT greatest(count(*), 1)::numeric AS n FROM (
        SELECT id FROM public.entities WHERE corpus_id IN (${sourceCorpusId}, ${targetCorpusId})
      ) y)
      SELECT s.root::text AS element_ref,
             t.root::text AS rule_id,
             sum(ln((SELECT n FROM total) / d.df) * power(${decay}::numeric, s.hops + t.hops)) AS score,
             count(DISTINCT s.concept)::int AS shared_concepts,
             min(s.hops + t.hops)::int AS min_hops
      FROM src_concept s
      JOIN tgt_concept t ON t.concept = s.concept
      JOIN concept_df d ON d.concept = s.concept
      GROUP BY s.root, t.root
      HAVING sum(ln((SELECT n FROM total) / d.df) * power(${decay}::numeric, s.hops + t.hops)) >= ${minScore}
      ORDER BY score DESC, element_ref, rule_id
      LIMIT ${maxPairs + 1}
    `),
  );

  if (r.length > maxPairs) {
    console.warn(
      `[concept-multihop] ${sourceCorpusId}→${targetCorpusId} hops=${hops} hit maxPairs=${maxPairs}; ` +
        `truncated — raise maxPairs or tighten hops/minScore to cover the tail`,
    );
  }
  return r.slice(0, maxPairs).map((row) => ({
    elementRef: row.element_ref as string,
    ruleId: row.rule_id as string,
    score: Number(row.score),
    sharedConcepts: row.shared_concepts as number,
    minHops: row.min_hops as number,
  }));
}
