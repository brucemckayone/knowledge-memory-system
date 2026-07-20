/**
 * Concept resolution (cross-corpus concept layer, bead nmemo-uhp.22, doc 19 §3.5).
 *
 * Collapses duplicate concept nodes in the '_concepts' corpus so the symbolic
 * concept JOIN (recallByConcept) connects through ONE node per mechanism. Three
 * stages:
 *
 *   1. Candidate discovery — pg_trgm similarity() over concept canonical_names
 *      (reuses idx_entities_name_trgm). LEXICAL, not embedding: doc 18 found the
 *      lexical signal as strong as the embedding, with no ML dependency (D-C2 /
 *      the doc-18 "use the lexical signal first-class" call). NOTE: this surfaces
 *      lexically-close pairs only — casing/hyphen/word-order variants and shared
 *      stems. Semantically-equivalent-but-lexically-distant names (heap-allocation
 *      vs dynamic-memory-allocation) are out of v1 reach; the extraction prompt
 *      nudges the model toward canonical reusable names to limit that at source.
 *   2. Equivalence judge — an (injectable) Haiku call decides, per candidate pair,
 *      whether the two names denote the SAME mechanism. This is the load-bearing
 *      step: lexical closeness is NOT equivalence (heap-allocation vs
 *      stack-allocation are trigram-close but OPPOSITE), so the judge rejects
 *      lexical-lookalikes the discovery step cannot tell apart.
 *   3. Merge — mergeEntities collapses the loser into the winner. mergeEntities
 *      (extended for nmemo-uhp.22) re-points the loser's exhibits/addresses
 *      bridges to the survivor with dedup-before-repoint (nmemo-9vk discipline), so
 *      the JOIN stays intact and no partial-unique index throws.
 *
 * Gardener-invocable (a maintenance pass, like reconciliation). Haiku-first: the
 * judge is injectable so tests run deterministically with a fake.
 */

import { sql } from 'drizzle-orm';
import { rawQuery } from '../db/raw.js';
import { mergeEntities } from './entities.js';
import { CONCEPT_CORPUS } from './concept-extraction.js';

/** Decides whether two concept names denote the same mechanism. */
export type ConceptEquivalenceJudge = (nameA: string, nameB: string) => Promise<boolean>;

/** Build the equivalence-judge prompt. Pure; no LLM. */
export function buildConceptEquivalencePrompt(a: string, b: string): string {
  return [
    'You are deduplicating CONCEPT nodes in a knowledge graph for safety-critical',
    'software review. Decide whether the two concept names below denote the SAME',
    'underlying technical mechanism. Mere wording/format differences (casing, hyphen',
    'vs space, singular/plural, word order) = SAME. Related-but-distinct or OPPOSITE',
    'mechanisms = NOT same (e.g. heap-allocation vs stack-allocation are DIFFERENT).',
    '',
    'Answer with a JSON object: { "same": true } or { "same": false }.',
    '',
    `Concept A: ${a}`,
    `Concept B: ${b}`,
  ].join('\n');
}

/** Lazy default judge — Haiku, mirrors the injectable-generator pattern. */
const defaultJudge: ConceptEquivalenceJudge = async (a, b) => {
  const { ml } = await import('./ml-client.js');
  const raw = await ml.generateJson(buildConceptEquivalencePrompt(a, b));
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return o.same === true;
};

/** A lexically-similar concept pair proposed for equivalence judging. */
export interface ConceptCandidate {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  /** Live bridge counts — the more-connected node wins the merge. */
  bridgesA: number;
  bridgesB: number;
  /** Trigram similarity of the two names. */
  sim: number;
}

/**
 * Discover lexically-similar concept pairs (a.id < b.id, dedup + no self-pair)
 * above `threshold`, most-similar first. O(n²) over the concept vocabulary —
 * acceptable at concept scale (hundreds of nodes), unlike the full entity table.
 */
export async function discoverConceptCandidates(threshold: number, maxPairs: number): Promise<ConceptCandidate[]> {
  return rawQuery<ConceptCandidate>(sql`
    SELECT
      a.id::text AS a_id, a.canonical_name AS a_name,
      b.id::text AS b_id, b.canonical_name AS b_name,
      (SELECT count(*)::int FROM public.bridge_edges e
         WHERE e.expired_at IS NULL AND (e.a_ref = a.id OR e.b_ref = a.id)) AS bridges_a,
      (SELECT count(*)::int FROM public.bridge_edges e
         WHERE e.expired_at IS NULL AND (e.a_ref = b.id OR e.b_ref = b.id)) AS bridges_b,
      similarity(a.canonical_name, b.canonical_name) AS sim
    FROM public.entities a
    JOIN public.entities b
      ON b.corpus_id = ${CONCEPT_CORPUS} AND b.entity_type = 'concept' AND a.id < b.id
    WHERE a.corpus_id = ${CONCEPT_CORPUS} AND a.entity_type = 'concept'
      AND similarity(a.canonical_name, b.canonical_name) > ${threshold}
    ORDER BY sim DESC, a_id, b_id
    LIMIT ${maxPairs}
  `);
}

export interface ResolveConceptsParams {
  /** Trigram similarity floor for candidate pairs (default 0.4). */
  threshold?: number;
  /** Safety cap on candidate pairs considered (default 500). */
  maxPairs?: number;
  /** Injectable equivalence judge (default = Haiku). */
  judge?: ConceptEquivalenceJudge;
}

export interface ResolveConceptsResult {
  /** Candidate pairs surfaced by trigram discovery. */
  pairsConsidered: number;
  /** Pairs the judge confirmed as the same mechanism. */
  judgedSame: number;
  /** Concept nodes merged away (== confirmed pairs actually merged this pass). */
  merged: number;
}

/**
 * Run one concept-resolution pass: discover lexical candidates, judge each, and
 * merge confirmed-equivalent pairs (more-connected node wins; ties → smaller id).
 * A node merged away this pass is skipped in later pairs (its id is gone). Cascades
 * beyond one pass resolve on the next invocation.
 */
export async function resolveConcepts(params: ResolveConceptsParams = {}): Promise<ResolveConceptsResult> {
  const threshold = params.threshold ?? 0.4;
  const maxPairs = params.maxPairs ?? 500;
  const judge = params.judge ?? defaultJudge;

  const candidates = await discoverConceptCandidates(threshold, maxPairs);
  const mergedAway = new Set<string>();
  let judgedSame = 0;
  let merged = 0;

  for (const c of candidates) {
    // An endpoint merged away earlier this pass no longer exists — skip.
    if (mergedAway.has(c.aId) || mergedAway.has(c.bId)) continue;
    if (!(await judge(c.aName, c.bName))) continue;
    judgedSame += 1;

    // Winner = the more-connected concept (preserve the established node);
    // tie → smaller id (deterministic).
    let winner: string;
    let loser: string;
    if (c.bridgesA > c.bridgesB) {
      [winner, loser] = [c.aId, c.bId];
    } else if (c.bridgesB > c.bridgesA) {
      [winner, loser] = [c.bId, c.aId];
    } else if (c.aId < c.bId) {
      [winner, loser] = [c.aId, c.bId];
    } else {
      [winner, loser] = [c.bId, c.aId];
    }

    await mergeEntities({
      sourceId: loser,
      targetId: winner,
      reason: `Concept resolution: "${c.aName}" == "${c.bName}" (trigram ${c.sim.toFixed(2)}, judge confirmed)`,
      method: 'llm_verified',
      score: c.sim,
    });
    mergedAway.add(loser);
    merged += 1;
  }

  return { pairsConsidered: candidates.length, judgedSame, merged };
}
