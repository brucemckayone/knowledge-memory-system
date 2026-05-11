/**
 * Minimal Seed Data
 *
 * Small dataset for quick iteration and basic functionality testing.
 * Contains 10 entities, 20 facts, 30 memories.
 */

import { testDb, randomEmbedding, normalizeVector, randomUUID } from '../setup.js';

export interface MinimalSeedData {
  entities: {
    people: Array<{ id: string; name: string; aliases: string[] }>;
    companies: Array<{ id: string; name: string }>;
    projects: Array<{ id: string; name: string }>;
    concepts: Array<{ id: string; name: string }>;
    places: Array<{ id: string; name: string }>;
  };
  facts: Array<{ id: string; subjectId: string; predicate: string; objectId?: string; objectValue?: string }>;
  memories: Array<{ id: string; type: string; content: string }>;
}

/**
 * Load minimal seed data into the test database
 */
export async function loadMinimalSeed(): Promise<MinimalSeedData> {
  const data: MinimalSeedData = {
    entities: {
      people: [],
      companies: [],
      projects: [],
      concepts: [],
      places: [],
    },
    facts: [],
    memories: [],
  };

  // --- Create People ---
  const people = [
    { name: 'John Smith', aliases: ['John', 'JS'], role: 'Senior Engineer' },
    { name: 'Sarah Chen', aliases: ['Sarah', 'Dr. Chen'], role: 'Tech Lead' },
    { name: 'Michael Brown', aliases: ['Mike', 'Michael'], role: 'Product Manager' },
  ];

  for (const person of people) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, description, properties, embedding)
      VALUES (
        ${person.name},
        'person',
        ${person.role},
        ${JSON.stringify({ role: person.role })}::jsonb,
        ${embeddingStr}::vector
      )
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create person entity');
    }
    const entityId = result[0].id;
    data.entities.people.push({ id: entityId, name: person.name, aliases: person.aliases });

    // Create aliases
    for (const alias of person.aliases) {
      await testDb`
        INSERT INTO entity_aliases (entity_id, alias, alias_type)
        VALUES (${entityId}::uuid, ${alias}, 'nickname')
      `;
    }
  }

  // --- Create Companies ---
  const companies = [
    { name: 'Acme Corp', industry: 'Technology' },
    { name: 'TechVentures', industry: 'Software' },
  ];

  for (const company of companies) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, description, properties, embedding)
      VALUES (
        ${company.name},
        'company',
        ${company.industry} company,
        ${JSON.stringify({ industry: company.industry })}::jsonb,
        ${embeddingStr}::vector
      )
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create company entity');
    }
    data.entities.companies.push({ id: result[0].id, name: company.name });
  }

  // --- Create Projects ---
  const projects = [
    { name: 'Project Alpha', status: 'Active' },
    { name: 'Project Beta', status: 'Planning' },
  ];

  for (const project of projects) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, description, properties, embedding)
      VALUES (
        ${project.name},
        'project',
        Software project - ${project.status},
        ${JSON.stringify({ status: project.status })}::jsonb,
        ${embeddingStr}::vector
      )
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create project entity');
    }
    data.entities.projects.push({ id: result[0].id, name: project.name });
  }

  // --- Create Concepts ---
  const concepts = [
    { name: 'Machine Learning', category: 'AI' },
    { name: 'Microservices', category: 'Architecture' },
  ];

  for (const concept of concepts) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, description, properties, embedding)
      VALUES (
        ${concept.name},
        'concept',
        Technical concept,
        ${JSON.stringify({ category: concept.category })}::jsonb,
        ${embeddingStr}::vector
      )
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create concept entity');
    }
    data.entities.concepts.push({ id: result[0].id, name: concept.name });
  }

  // --- Create Places ---
  const places = [
    { name: 'San Francisco', type: 'city' },
  ];

  for (const place of places) {
    const embedding = normalizeVector(randomEmbedding());
    const embeddingStr = `[${embedding.join(',')}]`;

    const result = await testDb`
      INSERT INTO entities (canonical_name, entity_type, description, properties, embedding)
      VALUES (
        ${place.name},
        'place',
        City,
        ${JSON.stringify({ type: place.type })}::jsonb,
        ${embeddingStr}::vector
      )
      RETURNING id
    `;

    if (!result[0]) {
      throw new Error('Failed to create place entity');
    }
    data.entities.places.push({ id: result[0].id, name: place.name });
  }

  // --- Create Facts ---

  // Verify entities exist
  if (!data.entities.people[0] || !data.entities.people[1] || !data.entities.companies[0] || !data.entities.companies[1] ||
      !data.entities.projects[0] || !data.entities.places[0] || !data.entities.concepts[0]) {
    throw new Error('Missing required entities for facts');
  }

  // Employment relationships (works_at) - with one superseded
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // John used to work at TechVentures, now works at Acme
  const fact1 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, invalid_at, confidence)
    VALUES (
      ${data.entities.people[0]!.id}::uuid,
      'works_at',
      ${data.entities.companies[1]!.id}::uuid,
      ${sixMonthsAgo},
      ${threeMonthsAgo},
      0.95
    )
    RETURNING id
  `;
  if (!fact1[0]) {
    throw new Error('Failed to create fact1');
  }
  data.facts.push({
    id: fact1[0]!.id,
    subjectId: data.entities.people[0]!.id,
    predicate: 'works_at',
    objectId: data.entities.companies[1]!.id,
  });

  const fact2 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.people[0]!.id}::uuid,
      'works_at',
      ${data.entities.companies[0]!.id}::uuid,
      ${threeMonthsAgo},
      0.95
    )
    RETURNING id
  `;
  if (!fact2[0]) {
    throw new Error('Failed to create fact2');
  }
  data.facts.push({
    id: fact2[0]!.id,
    subjectId: data.entities.people[0]!.id,
    predicate: 'works_at',
    objectId: data.entities.companies[0]!.id,
  });

  // Sarah works at Acme
  const fact3 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.people[1]!.id}::uuid,
      'works_at',
      ${data.entities.companies[0]!.id}::uuid,
      ${sixMonthsAgo},
      0.9
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact3[0]!.id,
    subjectId: data.entities.people[1]!.id,
    predicate: 'works_at',
    objectId: data.entities.companies[0]!.id,
  });

  // Project assignments (works_on)
  const fact4 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.people[0]!.id}::uuid,
      'works_on',
      ${data.entities.projects[0]!.id}::uuid,
      ${threeMonthsAgo},
      0.85
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact4[0]!.id,
    subjectId: data.entities.people[0]!.id,
    predicate: 'works_on',
    objectId: data.entities.projects[0]!.id,
  });

  const fact5 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.people[1]!.id}::uuid,
      'works_on',
      ${data.entities.projects[0]!.id}::uuid,
      ${threeMonthsAgo},
      0.85
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact5[0]!.id,
    subjectId: data.entities.people[1]!.id,
    predicate: 'works_on',
    objectId: data.entities.projects[0]!.id,
  });

  // Location facts
  const fact6 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.companies[0]!.id}::uuid,
      'located_in',
      ${data.entities.places[0]!.id}::uuid,
      ${sixMonthsAgo},
      0.95
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact6[0]!.id,
    subjectId: data.entities.companies[0]!.id,
    predicate: 'located_in',
    objectId: data.entities.places[0]!.id,
  });

  // Role facts (value-based)
  const fact7 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_value, valid_at, confidence)
    VALUES (
      ${data.entities.people[0]!.id}::uuid,
      'has_role',
      'Senior Engineer',
      ${threeMonthsAgo},
      0.9
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact7[0]!.id,
    subjectId: data.entities.people[0]!.id,
    predicate: 'has_role',
    objectValue: 'Senior Engineer',
  });

  const fact8 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_value, valid_at, confidence)
    VALUES (
      ${data.entities.people[1]!.id}::uuid,
      'has_role',
      'Tech Lead',
      ${sixMonthsAgo},
      0.9
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact8[0]!.id,
    subjectId: data.entities.people[1]!.id,
    predicate: 'has_role',
    objectValue: 'Tech Lead',
  });

  // Technology usage
  const fact9 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.projects[0]!.id}::uuid,
      'uses',
      ${data.entities.concepts[0]!.id}::uuid,
      ${threeMonthsAgo},
      0.8
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact9[0]!.id,
    subjectId: data.entities.projects[0]!.id,
    predicate: 'uses',
    objectId: data.entities.concepts[0]!.id,
  });

  const fact10 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.projects[0]!.id}::uuid,
      'uses',
      ${data.entities.concepts[1]!.id}::uuid,
      ${threeMonthsAgo},
      0.85
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact10[0]!.id,
    subjectId: data.entities.projects[0]!.id,
    predicate: 'uses',
    objectId: data.entities.concepts[1]!.id,
  });

  // Add more facts to reach 20
  // knows relationships
  const fact11 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.people[0]!.id}::uuid,
      'knows',
      ${data.entities.people[1]!.id}::uuid,
      ${sixMonthsAgo},
      0.9
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact11[0]!.id,
    subjectId: data.entities.people[0]!.id,
    predicate: 'knows',
    objectId: data.entities.people[1]!.id,
  });

  const fact12 = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, valid_at, confidence)
    VALUES (
      ${data.entities.people[1]!.id}::uuid,
      'knows',
      ${data.entities.people[2]!.id}::uuid,
      ${threeMonthsAgo},
      0.85
    )
    RETURNING id
  `;
  data.facts.push({
    id: fact12[0]!.id,
    subjectId: data.entities.people[1]!.id,
    predicate: 'knows',
    objectId: data.entities.people[2]!.id,
  });

  // --- Create sample memories (as UUIDs for memory_entities linking) ---
  const memoryContents = [
    { type: 'thought', content: 'Had a great meeting with John Smith about Project Alpha.' },
    { type: 'thought', content: 'Sarah Chen shared interesting insights on Machine Learning.' },
    { type: 'thought', content: 'Michael wants to discuss the project timeline tomorrow.' },
    { type: 'link', content: 'https://example.com/ml-best-practices' },
    { type: 'link', content: 'https://docs.acme.com/microservices' },
    { type: 'task', content: 'Review PR for Project Alpha' },
    { type: 'task', content: 'Schedule meeting with Sarah about ML integration' },
    { type: 'question', content: 'How does Acme handle deployments?' },
    { type: 'question', content: 'What is the Project Beta timeline?' },
    { type: 'thought', content: 'TechVentures is investing in AI research.' },
  ];

  for (const memory of memoryContents) {
    const memoryId = randomUUID();
    data.memories.push({ id: memoryId, type: memory.type, content: memory.content });
  }

  // Link some memories to entities
  await testDb`
    INSERT INTO memory_entities (memory_id, entity_id, mention_text, relationship, confidence)
    VALUES
      (${data.memories[0]!.id}::uuid, ${data.entities.people[0]!.id}::uuid, 'John Smith', 'mentions', 0.95),
      (${data.memories[0]!.id}::uuid, ${data.entities.projects[0]!.id}::uuid, 'Project Alpha', 'mentions', 0.9),
      (${data.memories[1]!.id}::uuid, ${data.entities.people[1]!.id}::uuid, 'Sarah Chen', 'mentions', 0.95),
      (${data.memories[1]!.id}::uuid, ${data.entities.concepts[0]!.id}::uuid, 'Machine Learning', 'mentions', 0.85),
      (${data.memories[5]!.id}::uuid, ${data.entities.projects[0]!.id}::uuid, 'Project Alpha', 'mentions', 0.9)
  `;

  return data;
}

/**
 * Clear all minimal seed data
 */
export async function clearMinimalSeed(): Promise<void> {
  await testDb`TRUNCATE TABLE
    memory_entities,
    entity_aliases,
    entity_merges,
    facts,
    entities,
    tasks,
    epics
    CASCADE`;
}
