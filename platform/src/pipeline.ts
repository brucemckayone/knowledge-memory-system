/**
 * Pipeline — Core data flow for the sparse truth graph.
 *
 * store(text)   → embed + Qdrant write → returns memoryId
 * extract(id)   → entities + relationships + facts from stored memory
 * ingest(text)  → store + auto-extract (the default entry point)
 */

import { randomUUID } from 'crypto';
import { ml } from './services/ml-client.js';
import { storeMemory, getMemory } from './services/qdrant.js';
import { getValidEntityTypes, resolveEntity, linkMemoryToEntity } from './services/entities.js';

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
  const memoryId = randomUUID();
  const { vector } = await ml.embed(text);
  await storeMemory({
    id: memoryId,
    vector,
    payload: {
      content: text,
      source: metadata?.source ?? 'cli',
      created_at: (metadata?.timestamp ?? new Date()).toISOString(),
      status: 'stored',
    },
  });
  return memoryId;
}

/**
 * Extract entities and relationships from an already-stored memory.
 * Can be called immediately after store() or later for batch processing.
 * Can be called again after bug fixes for re-extraction.
 */
export async function extract(memoryId: string): Promise<ExtractResult> {
  const timing: Record<string, number> = {};
  const filtered: string[] = [];
  const resolvedEntities: ResolvedEntity[] = [];
  const createdFacts: CreatedFact[] = [];
  const skipped: SkippedRelationship[] = [];

  // 1. Fetch memory from Qdrant
  const memory = await getMemory(memoryId);
  if (!memory?.payload) throw new Error(`Memory ${memoryId} not found in Qdrant`);
  const content = memory.payload.content as string;

  // 2. Extract entities via ML
  const t0 = Date.now();
  const validTypes = await getValidEntityTypes();
  const { entities: rawEntities } = await ml.extractEntities(content, validTypes);
  timing.extractEntities = Date.now() - t0;

  // 3. Specificity filter
  const t1 = Date.now();
  const accepted = rawEntities.filter(e => {
    // Low confidence
    if ((e.confidence ?? 1) < 0.5) {
      filtered.push(`${e.mention} [confidence ${e.confidence}]`);
      return false;
    }
    // Generic / anaphoric / common noun
    if (isGenericMention(e.mention)) {
      filtered.push(`${e.mention} [anaphoric/generic]`);
      return false;
    }
    return true;
  });
  timing.specificityFilter = Date.now() - t1;

  // 4. Resolve each entity
  const t2 = Date.now();
  for (const e of accepted) {
    const resolved = await resolveEntity(
      e.mention, content, e.type,
      { start: e.start, end: e.end }
    );
    await linkMemoryToEntity(memoryId, resolved.id, {
      text: e.mention, start: e.start, end: e.end,
    });
    resolvedEntities.push(resolved);
  }
  timing.resolveEntities = Date.now() - t2;

  // TODO: A11 adds relationship extraction, A13 adds fact creation
  // For now, return entities only

  return { memoryId, entities: resolvedEntities, facts: createdFacts, skipped, filtered, timing };
}

// --- Specificity filter ---

// Anaphoric references are never specific entities ("a lady", "the old man")
const ANAPHORIC_PATTERN = /^(a|an|the|his|her|my|their|some|this|that)\s/i;

function isGenericMention(mention: string): boolean {
  const trimmed = mention.trim();
  // Anaphoric references
  if (ANAPHORIC_PATTERN.test(trimmed)) return true;
  // Single character or empty
  if (trimmed.length <= 1) return true;
  return false;
}

/**
 * Store + auto-extract. The default entry point for most usage.
 * Equivalent to: const id = await store(text); return await extract(id);
 */
export async function ingest(
  _text: string,
  _metadata?: { source?: string; timestamp?: Date }
): Promise<IngestResult> {
  // TODO: A05+ implementation
  throw new Error('Not implemented — see A05+ issues');
}
