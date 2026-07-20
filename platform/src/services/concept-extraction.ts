/**
 * Concept extraction (cross-corpus concept layer, bead nmemo-uhp.21, doc 19 §3.4).
 *
 * A SEPARATE Haiku pass (distinct from element-authoring, D-C6) that labels an
 * ingested element with the concepts it EXHIBITS (code) / ADDRESSES (rule), then
 * links each label to a concept node via an exhibits/addresses bridge_edge:
 *
 *   code --exhibits--> concept <--addresses-- rule
 *
 * Concepts are `entities` with entity_type='concept' living in the reserved
 * '_concepts' corpus (D-C1/D-C2). Resolution here is FIND-OR-CREATE BY NAME ONLY —
 * fuzzy equivalence merge (heap-allocation vs dynamic-memory-allocation) is
 * deferred entirely to concept resolution (nmemo-uhp.22, doc 19 §3.5), keeping the
 * bead boundary clean. Concepts are created WITHOUT an embedding; .22 backfills it
 * as the merge-time candidate-discovery helper.
 *
 * Bridges are staged directly (this is a deterministic platform pass, not the MCP
 * adjudicator — propose_bridge_edge is verdict-only) and disposed through the
 * shared applyBridgePromotion path. reasoning + source_references stay
 * NON-NEGOTIABLE (D-C5), enforced by the mig 054/057 CHECKs.
 *
 * Haiku-first: the JSON generator is injectable (default = ml.generateJson, lazy
 * import) so tests run deterministically with a fake and never touch the network.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { jsonbLiteral, unwrapRows } from './audit.js';
import { applyBridgePromotion } from './bridge-promotion.js';
import type { FacetGenerator } from './element-authoring.js';

/** The reserved shared corpus every concept node lives in (D-C2, mig 057). */
export const CONCEPT_CORPUS = '_concepts';

/** Lazy default generator — mirrors element-authoring.ts (avoids env validation at
 *  module load so pure unit tests injecting a fake never trip config.exit()). */
const defaultGenerator: FacetGenerator = async (prompt) => {
  const { ml } = await import('./ml-client.js');
  return ml.generateJson(prompt);
};

/** A single extracted concept label: the concept name + a grounded one-line reason. */
export interface ConceptLabel {
  /** Normalized concept name (lower-case, trimmed, single-spaced). */
  name: string;
  /** Model's justification, grounded in the element — becomes the bridge reasoning. */
  reason: string;
}

/**
 * Normalize a concept name for find-or-create dedup: trim, lower-case, collapse
 * internal whitespace. Deliberately conservative — near-synonyms (e.g. hyphen vs
 * space, or "dynamic memory" vs "heap allocation") are NOT collapsed here; that is
 * .22's fuzzy-merge job.
 */
export function normalizeConceptName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Coerce arbitrary model JSON to a deduped {@link ConceptLabel}[]. Defensive:
 * accepts `{ concepts: [{ name, reason }] }`, drops entries with no name, dedups by
 * normalized name (first reason wins), never throws.
 */
export function coerceConceptLabels(raw: unknown): ConceptLabel[] {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(o.concepts) ? o.concepts : [];
  const seen = new Set<string>();
  const out: ConceptLabel[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = normalizeConceptName(typeof rec.name === 'string' ? rec.name : '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, reason: typeof rec.reason === 'string' ? rec.reason.trim() : '' });
  }
  return out;
}

/** Build the blind concept-extraction prompt (doc 19 §3.4). Pure; no LLM. */
export function buildConceptExtractionPrompt(side: 'code' | 'rule', name: string, text: string): string {
  if (side === 'code') {
    return [
      'You are labelling a C or C++ code element with the technical CONCEPTS (mechanisms)',
      'it EXHIBITS, for a knowledge graph used in safety-critical software review. A concept',
      'is a short, REUSABLE noun-phrase naming a mechanism the code demonstrably uses —',
      'e.g. heap-allocation, ownership-transfer, raw-pointer-arithmetic, lock-acquisition,',
      'recursion, integer-narrowing, dynamic-cast.',
      '',
      'STRICT RULES:',
      '- Base your answer solely on the code. Do NOT name, cite, or paraphrase any coding',
      '  standard, guideline, or rule (no "MISRA"/"CERT"/"AUTOSAR", no rule ids like "21.18").',
      '- Use concise lower-case hyphenated names, and prefer established reusable terms so the',
      '  SAME mechanism in different code gets the SAME name.',
      '- List only concepts the code actually exhibits; give a one-line reason grounded in the code.',
      '',
      'Return a JSON object: { "concepts": [ { "name": "<concept>", "reason": "<why, from the code>" } ] }.',
      '',
      `Element name: ${name}`,
      'Code:',
      text,
    ].join('\n');
  }
  return [
    'You are labelling a coding-standard guideline with the technical CONCEPTS (mechanisms)',
    'it ADDRESSES, for a knowledge graph used in safety-critical software review. A concept is',
    'a short, REUSABLE noun-phrase naming a mechanism the rule governs — e.g. heap-allocation,',
    'ownership-transfer, implicit-conversion, uninitialised-read.',
    '',
    'STRICT RULES:',
    '- Base your answer solely on the guideline text. Do NOT reference other rules or a specific',
    '  source-code file.',
    '- Use concise lower-case hyphenated names, and prefer established reusable terms so a code',
    '  element exhibiting the SAME mechanism will match by the SAME name.',
    '- Give a one-line reason grounded in the guideline.',
    '',
    'Return a JSON object: { "concepts": [ { "name": "<concept>", "reason": "<why, from the guideline>" } ] }.',
    '',
    `Guideline id: ${name}`,
    `Guideline: ${text}`,
  ].join('\n');
}

/**
 * Find-or-create a concept node by NAME (D-C1/D-C2). Advisory-locked on
 * (concept, _concepts, normalized-name) so concurrent extraction of the same
 * concept can't double-insert (mirrors upsertCorpusElementEntity's lock
 * discipline). Created without an embedding — .22 backfills it. Returns the id.
 */
export async function findOrCreateConcept(rawName: string): Promise<string> {
  const name = normalizeConceptName(rawName);
  if (!name) throw new Error('findOrCreateConcept: empty concept name');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`concept||${CONCEPT_CORPUS}||${name}`}))`);
    const existing = unwrapRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id::text AS id FROM public.entities
        WHERE corpus_id = ${CONCEPT_CORPUS} AND entity_type = 'concept' AND lower(canonical_name) = ${name}
        LIMIT 1
      `),
    );
    if (existing[0]) return existing[0].id;
    const inserted = unwrapRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO public.entities (canonical_name, entity_type, corpus_id, confidence)
        VALUES (${name}, 'concept', ${CONCEPT_CORPUS}, 1.0)
        RETURNING id::text AS id
      `),
    );
    return inserted[0]!.id;
  });
}

export interface ExtractConceptsParams {
  /** The element's entity id — the a_ref (source endpoint) of every bridge. */
  elementEntityId: string;
  /** The element's corpus — source_corpus_id of the bridges. */
  corpusId: string;
  /** 'code' → exhibits edges; 'rule' → addresses edges. */
  side: 'code' | 'rule';
  /** Symbol / rule id — prompt context only. */
  name: string;
  /** Source text: the code for a code element, the guideline text for a rule. */
  text: string;
  /** Injectable JSON generator (default = Haiku ml.generateJson). Tests inject a fake. */
  generate?: FacetGenerator;
}

export interface ExtractConceptsResult {
  /** Labels the model returned (post-coercion, deduped). */
  labels: ConceptLabel[];
  /** Resolved concept node ids linked this pass (order matches `labels`). */
  conceptIds: string[];
  /** Bridges created + corroborated by promotion. */
  linked: number;
}

/**
 * Extract the concepts an element exhibits/addresses and link them: label via the
 * (injectable) generator, find-or-create each into '_concepts', stage an
 * exhibits/addresses bridge per concept, then dispose the batch through
 * applyBridgePromotion. Returns [] links (no promotion) when the model emits no
 * usable concept — the element simply participates in no concept JOIN.
 */
export async function extractAndLinkConcepts(params: ExtractConceptsParams): Promise<ExtractConceptsResult> {
  const generate = params.generate ?? defaultGenerator;
  const raw = await generate(buildConceptExtractionPrompt(params.side, params.name, params.text));
  const labels = coerceConceptLabels(raw);
  if (labels.length === 0) return { labels, conceptIds: [], linked: 0 };

  const relation = params.side === 'code' ? 'exhibits' : 'addresses';
  const invocationId = randomUUID();
  const conceptIds: string[] = [];
  for (const label of labels) {
    const conceptId = await findOrCreateConcept(label.name);
    conceptIds.push(conceptId);
    // reasoning is NON-NEGOTIABLE (D-C5) — fall back to a synthesised line if the
    // model gave none, so the bridge CHECK never rejects a real concept link.
    const reasoning = label.reason || `${relation} concept "${label.name}"`;
    const sourceReferences = [{ type: 'entity', id: params.elementEntityId }];
    await db.execute(sql`
      INSERT INTO public.staging_bridge_edges
        (invocation_id, a_kind, a_ref, b_kind, b_ref, source_corpus_id, target_corpus_id, relation, reasoning, source_references)
      VALUES (
        ${invocationId}::uuid,
        'entity', ${params.elementEntityId}::uuid, 'entity', ${conceptId}::uuid,
        ${params.corpusId}, ${CONCEPT_CORPUS}, ${relation},
        ${reasoning}, ${jsonbLiteral(sourceReferences)}
      )
    `);
  }
  const promo = await applyBridgePromotion(invocationId);
  return { labels, conceptIds, linked: promo.created.length + promo.corroborated.length };
}
