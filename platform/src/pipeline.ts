/**
 * Pipeline — Core data flow for the sparse truth graph.
 *
 * store(text)   → embed + Qdrant write → returns memoryId
 * extract(id)   → entities + relationships + facts from stored memory
 * ingest(text)  → store + auto-extract (the default entry point)
 */

export interface ExtractResult {
  memoryId: string;
  entities: ResolvedEntity[];
  facts: CreatedFact[];
  skipped: SkippedRelationship[];
  filtered: string[];
  timing: Record<string, number>;
}

export interface IngestResult extends ExtractResult {}

export interface ResolvedEntity {
  id: string;
  canonicalName: string;
  entityType: string;
  isNew: boolean;
  confidence: number;
}

export interface CreatedFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface SkippedRelationship {
  subject: string;
  predicate: string;
  object: string;
  reason: string;
}

/**
 * Store raw text in Qdrant with embedding. Fast — just embed + store.
 * Returns the memoryId which can be used for later extraction.
 */
export async function store(
  text: string,
  metadata?: { source?: string; timestamp?: Date }
): Promise<string> {
  // TODO: A05+ implementation
  throw new Error('Not implemented — see A05+ issues');
}

/**
 * Extract entities and relationships from an already-stored memory.
 * Can be called immediately after store() or later for batch processing.
 * Can be called again after bug fixes for re-extraction.
 */
export async function extract(memoryId: string): Promise<ExtractResult> {
  // TODO: A05+ implementation
  throw new Error('Not implemented — see A05+ issues');
}

/**
 * Store + auto-extract. The default entry point for most usage.
 * Equivalent to: const id = await store(text); return await extract(id);
 */
export async function ingest(
  text: string,
  metadata?: { source?: string; timestamp?: Date }
): Promise<IngestResult> {
  // TODO: A05+ implementation
  throw new Error('Not implemented — see A05+ issues');
}
