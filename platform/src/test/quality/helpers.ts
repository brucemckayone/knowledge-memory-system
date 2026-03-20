/**
 * Quality Test Helpers
 *
 * Utilities for computing metrics, seeding test data, and ML-as-judge verification.
 */

import {
  testDb,
  createTestEntity,
  createTestFact,
  randomEmbedding,
  randomUUID,
  isMLServiceAvailable,
  isQdrantAvailable,
  ML_SERVICES_URL,
  QDRANT_URL,
} from '../setup.js';
import type { SeededFact, GoldenEntity } from './golden-scenarios.js';

// --- Metric computation ---

/**
 * Compute recall: fraction of expected items that were found.
 * Uses fuzzy name matching (case-insensitive, substring).
 */
export function computeRecall(
  expected: string[],
  found: string[],
): number {
  if (expected.length === 0) return 1.0;
  const foundLower = found.map(f => f.toLowerCase());
  let hits = 0;
  for (const e of expected) {
    const eLower = e.toLowerCase();
    const matched = foundLower.some(
      f => f.includes(eLower) || eLower.includes(f),
    );
    if (matched) hits++;
  }
  return hits / expected.length;
}

/**
 * Compute precision: fraction of found items that were expected.
 */
export function computePrecision(
  expected: string[],
  found: string[],
): number {
  if (found.length === 0) return expected.length === 0 ? 1.0 : 0.0;
  const expectedLower = expected.map(e => e.toLowerCase());
  let hits = 0;
  for (const f of found) {
    const fLower = f.toLowerCase();
    const matched = expectedLower.some(
      e => e.includes(fLower) || fLower.includes(e),
    );
    if (matched) hits++;
  }
  return hits / found.length;
}

/**
 * Compute F1 from precision and recall.
 */
export function computeF1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Compute Mean Reciprocal Rank.
 * For each query, finds the rank of the first relevant result.
 */
export function computeMRR(
  results: Array<{ queryId: string; rankedIds: string[]; relevantIds: string[] }>,
): number {
  if (results.length === 0) return 0;
  let sumRR = 0;
  for (const { rankedIds, relevantIds } of results) {
    const relevantSet = new Set(relevantIds.map(id => id.toLowerCase()));
    const rank = rankedIds.findIndex(id => relevantSet.has(id.toLowerCase()));
    if (rank >= 0) {
      sumRR += 1 / (rank + 1);
    }
  }
  return sumRR / results.length;
}

// --- Data seeding ---

/** Entity name → ID cache within a seeding session */
type EntityCache = Map<string, string>;

/**
 * Seed a set of facts into the database, creating entities as needed.
 * Returns a map of entity name → entity ID for verification.
 */
export async function seedFacts(
  facts: SeededFact[],
): Promise<EntityCache> {
  const cache: EntityCache = new Map();

  const ensureEntity = async (
    name: string,
    type: string,
  ): Promise<string> => {
    const key = `${name}::${type}`;
    if (cache.has(key)) return cache.get(key)!;

    const entity = await createTestEntity({
      canonicalName: name,
      entityType: type,
    });
    cache.set(key, entity.id);
    // Also cache by name alone for lookup convenience
    cache.set(name, entity.id);
    return entity.id;
  };

  for (const f of facts) {
    const subjectId = await ensureEntity(f.subjectName, f.subjectType);

    let objectEntityId: string | undefined;
    if (f.objectName && f.objectType) {
      objectEntityId = await ensureEntity(f.objectName, f.objectType);
    }

    await createTestFact({
      subjectEntityId: subjectId,
      predicate: f.predicate,
      objectEntityId,
      objectValue: f.objectValue,
      validAt: f.validAt,
      invalidAt: f.invalidAt,
    });
  }

  return cache;
}

/**
 * Seed a career timeline: sequence of employers with date ranges.
 * Useful for temporal pipeline tests.
 */
export async function seedTimeline(
  personName: string,
  employers: Array<{
    name: string;
    validAt: Date;
    invalidAt?: Date;
    createdAt?: Date;
  }>,
): Promise<{ personId: string; entityIds: Map<string, string> }> {
  const person = await createTestEntity({
    canonicalName: personName,
    entityType: 'person',
  });

  const entityIds = new Map<string, string>();
  entityIds.set(personName, person.id);

  for (const emp of employers) {
    const company = await createTestEntity({
      canonicalName: emp.name,
      entityType: 'company',
    });
    entityIds.set(emp.name, company.id);

    await createTestFact({
      subjectEntityId: person.id,
      predicate: 'works_at',
      objectEntityId: company.id,
      validAt: emp.validAt,
      invalidAt: emp.invalidAt,
      createdAt: emp.createdAt,
    });
  }

  return { personId: person.id, entityIds };
}

/**
 * Seed a memory into Qdrant with associated entity links in PostgreSQL.
 */
export async function seedQdrantMemory(
  content: string,
  entityIds: string[],
): Promise<string> {
  const memoryId = randomUUID();
  const vector = randomEmbedding();

  // Embed with real ML if available, otherwise use random vector
  let mlAvailable = false;
  try {
    mlAvailable = await isMLServiceAvailable();
  } catch { /* ignore */ }

  let embeddingVector = vector;
  if (mlAvailable) {
    try {
      const response = await fetch(`${ML_SERVICES_URL}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const data = await response.json() as { vector?: number[] };
        if (data.vector && data.vector.length > 0) {
          embeddingVector = data.vector;
        }
      }
    } catch { /* fall back to random */ }
  }

  // Store in Qdrant
  const qdrantUrl = QDRANT_URL;
  await fetch(`${qdrantUrl}/collections/memories/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [{
        id: memoryId,
        vector: embeddingVector,
        payload: {
          content,
          type: 'thought',
          created_at: new Date().toISOString(),
        },
      }],
    }),
    signal: AbortSignal.timeout(5000),
  });

  // Link entities to this memory in PostgreSQL
  for (const entityId of entityIds) {
    try {
      await testDb`
        INSERT INTO memory_entities (memory_id, entity_id, mention_text, relationship, confidence)
        VALUES (${memoryId}::uuid, ${entityId}::uuid, '', 'mentions', 1.0)
      `;
    } catch { /* entity might not exist in this test context */ }
  }

  return memoryId;
}

// --- ML-as-Judge ---

const JUDGE_SYSTEM_PROMPT = `You are a strict fact-checking judge. Your job is to determine if an ANSWER is factually consistent with a set of KNOWN FACTS.

RESPONSE FORMAT (you MUST follow this exactly):
Line 1: One of these three words ONLY — CONSISTENT or INCONSISTENT or UNCERTAIN
Line 2: A one-sentence explanation.

RULES:
- CONSISTENT means the answer correctly states information that matches the known facts.
- INCONSISTENT means the answer contradicts or misrepresents the known facts.
- UNCERTAIN means the known facts do not contain enough information to verify the answer.
- If the answer correctly says "I don't know" or "not enough information" about something not in the facts, that is CONSISTENT (it is correct to admit ignorance).

CRITICAL: Your first line must be EXACTLY one word: CONSISTENT, INCONSISTENT, or UNCERTAIN. No other text on that line.`;

/**
 * Use the LLM as a judge to verify answer factual consistency.
 * Returns the judgement and explanation.
 */
export async function mlJudge(
  knownFacts: string[],
  question: string,
  answer: string,
): Promise<{ judgement: 'CONSISTENT' | 'INCONSISTENT' | 'UNCERTAIN'; explanation: string }> {
  const factsStr = knownFacts.map((f, i) => `${i + 1}. ${f}`).join('\n');

  const userMessage = `KNOWN FACTS:\n${factsStr}\n\nQUESTION: ${question}\n\nANSWER: ${answer}\n\nJudge the answer. Remember: first line must be exactly CONSISTENT, INCONSISTENT, or UNCERTAIN.`;

  const response = await fetch(`${ML_SERVICES_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: userMessage,
      system_prompt: JUDGE_SYSTEM_PROMPT,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`ML judge call failed: ${response.status}`);
  }

  const data = await response.json() as { response: string };
  const text = data.response.trim();

  // Parse judgement from first line. The prompt instructs the model to put
  // exactly one word on the first line. We check the first line for the keyword,
  // prioritizing INCONSISTENT > CONSISTENT > UNCERTAIN to avoid false matches.
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const firstLine = (lines[0] || '').toUpperCase();
  let judgement: 'CONSISTENT' | 'INCONSISTENT' | 'UNCERTAIN';
  if (firstLine.includes('INCONSISTENT')) {
    judgement = 'INCONSISTENT';
  } else if (firstLine.includes('CONSISTENT')) {
    judgement = 'CONSISTENT';
  } else if (firstLine.includes('UNCERTAIN')) {
    judgement = 'UNCERTAIN';
  } else {
    // Fallback: scan entire response for keywords
    const upper = text.toUpperCase();
    if (upper.includes('INCONSISTENT')) judgement = 'INCONSISTENT';
    else if (upper.includes('CONSISTENT')) judgement = 'CONSISTENT';
    else judgement = 'UNCERTAIN';
  }

  const explanation = lines.slice(1).join(' ').trim() || lines[0] || '';

  return { judgement, explanation };
}

// --- Service availability ---

export { isMLServiceAvailable, isQdrantAvailable };

// --- Entity matching helpers ---

/**
 * Fuzzy match extracted entity mentions against expected entity names.
 * Returns the set of expected entities that were found.
 */
export function matchEntities(
  expected: GoldenEntity[],
  extracted: Array<{ mention: string; type?: string }>,
): { found: GoldenEntity[]; missed: GoldenEntity[]; typeMatches: number } {
  const found: GoldenEntity[] = [];
  const missed: GoldenEntity[] = [];
  let typeMatches = 0;

  for (const exp of expected) {
    const expLower = exp.name.toLowerCase();
    const match = extracted.find(ext => {
      const extLower = ext.mention.toLowerCase();
      return extLower.includes(expLower) || expLower.includes(extLower);
    });

    if (match) {
      found.push(exp);
      // Check type match (normalize common variants)
      if (match.type) {
        const normalizedExtracted = normalizeEntityType(match.type);
        const normalizedExpected = normalizeEntityType(exp.type);
        if (normalizedExtracted === normalizedExpected) {
          typeMatches++;
        }
      }
    } else {
      missed.push(exp);
    }
  }

  return { found, missed, typeMatches };
}

function normalizeEntityType(type: string): string {
  const t = type.toLowerCase();
  if (['person', 'people', 'individual'].includes(t)) return 'person';
  if (['company', 'organization', 'organisation', 'org', 'business'].includes(t)) return 'company';
  if (['place', 'location', 'city', 'country', 'region', 'geo'].includes(t)) return 'place';
  if (['project', 'initiative'].includes(t)) return 'project';
  if (['concept', 'technology', 'tool', 'framework', 'skill', 'tech'].includes(t)) return 'concept';
  if (['product', 'service'].includes(t)) return 'product';
  if (['team', 'group', 'department'].includes(t)) return 'team';
  return t;
}
