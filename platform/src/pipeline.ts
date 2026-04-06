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
import { getValidEntityTypes, resolveEntity, linkMemoryToEntity, findSimilarEntities } from './services/entities.js';
import { CANONICAL_ONTOLOGY, normalizePredicate } from './services/predicates.js';
import { createFact } from './services/facts.js';

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

  // 5. Extract relationships
  const t3 = Date.now();
  const canonicalPredicates = Object.keys(CANONICAL_ONTOLOGY);
  const entityNames = resolvedEntities.map(e => ({ name: e.canonicalName, type: e.entityType }));
  const { relationships } = await ml.extractRelationships(content, entityNames, canonicalPredicates);
  timing.extractRelationships = Date.now() - t3;

  // 6. Match relationship subjects/objects to resolved entities (multi-tier)
  const t4 = Date.now();
  const matchedRelationships: MatchedRelationship[] = [];
  for (const rel of relationships) {
    const subjectMatch = await matchEntityReference(rel.subject, resolvedEntities);
    const objectMatch = await matchEntityReference(rel.object, resolvedEntities);

    if (!subjectMatch) {
      skipped.push({ subject: rel.subject, predicate: rel.predicate, object: rel.object, reason: `subject "${rel.subject}" unresolved` });
      continue;
    }
    if (!objectMatch) {
      skipped.push({ subject: rel.subject, predicate: rel.predicate, object: rel.object, reason: `object "${rel.object}" unresolved` });
      continue;
    }

    const predicate = normalizePredicate(rel.predicate);
    matchedRelationships.push({
      subjectId: subjectMatch.id, subjectName: subjectMatch.canonicalName,
      objectId: objectMatch.id, objectName: objectMatch.canonicalName,
      predicate, confidence: rel.confidence,
      temporalHint: rel.temporal_hint, sourceText: rel.source_text,
    });
  }
  timing.matchRelationships = Date.now() - t4;

  // 7. Create facts from matched relationships
  const t5 = Date.now();
  for (const rel of matchedRelationships) {
    const { validAt, invalidAt } = computeTemporal(rel.temporalHint);
    const factId = await createFact({
      subjectEntityId: rel.subjectId,
      predicate: rel.predicate,
      objectEntityId: rel.objectId,
      validAt,
      invalidAt,
      sourceMemoryId: memoryId,
      sourceText: rel.sourceText,
      confidence: rel.confidence,
    });
    createdFacts.push({
      id: factId,
      subject: rel.subjectName,
      predicate: rel.predicate,
      object: rel.objectName,
      confidence: rel.confidence,
    });
  }
  timing.createFacts = Date.now() - t5;

  return { memoryId, entities: resolvedEntities, facts: createdFacts, skipped, filtered, timing };
}

/**
 * Map temporal hints from ML extraction to validAt/invalidAt dates.
 */
function computeTemporal(hint?: string): { validAt: Date; invalidAt?: Date } {
  const now = new Date();
  switch (hint?.toLowerCase()) {
    case 'past': {
      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      return { validAt: yearAgo, invalidAt: now };
    }
    case 'future': {
      const monthAhead = new Date(now);
      monthAhead.setMonth(monthAhead.getMonth() + 1);
      return { validAt: monthAhead };
    }
    case 'current':
    default:
      return { validAt: now };
  }
}

interface MatchedRelationship {
  subjectId: string; subjectName: string;
  objectId: string; objectName: string;
  predicate: string; confidence: number;
  temporalHint?: string; sourceText?: string;
}

/**
 * Multi-tier entity reference matching:
 * 1. Exact case-insensitive match
 * 2. Substring match ("Captain Walton" matches "Walton")
 * 3. Embedding similarity (handles "the narrator" → "R. Walton")
 * 4. Skip with warning
 */
async function matchEntityReference(
  reference: string,
  resolved: ResolvedEntity[],
): Promise<ResolvedEntity | null> {
  const refLower = reference.toLowerCase();

  // Tier 1: exact case-insensitive
  const exact = resolved.find(e => e.canonicalName.toLowerCase() === refLower);
  if (exact) return exact;

  // Tier 2: substring (either direction)
  const substring = resolved.find(e => {
    const nameLower = e.canonicalName.toLowerCase();
    return nameLower.includes(refLower) || refLower.includes(nameLower);
  });
  if (substring) return substring;

  // Tier 3: embedding similarity
  try {
    const { vector } = await ml.embed(reference);
    const similar = await findSimilarEntities(vector, { limit: 1, threshold: 0.75 });
    if (similar.length > 0) {
      const match = resolved.find(e => e.id === similar[0]!.id);
      if (match) return match;
    }
  } catch { /* embedding unavailable — skip to tier 4 */ }

  // Tier 4: no match
  return null;
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
