/**
 * provenance.ts — per-claim citation over the lineage backbone (nmemo-asf.2 /
 * doc 35 §4). Resolves a fact to its supporting source: the evidentiary window(s)
 * (fact_sources), the proof fragment(s) it maps onto (fact_units -> fragment), and
 * each fragment's transitive chain up to its source_document. This is the read
 * side the citation surface and held-out eval consume.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** One proof fragment for a claim, resolved transitively to its source document. */
export interface ProofFragment {
  fragmentId: string;
  kind: string; // 'window' | 'unit'
  parentId: string | null;
  charStart: number | null;
  charEnd: number | null;
  matchKind: string; // fact_units.match_kind: 'offset_overlap' | 'window_fallback'
  sourceDocumentId: string;
  externalSourceId: string | null;
  corpusId: string;
}

/** A supporting memory (window) for a fact, from fact_sources. */
export interface ClaimSource {
  memoryId: string;
  sourceText: string | null;
  observationCount: number;
}

export interface FactCitation {
  factId: string;
  sources: ClaimSource[];
  fragments: ProofFragment[];
}

/**
 * Resolve a fact to its full citation: supporting windows (fact_sources) + proof
 * fragments (fact_units -> fragment -> source_document). Empty arrays when the
 * fact has no recorded provenance (pre-backfill rows). Read-only.
 */
export async function getFactCitation(factId: string): Promise<FactCitation> {
  const sourceRows = (await db.execute(sql`
    SELECT memory_id, source_text, observation_count
    FROM public.fact_sources WHERE fact_id = ${factId}::uuid
    ORDER BY observed_at DESC
  `)) as unknown as Array<{ memory_id: string; source_text: string | null; observation_count: number }>;

  // fact_units.unit_point_id is the fragment id (same deterministic id space);
  // join to fragment (window or unit) and up to its source_document.
  const fragRows = (await db.execute(sql`
    SELECT fu.match_kind, f.id AS fragment_id, f.kind, f.parent_id, f.char_start, f.char_end,
           f.source_document_id, sd.external_source_id, sd.corpus_id
    FROM public.fact_units fu
    JOIN public.fragment f ON f.id = fu.unit_point_id::uuid
    JOIN public.source_document sd ON sd.id = f.source_document_id
    WHERE fu.fact_id = ${factId}::uuid
    ORDER BY f.char_start NULLS LAST
  `)) as unknown as Array<{
    match_kind: string; fragment_id: string; kind: string; parent_id: string | null;
    char_start: number | null; char_end: number | null;
    source_document_id: string; external_source_id: string | null; corpus_id: string;
  }>;

  return {
    factId,
    sources: sourceRows.map((r) => ({
      memoryId: r.memory_id,
      sourceText: r.source_text,
      observationCount: Number(r.observation_count),
    })),
    fragments: fragRows.map((r) => ({
      fragmentId: r.fragment_id,
      kind: r.kind,
      parentId: r.parent_id,
      charStart: r.char_start,
      charEnd: r.char_end,
      matchKind: r.match_kind,
      sourceDocumentId: r.source_document_id,
      externalSourceId: r.external_source_id,
      corpusId: r.corpus_id,
    })),
  };
}
