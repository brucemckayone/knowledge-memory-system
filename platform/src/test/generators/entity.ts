/**
 * Entity Generator
 *
 * Generates realistic entity test data with proper types,
 * properties, and optional aliases.
 */

import { randomEmbedding, normalizeVector } from '../setup.js';

// Name pools by entity type
const PERSON_FIRST_NAMES = [
  'John', 'Sarah', 'Michael', 'Emily', 'David', 'Emma', 'James', 'Olivia',
  'Robert', 'Sophia', 'William', 'Isabella', 'Richard', 'Mia', 'Joseph',
  'Charlotte', 'Thomas', 'Amelia', 'Charles', 'Harper', 'Christopher',
  'Evelyn', 'Daniel', 'Abigail', 'Matthew', 'Elizabeth', 'Anthony', 'Sofia',
];

const PERSON_LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
  'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Chen',
];

const COMPANY_NAMES = [
  'Acme Corp', 'TechVentures', 'Innovate Labs', 'DataSphere', 'CloudNine',
  'Quantum Solutions', 'Pioneer Systems', 'Apex Industries', 'Nexus Tech',
  'Horizon Digital', 'Velocity Software', 'Atlas Computing', 'Stellar AI',
  'Fusion Dynamics', 'Catalyst Group', 'Momentum Partners', 'Synergy Inc',
  'Elevate Digital', 'Prism Analytics', 'Vector Innovations', 'Pulse Labs',
];

const PROJECT_NAMES = [
  'Project Alpha', 'Operation Phoenix', 'Initiative Blue', 'Moonshot',
  'Titan', 'Aurora', 'Genesis', 'Catalyst', 'Horizon', 'Quantum Leap',
  'Odyssey', 'Venture X', 'Blueprint', 'Pathfinder', 'Pioneer',
  'Lighthouse', 'Compass', 'Milestone', 'Keystone', 'Flagship',
];

const CONCEPT_NAMES = [
  'Machine Learning', 'Distributed Systems', 'Cloud Architecture',
  'Data Pipeline', 'Microservices', 'DevOps', 'Agile Methodology',
  'Test-Driven Development', 'Continuous Integration', 'API Design',
  'Security Best Practices', 'Performance Optimization', 'Scalability',
  'User Experience', 'Technical Debt', 'Code Review', 'Documentation',
];

const PLACE_NAMES = [
  'San Francisco', 'New York', 'London', 'Tokyo', 'Berlin', 'Paris',
  'Singapore', 'Sydney', 'Toronto', 'Seattle', 'Boston', 'Austin',
  'Denver', 'Chicago', 'Los Angeles', 'Amsterdam', 'Dublin', 'Zurich',
];

const ROLES = [
  'CEO', 'CTO', 'VP Engineering', 'Senior Engineer', 'Staff Engineer',
  'Product Manager', 'Designer', 'Data Scientist', 'DevOps Engineer',
  'QA Lead', 'Tech Lead', 'Architect', 'Director', 'Manager',
];

export type EntityType = 'person' | 'company' | 'project' | 'concept' | 'place' | 'event' | 'other';

export interface GeneratedEntity {
  canonicalName: string;
  entityType: EntityType;
  description: string;
  properties: Record<string, unknown>;
  aliases: string[];
  embedding: number[];
}

export interface EntityGeneratorOptions {
  type?: EntityType;
  withAliases?: boolean;
  aliasCount?: number;
  withEmbedding?: boolean;
  properties?: Record<string, unknown>;
}

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a person entity
 */
function generatePerson(options: EntityGeneratorOptions): GeneratedEntity {
  const firstName = randomElement(PERSON_FIRST_NAMES);
  const lastName = randomElement(PERSON_LAST_NAMES);
  const fullName = `${firstName} ${lastName}`;
  const role = randomElement(ROLES);

  const aliases: string[] = [];
  if (options.withAliases) {
    const count = options.aliasCount ?? randomInt(1, 3);
    aliases.push(firstName); // First name only
    if (count > 1) aliases.push(`${firstName[0]}. ${lastName}`); // Initial
    if (count > 2) aliases.push(lastName); // Last name only
  }

  return {
    canonicalName: fullName,
    entityType: 'person',
    description: `${role} at a technology company`,
    properties: {
      firstName,
      lastName,
      role,
      ...options.properties,
    },
    aliases,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
  };
}

/**
 * Generate a company entity
 */
function generateCompany(options: EntityGeneratorOptions): GeneratedEntity {
  const name = randomElement(COMPANY_NAMES);
  const industry = randomElement(['Technology', 'Finance', 'Healthcare', 'Retail', 'Manufacturing']);
  const size = randomElement(['Startup', 'SMB', 'Enterprise']);

  const aliases: string[] = [];
  if (options.withAliases) {
    const count = options.aliasCount ?? randomInt(1, 2);
    // Remove common suffixes for alias
    const shortName = name.replace(/ (Corp|Inc|Labs|Tech|Solutions|Systems|Industries|Group|Partners|Digital|Analytics|Innovations)$/, '');
    if (shortName !== name) aliases.push(shortName);
    if (count > 1) {
      // Create acronym
      const words = name.split(' ');
      if (words.length > 1) {
        aliases.push(words.map(w => w[0]).join(''));
      }
    }
  }

  return {
    canonicalName: name,
    entityType: 'company',
    description: `${size} company in the ${industry} industry`,
    properties: {
      industry,
      size,
      ...options.properties,
    },
    aliases,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
  };
}

/**
 * Generate a project entity
 */
function generateProject(options: EntityGeneratorOptions): GeneratedEntity {
  const name = randomElement(PROJECT_NAMES);
  const status = randomElement(['Active', 'Completed', 'On Hold', 'Planning']);

  const aliases: string[] = [];
  if (options.withAliases) {
    // Projects often have short codes
    const words = name.split(' ');
    if (words.length > 1) {
      aliases.push(words.map(w => w[0]).join(''));
    }
  }

  return {
    canonicalName: name,
    entityType: 'project',
    description: `Software development project - ${status}`,
    properties: {
      status,
      startDate: new Date(Date.now() - randomInt(30, 365) * 24 * 60 * 60 * 1000).toISOString(),
      ...options.properties,
    },
    aliases,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
  };
}

/**
 * Generate a concept entity
 */
function generateConcept(options: EntityGeneratorOptions): GeneratedEntity {
  const name = randomElement(CONCEPT_NAMES);

  const aliases: string[] = [];
  if (options.withAliases) {
    // Concepts might have abbreviations
    const words = name.split(' ');
    if (words.length > 1) {
      aliases.push(words.map(w => w[0]).join(''));
    }
  }

  return {
    canonicalName: name,
    entityType: 'concept',
    description: `Technical concept or methodology`,
    properties: {
      category: 'Technology',
      ...options.properties,
    },
    aliases,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
  };
}

/**
 * Generate a place entity
 */
function generatePlace(options: EntityGeneratorOptions): GeneratedEntity {
  const name = randomElement(PLACE_NAMES);

  return {
    canonicalName: name,
    entityType: 'place',
    description: `City location`,
    properties: {
      type: 'city',
      ...options.properties,
    },
    aliases: [],
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
  };
}

/**
 * Generate a random entity of any type
 */
export function generateEntity(options: EntityGeneratorOptions = {}): GeneratedEntity {
  const type = options.type ?? randomElement<EntityType>(['person', 'company', 'project', 'concept', 'place']);

  switch (type) {
    case 'person':
      return generatePerson(options);
    case 'company':
      return generateCompany(options);
    case 'project':
      return generateProject(options);
    case 'concept':
      return generateConcept(options);
    case 'place':
      return generatePlace(options);
    default:
      return generatePerson(options);
  }
}

/**
 * Generate multiple entities
 */
export function generateEntities(
  count: number,
  options: EntityGeneratorOptions = {}
): GeneratedEntity[] {
  return Array.from({ length: count }, () => generateEntity(options));
}

/**
 * Generate a batch of entities with specific type distribution
 */
export function generateEntityBatch(distribution: {
  people?: number;
  companies?: number;
  projects?: number;
  concepts?: number;
  places?: number;
}): GeneratedEntity[] {
  const entities: GeneratedEntity[] = [];

  if (distribution.people) {
    entities.push(...generateEntities(distribution.people, { type: 'person', withAliases: true }));
  }
  if (distribution.companies) {
    entities.push(...generateEntities(distribution.companies, { type: 'company', withAliases: true }));
  }
  if (distribution.projects) {
    entities.push(...generateEntities(distribution.projects, { type: 'project', withAliases: true }));
  }
  if (distribution.concepts) {
    entities.push(...generateEntities(distribution.concepts, { type: 'concept' }));
  }
  if (distribution.places) {
    entities.push(...generateEntities(distribution.places, { type: 'place' }));
  }

  return entities;
}

/**
 * Generate two similar entities for deduplication testing
 */
export function generateSimilarEntities(type: EntityType = 'person'): [GeneratedEntity, GeneratedEntity] {
  const base = generateEntity({ type, withAliases: false });

  // Create a variant with slight differences
  const variant: GeneratedEntity = {
    ...base,
    canonicalName: type === 'person'
      ? base.canonicalName.replace(/(\w+) (\w+)/, '$1 J. $2') // Add middle initial
      : base.canonicalName + ' Inc', // Add suffix
    properties: { ...base.properties, source: 'variant' },
    // Use very similar embedding (high cosine similarity)
    embedding: base.embedding.map((v, i) => i < 750 ? v : v + (Math.random() * 0.01 - 0.005)),
  };

  return [base, variant];
}

/**
 * Generate entities with same name but different types (edge case)
 */
export function generateHomonymEntities(name: string, types: EntityType[]): GeneratedEntity[] {
  return types.map(type => ({
    canonicalName: name,
    entityType: type,
    description: `${name} as a ${type}`,
    properties: { disambiguator: type },
    aliases: [],
    embedding: normalizeVector(randomEmbedding()),
  }));
}
