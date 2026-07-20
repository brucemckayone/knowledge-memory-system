/**
 * Element Catalogs Service (cross-corpus Phase A, bead nmemo-uhp.10)
 *
 * The code/rule element catalogs are BARE rows (code_elements / rule_elements),
 * never `entities` — zero fusion surface by construction (D1). Their ids are
 * derived by a PURE resolver (resolveElementRef / resolveRuleElementRef):
 * element_ref = uuidV5(scheme|corpus|canonical_symbol), so ids are stable and
 * hand-seedable with no DB round-trip. element_embeddings is the dedicated
 * behaviour/rule-text vector table E1 recall queries cross-corpus over.
 *
 * Spec: docs/architecture/cross-corpus-audit/04-hardened-spec.md §3 (D1) and §4
 * (resolveElementRef). Schema: migration 053_element_catalogs.sql.
 *
 * The `uuid` package is not a dependency, so uuidv5 is hand-rolled via
 * node:crypto sha1 — same approach CLAUDE.md sanctions and pipeline.ts already
 * uses for deterministic point ids. DB writes use raw SQL with `public.`
 * qualifiers (AGE search_path gotcha, per CLAUDE.md) and mirror the
 * INSERT ... ON CONFLICT DO UPDATE / pgvector-literal patterns in
 * services/facts.ts (recordFactSource) and services/entities.ts.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';

// Fixed namespace UUIDs for element_ref derivation — NEVER CHANGE after data
// exists (the spec freezes element_ref at Phase A). Distinct so a code element
// and a rule element can never collide on the same name string.
const CODE_ELEMENT_NS = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const RULE_ELEMENT_NS = '1b671a64-40d5-491e-99b0-da01ff1f3341';

/**
 * Hand-rolled RFC-4122 v5 (SHA-1 of namespace||name) — no dependency, since the
 * `uuid` package is not installed and CLAUDE.md sanctions `node:crypto`. Output
 * is a canonical lowercase UUID string. Version nibble is set to 5 (0x50) and
 * the RFC-4122 variant to 0x80. Mirrors pipeline.ts / utils/context-uuid.ts.
 */
function uuidv5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = hash.subarray(0, 16);
  // SHA-1 always yields 20 bytes, so indices 6 and 8 are always present.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Lowercase hex sha256 of a UTF-8 string. */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ============================================
// Pure resolvers (no DB — hand-seedable, order-independent)  [§4, D1]
// ============================================

/** A code element to resolve: either a SCIP symbol or raw content to hash. */
export interface CodeElementNode {
  corpusId: string;
  /** SCIP symbol when available (scheme='scip'); else omit and pass `content`. */
  scipSymbol?: string;
  /** Raw element content, hashed to the canonical symbol when no SCIP symbol. */
  content?: string;
}

/** Result of {@link resolveElementRef} — the derived id plus its inputs. */
export interface ResolvedElementRef {
  elementRef: string;
  scheme: 'scip' | 'ast';
  canonicalSymbol: string;
}

/**
 * Resolve a code element's stable id. PURE — no DB, no side effects (§4).
 *
 *   canonical = scipSymbol ?? sha256(content)
 *   scheme    = scipSymbol ? 'scip' : 'ast'
 *   elementRef = uuidV5(CODE_ELEMENT_NS, `${scheme}|${corpusId}|${canonical}`)
 */
export function resolveElementRef(node: CodeElementNode): ResolvedElementRef {
  const scheme: 'scip' | 'ast' = node.scipSymbol ? 'scip' : 'ast';
  let canonicalSymbol: string;
  if (node.scipSymbol) {
    canonicalSymbol = node.scipSymbol;
  } else {
    if (node.content == null) {
      throw new Error('resolveElementRef: node must have scipSymbol or content');
    }
    canonicalSymbol = sha256(node.content);
  }
  const elementRef = uuidv5(CODE_ELEMENT_NS, `${scheme}|${node.corpusId}|${canonicalSymbol}`);
  return { elementRef, scheme, canonicalSymbol };
}

/**
 * Resolve a rule element's stable id. PURE — no DB.
 *
 *   elementRef = uuidV5(RULE_ELEMENT_NS, `${corpusId}|${ruleId}`)
 */
export function resolveRuleElementRef(node: { corpusId: string; ruleId: string }): string {
  return uuidv5(RULE_ELEMENT_NS, `${node.corpusId}|${node.ruleId}`);
}

// ============================================
// Catalog upserts (INSERT ... ON CONFLICT (element_ref) DO UPDATE)
// ============================================

export interface UpsertCodeElementParams extends CodeElementNode {
  sourceCommit?: string;
  contentHash?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  /** 'live' | 'stale' | 'removed' (DB CHECK). Defaults to 'live'. */
  status?: string;
}

/**
 * Upsert a code element. element_ref is derived from the resolver so the same
 * (scheme, corpus, canonical) always maps to the same row. Returns the
 * resolved id + scheme + canonical symbol.
 */
export async function upsertCodeElement(params: UpsertCodeElementParams): Promise<ResolvedElementRef> {
  const resolved = resolveElementRef(params);
  await db.execute(sql`
    INSERT INTO public.code_elements (
      element_ref, corpus_id, scheme, canonical_symbol,
      source_commit, content_hash, file_path, line_start, line_end, status
    ) VALUES (
      ${resolved.elementRef}::uuid, ${params.corpusId}, ${resolved.scheme}, ${resolved.canonicalSymbol},
      ${params.sourceCommit ?? null}, ${params.contentHash ?? null},
      ${params.filePath ?? null}, ${params.lineStart ?? null}, ${params.lineEnd ?? null},
      ${params.status ?? 'live'}
    )
    ON CONFLICT (element_ref) DO UPDATE SET
      corpus_id        = EXCLUDED.corpus_id,
      scheme           = EXCLUDED.scheme,
      canonical_symbol = EXCLUDED.canonical_symbol,
      source_commit    = COALESCE(EXCLUDED.source_commit, public.code_elements.source_commit),
      content_hash     = COALESCE(EXCLUDED.content_hash, public.code_elements.content_hash),
      file_path        = COALESCE(EXCLUDED.file_path, public.code_elements.file_path),
      line_start       = COALESCE(EXCLUDED.line_start, public.code_elements.line_start),
      line_end         = COALESCE(EXCLUDED.line_end, public.code_elements.line_end),
      status           = EXCLUDED.status
  `);
  return resolved;
}

export interface UpsertRuleElementParams {
  corpusId: string;
  ruleId: string;
  ruleSetHash?: string;
}

/**
 * Upsert a rule element. element_ref is derived from the resolver. Returns the
 * resolved id.
 */
export async function upsertRuleElement(params: UpsertRuleElementParams): Promise<string> {
  const elementRef = resolveRuleElementRef(params);
  await db.execute(sql`
    INSERT INTO public.rule_elements (element_ref, corpus_id, rule_id, rule_set_hash)
    VALUES (${elementRef}::uuid, ${params.corpusId}, ${params.ruleId}, ${params.ruleSetHash ?? null})
    ON CONFLICT (element_ref) DO UPDATE SET
      corpus_id     = EXCLUDED.corpus_id,
      rule_id       = EXCLUDED.rule_id,
      rule_set_hash = COALESCE(EXCLUDED.rule_set_hash, public.rule_elements.rule_set_hash)
  `);
  return elementRef;
}

// ============================================
// Embedding substrate (pgvector; E1 recall)
// ============================================

/**
 * Upsert an element's embedding row. The vector is written via a raw pgvector
 * literal (mirrors entities.ts) since the `embedding` column is not declared in
 * Drizzle. `kind` is 'behaviour' (code) or 'rule_text' (standard).
 */
export async function upsertElementEmbedding(
  elementRef: string,
  corpusId: string,
  kind: 'behaviour' | 'rule_text',
  text: string,
  embedding: number[],
): Promise<void> {
  const vectorLiteral = sql.raw(`'[${embedding.join(',')}]'::vector`);
  await db.execute(sql`
    INSERT INTO public.element_embeddings (element_ref, corpus_id, kind, text, embedding)
    VALUES (${elementRef}::uuid, ${corpusId}, ${kind}, ${text}, ${vectorLiteral})
    ON CONFLICT (element_ref) DO UPDATE SET
      corpus_id = EXCLUDED.corpus_id,
      kind      = EXCLUDED.kind,
      text      = EXCLUDED.text,
      embedding = EXCLUDED.embedding
  `);
}

/** A single cross-corpus recall hit. */
export interface CrossCorpusRecallHit {
  elementRef: string;
  text: string;
  similarity: number;
}

/**
 * The E1 substrate query: cosine nearest-neighbour over element_embeddings,
 * scoped to a single target corpus + kind. Returns the top-k by cosine
 * distance (default k=5), each with cosine similarity (1 - distance).
 */
export async function recallAcrossCorpus(
  queryEmbedding: number[],
  opts: { targetCorpusId: string; kind: 'behaviour' | 'rule_text'; k?: number },
): Promise<CrossCorpusRecallHit[]> {
  const { targetCorpusId, kind, k = 5 } = opts;
  const queryVector = sql.raw(`'[${queryEmbedding.join(',')}]'::vector`);
  return rawQuery<CrossCorpusRecallHit>(sql`
    SELECT
      element_ref::text AS element_ref,
      text,
      1 - (embedding <=> ${queryVector}) AS similarity
    FROM public.element_embeddings
    WHERE corpus_id = ${targetCorpusId}
      AND kind = ${kind}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${queryVector}
    LIMIT ${k}
  `);
}

/** A concept-mediated recall hit: a rule element reachable from a code element
 *  because they share one or more concept nodes. */
export interface ConceptRecallHit {
  /** The rule element's ref (entity id in the shipped ingest representation). */
  ruleElementRef: string;
  /** How many distinct concept nodes the code and rule elements share. */
  sharedConcepts: number;
  /** The shared concept node ids (the JOIN pivots) — the "why" for the adjudicator. */
  conceptRefs: string[];
}

/**
 * Symbolic-JOIN recall (doc 19 §3.3) — the concept layer's load-bearing recall
 * path, replacing the cosine gamble of {@link recallAcrossCorpus}. Given a code
 * element, walk
 *
 *   code_element --exhibits--> concept <--addresses-- rule_element
 *
 * over the bridge_edges family (live edges only) and return the rule elements
 * sharing at least one concept node, ranked by shared-concept count. No
 * embedding — the shared concept node IS the bridge. The relation discriminates
 * the two sides ('exhibits' = code, 'addresses' = rule); b_kind='entity' asserts
 * the shared pivot is a concept node.
 *
 * Returns []
 *  — when the code element has no exhibits edges yet (e.g. before extraction has
 *    run), so this composes safely as an *additional* candidate source.
 *
 * @param codeElementRef the code element's ref (a_ref of its exhibits edges)
 * @param opts.ruleCorpusId restrict rule matches to this corpus (be_rule.source_corpus_id)
 * @param opts.k            cap on rows returned (default: unbounded)
 */
export async function recallByConcept(
  codeElementRef: string,
  opts: { ruleCorpusId?: string; k?: number } = {},
): Promise<ConceptRecallHit[]> {
  const { ruleCorpusId, k } = opts;
  const ruleCorpusFilter = ruleCorpusId
    ? sql`AND be_rule.source_corpus_id = ${ruleCorpusId}`
    : sql``;
  const limit = k != null ? sql`LIMIT ${k}` : sql``;
  return rawQuery<ConceptRecallHit>(sql`
    SELECT
      be_rule.a_ref::text                     AS rule_element_ref,
      count(DISTINCT be_code.b_ref)::int      AS shared_concepts,
      array_agg(DISTINCT be_code.b_ref::text) AS concept_refs
    FROM public.bridge_edges be_code
    JOIN public.bridge_edges be_rule
      ON be_rule.b_ref = be_code.b_ref
    WHERE be_code.a_ref      = ${codeElementRef}::uuid
      AND be_code.relation   = 'exhibits'
      AND be_code.b_kind     = 'entity'
      AND be_code.expired_at IS NULL
      AND be_rule.relation   = 'addresses'
      AND be_rule.b_kind     = 'entity'
      AND be_rule.expired_at IS NULL
      ${ruleCorpusFilter}
    GROUP BY be_rule.a_ref
    ORDER BY shared_concepts DESC, rule_element_ref
    ${limit}
  `);
}
