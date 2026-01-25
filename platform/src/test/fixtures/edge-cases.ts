/**
 * Edge Case Test Data
 *
 * Test boundary conditions and unusual scenarios.
 */

import { testDb, randomEmbedding, normalizeVector } from '../setup.js';

/**
 * Create an entity with many aliases (100+)
 */
export async function createEntityWithManyAliases(aliasCount: number = 100): Promise<{
  entityId: string;
  aliases: string[];
}> {
  const embedding = normalizeVector(randomEmbedding());
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await testDb`
    INSERT INTO entities (canonical_name, entity_type, description, embedding)
    VALUES ('High Alias Entity', 'person', 'Entity with many aliases', ${embeddingStr}::vector)
    RETURNING id
  `;

  if (!result[0]) {
    throw new Error('Failed to create entity');
  }
  const entityId = result[0].id;
  const aliases: string[] = [];

  for (let i = 0; i < aliasCount; i++) {
    const alias = `Alias_${i.toString().padStart(3, '0')}`;
    aliases.push(alias);
    await testDb`
      INSERT INTO entity_aliases (entity_id, alias, alias_type)
      VALUES (${entityId}::uuid, ${alias}, 'generated')
    `;
  }

  return { entityId, aliases };
}

/**
 * Create a fact with many temporal versions
 */
export async function createFactWithTemporalHistory(
  subjectEntityId: string,
  objectEntityIds: string[],
  versionCount: number = 10
): Promise<{ factIds: string[] }> {
  const factIds: string[] = [];
  const now = Date.now();
  const intervalMs = 30 * 24 * 60 * 60 * 1000; // 30 days

  for (let i = 0; i < versionCount; i++) {
    const validAt = new Date(now - (versionCount - i) * intervalMs);
    const invalidAt = i < versionCount - 1
      ? new Date(now - (versionCount - i - 1) * intervalMs)
      : null;

    const objectId = objectEntityIds[i % objectEntityIds.length];
    if (!objectId) {
      throw new Error('No object entity ID available');
    }

    const result = await testDb`
      INSERT INTO facts (
        subject_entity_id, predicate, object_entity_id,
        valid_at, invalid_at, confidence
      )
      VALUES (
        ${subjectEntityId}::uuid, 'works_at', ${objectId}::uuid,
        ${validAt}, ${invalidAt}, 0.9
      )
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create fact');
    }
    factIds.push(result[0].id);
  }

  return { factIds };
}

/**
 * Create circular relationships (A knows B knows C knows A)
 */
export async function createCircularRelationships(nodeCount: number = 5): Promise<{
  entityIds: string[];
  factIds: string[];
}> {
  const entityIds: string[] = [];
  const factIds: string[] = [];

  // Create entities
  for (let i = 0; i < nodeCount; i++) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, embedding)
      VALUES (${'CircularNode_' + i}, 'person', ${embeddingStr}::vector)
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create circular entity');
    }
    entityIds.push(result[0].id);
  }

  // Create circular "knows" relationships
  for (let i = 0; i < nodeCount; i++) {
    const nextIdx = (i + 1) % nodeCount;
    const fromId = entityIds[i];
    const toId = entityIds[nextIdx];
    if (!fromId || !toId) {
      throw new Error('Missing entity IDs for circular relationships');
    }

    const result = await testDb`
      INSERT INTO facts (subject_entity_id, predicate, object_entity_id, confidence)
      VALUES (${fromId}::uuid, 'knows', ${toId}::uuid, 0.9)
      RETURNING id
    `;

    factIds.push(result[0]?.id || '');
  }

  return { entityIds, factIds };
}

/**
 * Create multiple entities with the same name (different types)
 */
export async function createHomonymEntities(
  name: string,
  types: string[]
): Promise<{ entityIds: string[] }> {
  const entityIds: string[] = [];

  for (const type of types) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (
        canonical_name, entity_type, description, embedding,
        properties
      )
      VALUES (
        ${name}, ${type}, ${name + ' as ' + type}, ${embeddingStr}::vector,
        ${JSON.stringify({ disambiguator: type })}::jsonb
      )
      RETURNING id
    `;

    entityIds.push(result[0]?.id || '');
  }

  return { entityIds };
}

/**
 * Create multiple John Smiths (same name, same type)
 */
export async function createDuplicateNameEntities(
  name: string,
  count: number = 5
): Promise<{ entityIds: string[]; distinguishingInfo: string[] }> {
  const entityIds: string[] = [];
  const distinguishingInfo: string[] = [];

  const companies = ['Acme Corp', 'TechVentures', 'Innovate Labs', 'DataSphere', 'CloudNine'];

  for (let i = 0; i < count; i++) {
    const company = companies[i % companies.length];
    const info = `${name} at ${company}`;
    distinguishingInfo.push(info);

    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (
        canonical_name, entity_type, description, embedding,
        properties
      )
      VALUES (
        ${name}, 'person', ${info}, ${embeddingStr}::vector,
        ${JSON.stringify({ company, instance: i })}::jsonb
      )
      RETURNING id
    `;

    entityIds.push(result[0]?.id || '');
  }

  return { entityIds, distinguishingInfo };
}

/**
 * Unicode names for internationalization testing
 */
export const UNICODE_NAMES = {
  chinese: '王小明',
  japanese: '田中太郎',
  korean: '김철수',
  arabic: 'محمد أحمد',
  hebrew: 'יוסי לוי',
  russian: 'Иван Петров',
  german: 'Müller Schmidt',
  spanish: 'José García Ñoño',
  french: 'François Müller',
  thai: 'สมชาย ใจดี',
  vietnamese: 'Nguyễn Văn A',
  emoji: '😀 Test User',
};

/**
 * Create entities with unicode names
 */
export async function createUnicodeEntities(): Promise<{
  entityIds: Map<string, string>;
}> {
  const entityIds = new Map<string, string>();

  for (const [language, name] of Object.entries(UNICODE_NAMES)) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (
        canonical_name, entity_type, description, embedding,
        properties
      )
      VALUES (
        ${name}, 'person', ${'Test person with ' + language + ' name'},
        ${embeddingStr}::vector,
        ${JSON.stringify({ language })}::jsonb
      )
      RETURNING id
    `;

    entityIds.set(language, result[0]?.id || '');
  }

  return { entityIds };
}

/**
 * Create very long content for memory testing
 */
export function generateLongContent(wordCount: number = 10000): string {
  const words = [
    'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog',
    'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing',
    'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore',
    'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam',
    'project', 'meeting', 'deadline', 'development', 'engineering', 'software',
    'architecture', 'microservices', 'deployment', 'infrastructure',
  ];

  const result: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const word = words[Math.floor(Math.random() * words.length)];
    if (word) {
      result.push(word);
    }
  }

  return result.join(' ');
}

/**
 * Create empty content edge case
 */
export const EMPTY_CONTENT_CASES = {
  emptyString: '',
  whitespace: '   ',
  newlines: '\n\n\n',
  tabs: '\t\t\t',
  mixedWhitespace: '  \n\t  \n  ',
};

/**
 * Malformed date strings for parsing testing
 */
export const MALFORMED_DATES = [
  '2024-13-45',           // Invalid month/day
  '2024/02/30',           // Invalid day for February
  'not-a-date',           // Plain text
  '1234567890',           // Unix timestamp as string
  '2024-02-30T25:61:61Z', // Invalid time
  '',                     // Empty
  'null',                 // String null
  'undefined',            // String undefined
  'tomorrow',             // Relative date
  '2024-W53',             // Invalid week
];

/**
 * Special characters that might cause issues
 */
export const SPECIAL_CHARACTERS = {
  sqlInjection: "'; DROP TABLE entities; --",
  htmlTags: '<script>alert("xss")</script>',
  jsonBreaking: '{"broken": "json',
  nullByte: 'test\x00string',
  backslashes: 'path\\to\\file',
  quotes: 'He said "hello" and \'goodbye\'',
  newlineInString: 'line1\nline2\nline3',
  tabsInString: 'col1\tcol2\tcol3',
  unicodeControl: 'test\u0000\u0001\u0002string',
  rtlOverride: '\u202Etest',
  zeroWidth: 'test\u200Bstring',
};

/**
 * Test creating entity with special characters (should be escaped properly)
 */
export async function createEntityWithSpecialCharacters(
  name: string
): Promise<{ entityId: string }> {
  const embedding = normalizeVector(randomEmbedding());
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await testDb`
    INSERT INTO entities (canonical_name, entity_type, embedding)
    VALUES (${name}, 'other', ${embeddingStr}::vector)
    RETURNING id
  `;

  return { entityId: result[0]?.id || '' };
}

/**
 * Create maximum depth nesting scenario (for graph traversal)
 */
export async function createDeepNestingChain(depth: number = 20): Promise<{
  entityIds: string[];
  factIds: string[];
}> {
  const entityIds: string[] = [];
  const factIds: string[] = [];

  // Create entities in a chain
  for (let i = 0; i < depth; i++) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, embedding)
      VALUES (${'Level_' + i}, 'concept', ${embeddingStr}::vector)
      RETURNING id
    `;

    entityIds.push(result[0]?.id || '');
  }

  // Create "part_of" chain: 0 -> 1 -> 2 -> ... -> n-1
  for (let i = 0; i < depth - 1; i++) {
    const fromId = entityIds[i];
    const toId = entityIds[i + 1];
    if (!fromId || !toId) {
      throw new Error('Missing entity IDs for hierarchy');
    }

    const result = await testDb`
      INSERT INTO facts (subject_entity_id, predicate, object_entity_id, confidence)
      VALUES (${fromId}::uuid, 'part_of', ${toId}::uuid, 0.95)
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create hierarchy fact');
    }
    factIds.push(result[0].id);
  }

  return { entityIds, factIds };
}

/**
 * Clear edge case data
 */
export async function clearEdgeCaseData(): Promise<void> {
  await testDb`
    DELETE FROM entities
    WHERE canonical_name LIKE 'High Alias%'
       OR canonical_name LIKE 'CircularNode%'
       OR canonical_name LIKE 'Level_%'
       OR properties->>'instance' IS NOT NULL
       OR properties->>'language' IS NOT NULL
       OR entity_type = 'other'
  `;
}
