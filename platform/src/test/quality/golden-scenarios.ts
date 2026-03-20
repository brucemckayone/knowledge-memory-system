/**
 * Golden Scenarios for ML Quality Verification
 *
 * ~30 synthetic realistic scenarios across 8 categories (A-H).
 * Each scenario has typed expected outputs for deterministic verification.
 *
 * Categories:
 * A — Messy real-world messages (entity + relationship extraction)
 * B — Corrections and contradictions over time
 * C — Implicit relationships requiring inference
 * D — Ambiguous references
 * E — Conversational sequences (context window)
 * F — Temporal language patterns
 * G — Retrieval queries requiring multi-hop reasoning
 * H — Queries about temporal state
 */

// --- Types ---

/** Valid DB entity types: person, company, project, concept, place, event, other */
export type DbEntityType = 'person' | 'company' | 'place' | 'project' | 'concept' | 'event' | 'other';

export interface GoldenEntity {
  name: string;
  /** For extraction matching; may include types not in DB (team, product) */
  type: string;
}

export interface GoldenRelationship {
  subject: string;
  predicate: string;
  object: string;
  temporal?: 'past' | 'present' | 'future';
}

export interface GoldenContradictionPair {
  fact1: { subject: string; predicate: string; object: string };
  fact2: { subject: string; predicate: string; object: string };
  expectContradicts: boolean;
}

export interface TemporalExpectation {
  description: string;
  hasValidAt: boolean;
  hasInvalidAt: boolean;
}

export interface ExtractionScenario {
  id: string;
  category: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  name: string;
  messages: string[];
  expectedEntities: GoldenEntity[];
  expectedRelationships?: GoldenRelationship[];
  temporalExpectations?: TemporalExpectation[];
}

export interface SeededFact {
  subjectName: string;
  subjectType: DbEntityType;
  predicate: string;
  objectName?: string;
  objectType?: DbEntityType;
  objectValue?: string;
  validAt?: Date;
  invalidAt?: Date;
}

export interface RetrievalScenario {
  id: string;
  category: 'G' | 'H';
  name: string;
  seededFacts: SeededFact[];
  query: string;
  /** Entity names that should appear in top results */
  expectedRelevantEntities: string[];
}

export interface JudgeScenario {
  id: string;
  name: string;
  seededFacts: SeededFact[];
  question: string;
  knownFactsDescription: string[];
  expectedJudgement: 'CONSISTENT' | 'UNCERTAIN';
}

// --- Category A: Messy real-world messages ---

const A_SCENARIOS: ExtractionScenario[] = [
  {
    id: 'A1',
    category: 'A',
    name: 'Coffee with Sarah from Acme London',
    messages: [
      `Had coffee with Sarah from the Acme London office today — she's frustrated because they're shutting it down and moving everyone to Manchester next quarter. She's thinking about jumping to Contoso instead.`,
    ],
    expectedEntities: [
      { name: 'Sarah', type: 'person' },
      { name: 'Acme', type: 'company' },
      { name: 'London', type: 'place' },
      { name: 'Manchester', type: 'place' },
      { name: 'Contoso', type: 'company' },
    ],
    expectedRelationships: [
      { subject: 'Sarah', predicate: 'works_at', object: 'Acme', temporal: 'present' },
      { subject: 'Acme', predicate: 'located_in', object: 'London', temporal: 'present' },
    ],
    temporalExpectations: [
      { description: 'Manchester move is future', hasValidAt: false, hasInvalidAt: false },
    ],
  },
  {
    id: 'A2',
    category: 'A',
    name: 'Marcus left Berlin for Dublin',
    messages: [
      `Just had lunch with Marcus — turns out he left the Berlin team and is now running ops in Dublin for Nexus Solutions.`,
    ],
    expectedEntities: [
      { name: 'Marcus', type: 'person' },
      { name: 'Berlin', type: 'place' },
      { name: 'Dublin', type: 'place' },
      { name: 'Nexus Solutions', type: 'company' },
    ],
    expectedRelationships: [
      { subject: 'Marcus', predicate: 'works_at', object: 'Nexus Solutions', temporal: 'present' },
    ],
  },
  {
    id: 'A3',
    category: 'A',
    name: 'Vendor API docs delivery',
    messages: [
      `Our vendor Initech finally delivered the API docs. Jenny from their side says v3 is dropping next month with breaking changes.`,
    ],
    expectedEntities: [
      { name: 'Initech', type: 'company' },
      { name: 'Jenny', type: 'person' },
    ],
    expectedRelationships: [
      { subject: 'Jenny', predicate: 'works_at', object: 'Initech', temporal: 'present' },
    ],
  },
  {
    id: 'A4',
    category: 'A',
    name: 'Startup Series B funding',
    messages: [
      `Tom mentioned his startup Pinnacle just closed their Series B — $15M from Horizon Capital. He's expanding the engineering team.`,
    ],
    expectedEntities: [
      { name: 'Tom', type: 'person' },
      { name: 'Pinnacle', type: 'company' },
      { name: 'Horizon Capital', type: 'company' },
    ],
    expectedRelationships: [
      { subject: 'Tom', predicate: 'works_at', object: 'Pinnacle', temporal: 'present' },
    ],
  },
  {
    id: 'A5',
    category: 'A',
    name: 'New design head at Meridian',
    messages: [
      `Met the new head of design at Meridian — her name is Priya and she used to be at Figma.`,
    ],
    expectedEntities: [
      { name: 'Priya', type: 'person' },
      { name: 'Meridian', type: 'company' },
      { name: 'Figma', type: 'company' },
    ],
    expectedRelationships: [
      { subject: 'Priya', predicate: 'works_at', object: 'Meridian', temporal: 'present' },
      { subject: 'Priya', predicate: 'works_at', object: 'Figma', temporal: 'past' },
    ],
  },
  {
    id: 'A6',
    category: 'A',
    name: 'Zurich office AWS migration',
    messages: [
      `Had a call with the Zurich office today. Stefan confirmed they're migrating to AWS by Q4.`,
    ],
    expectedEntities: [
      { name: 'Zurich', type: 'place' },
      { name: 'Stefan', type: 'person' },
      { name: 'AWS', type: 'concept' },
    ],
  },
  {
    id: 'A7',
    category: 'A',
    name: 'Mobile app launch delayed',
    messages: [
      `Rachel from product says the mobile app launch is pushed to March. Something about compliance approval from the legal team.`,
    ],
    expectedEntities: [
      { name: 'Rachel', type: 'person' },
    ],
  },
  {
    id: 'A8',
    category: 'A',
    name: 'Payment gateway shipped',
    messages: [
      `Dave's team shipped the payment gateway integration with Stripe. Carlos handled the webhook part.`,
    ],
    expectedEntities: [
      { name: 'Dave', type: 'person' },
      { name: 'Carlos', type: 'person' },
      { name: 'Stripe', type: 'company' },
    ],
    expectedRelationships: [
      { subject: 'Dave', predicate: 'manages', object: 'team', temporal: 'present' },
    ],
  },
];

// --- Category B: Corrections and contradictions ---

const B_SCENARIOS: ExtractionScenario[] = [
  {
    id: 'B1',
    category: 'B',
    name: 'Budget revision chain',
    messages: [
      'The project budget is £500k.',
      'Turns out the budget was revised — it\'s actually £350k now.',
      'Good news, they bumped it back up to £600k for Q2.',
    ],
    expectedEntities: [],
    expectedRelationships: [],
  },
  {
    id: 'B2',
    category: 'B',
    name: 'Launch date moved',
    messages: [
      'Project launch is set for April 15th.',
      'Launch moved to May 1st due to testing delays.',
    ],
    expectedEntities: [],
    expectedRelationships: [],
  },
  {
    id: 'B3',
    category: 'B',
    name: 'Office relocation',
    messages: [
      'The office is on Baker Street.',
      'Actually we moved to King Street last month.',
    ],
    expectedEntities: [
      { name: 'Baker Street', type: 'place' },
      { name: 'King Street', type: 'place' },
    ],
  },
  {
    id: 'B4',
    category: 'B',
    name: 'Team size change',
    messages: [
      'Team size is 12 people.',
      'We just hired 3 more, so 15 now.',
    ],
    expectedEntities: [],
  },
];

// --- Category C: Implicit relationships ---

const C_SCENARIOS: ExtractionScenario[] = [
  {
    id: 'C1',
    category: 'C',
    name: 'Team shipped API gateway',
    messages: [
      `Bob's team just shipped v2.0 of the API gateway. Maria did most of the auth work and Dave handled the rate limiter.`,
    ],
    expectedEntities: [
      { name: 'Bob', type: 'person' },
      { name: 'Maria', type: 'person' },
      { name: 'Dave', type: 'person' },
    ],
    expectedRelationships: [
      { subject: 'Maria', predicate: 'works_on', object: 'auth', temporal: 'present' },
      { subject: 'Dave', predicate: 'works_on', object: 'rate limiter', temporal: 'present' },
    ],
  },
  {
    id: 'C2',
    category: 'C',
    name: 'Conference team structure',
    messages: [
      `Lisa is coordinating the conference. Her team includes James (speaker management), Nora (logistics), and Yuki (marketing).`,
    ],
    expectedEntities: [
      { name: 'Lisa', type: 'person' },
      { name: 'James', type: 'person' },
      { name: 'Nora', type: 'person' },
      { name: 'Yuki', type: 'person' },
    ],
  },
  {
    id: 'C3',
    category: 'C',
    name: 'Project dependency chain',
    messages: [
      `The Alpha project depends on the data pipeline, which is maintained by Platform Engineering.`,
    ],
    expectedEntities: [
      { name: 'Alpha', type: 'project' },
      { name: 'Platform Engineering', type: 'team' },
    ],
  },
  {
    id: 'C4',
    category: 'C',
    name: 'Reporting chain',
    messages: [
      `Mira reports to Jacob, who leads the infrastructure group under VP Elena.`,
    ],
    expectedEntities: [
      { name: 'Mira', type: 'person' },
      { name: 'Jacob', type: 'person' },
      { name: 'Elena', type: 'person' },
    ],
    expectedRelationships: [
      { subject: 'Mira', predicate: 'reports_to', object: 'Jacob', temporal: 'present' },
    ],
  },
];

// --- Category D: Ambiguous references ---

const D_SCENARIOS: ExtractionScenario[] = [
  {
    id: 'D1',
    category: 'D',
    name: 'Disambiguating Alex and migration',
    messages: [
      `Spoke to Alex about the migration — not the database one, the cloud one. Same Alex from the onboarding last week.`,
    ],
    expectedEntities: [
      { name: 'Alex', type: 'person' },
    ],
  },
  {
    id: 'D2',
    category: 'D',
    name: 'Disambiguating Python projects',
    messages: [
      `The Python project is behind schedule — not the ML one, the automation scripts.`,
    ],
    expectedEntities: [],
  },
  {
    id: 'D3',
    category: 'D',
    name: 'Disambiguating Jordan',
    messages: [
      `Meeting with Jordan tomorrow. Not the consultant, the one from engineering.`,
    ],
    expectedEntities: [
      { name: 'Jordan', type: 'person' },
    ],
  },
];

// --- Category E: Conversational sequences ---

const E_SCENARIOS: ExtractionScenario[] = [
  {
    id: 'E1',
    category: 'E',
    name: 'DevOps meeting sequence',
    messages: [
      'Meeting with the DevOps team tomorrow at 2pm.',
      'They want to discuss the Kubernetes rollout.',
      "Sarah said she can't make it, she's in New York.",
    ],
    expectedEntities: [
      { name: 'Sarah', type: 'person' },
      { name: 'New York', type: 'place' },
      { name: 'Kubernetes', type: 'concept' },
    ],
  },
  {
    id: 'E2',
    category: 'E',
    name: 'Q2 roadmap planning',
    messages: [
      'Working on the Q2 roadmap.',
      'Need to prioritize the auth overhaul.',
      'Also the dashboard redesign is blocked on the new API.',
    ],
    expectedEntities: [],
  },
  {
    id: 'E3',
    category: 'E',
    name: 'Client call outcome',
    messages: [
      'Client call went well.',
      'They want custom reporting.',
      'Budget is $50k for the module.',
    ],
    expectedEntities: [],
  },
];

// --- Category F: Temporal language patterns ---

const F_SCENARIOS: ExtractionScenario[] = [
  {
    id: 'F1',
    category: 'F',
    name: 'Alice career timeline',
    messages: [
      `Alice used to work at Acme but joined Beta Corp in January. She's been leading their ML platform team since March.`,
    ],
    expectedEntities: [
      { name: 'Alice', type: 'person' },
      { name: 'Acme', type: 'company' },
      { name: 'Beta Corp', type: 'company' },
    ],
    expectedRelationships: [
      { subject: 'Alice', predicate: 'works_at', object: 'Acme', temporal: 'past' },
      { subject: 'Alice', predicate: 'works_at', object: 'Beta Corp', temporal: 'present' },
    ],
    temporalExpectations: [
      { description: 'Acme employment ended', hasValidAt: false, hasInvalidAt: true },
      { description: 'Beta Corp employment started January', hasValidAt: true, hasInvalidAt: false },
      { description: 'ML platform lead since March', hasValidAt: true, hasInvalidAt: false },
    ],
  },
  {
    id: 'F2',
    category: 'F',
    name: 'CRM system migration',
    messages: [
      `We had the old CRM system until last quarter. Now we're on Salesforce.`,
    ],
    expectedEntities: [
      { name: 'Salesforce', type: 'company' },
    ],
    temporalExpectations: [
      { description: 'Old CRM ended last quarter', hasValidAt: false, hasInvalidAt: true },
      { description: 'Salesforce started', hasValidAt: true, hasInvalidAt: false },
    ],
  },
  {
    id: 'F3',
    category: 'F',
    name: 'Nina relocation',
    messages: [
      `Nina was based in Tokyo for two years before relocating to Singapore this January.`,
    ],
    expectedEntities: [
      { name: 'Nina', type: 'person' },
      { name: 'Tokyo', type: 'place' },
      { name: 'Singapore', type: 'place' },
    ],
    expectedRelationships: [
      { subject: 'Nina', predicate: 'lives_in', object: 'Tokyo', temporal: 'past' },
      { subject: 'Nina', predicate: 'lives_in', object: 'Singapore', temporal: 'present' },
    ],
    temporalExpectations: [
      { description: 'Tokyo residence ended January', hasValidAt: false, hasInvalidAt: true },
      { description: 'Singapore residence started January', hasValidAt: true, hasInvalidAt: false },
    ],
  },
  {
    id: 'F4',
    category: 'F',
    name: 'API deprecation timeline',
    messages: [
      `The legacy API will be deprecated next month. New endpoints go live on Friday.`,
    ],
    expectedEntities: [],
    temporalExpectations: [
      { description: 'Deprecation is future', hasValidAt: true, hasInvalidAt: false },
      { description: 'New endpoints go live Friday', hasValidAt: true, hasInvalidAt: false },
    ],
  },
];

// --- Category G: Retrieval queries ---

const G_SCENARIOS: RetrievalScenario[] = [
  {
    id: 'G1',
    category: 'G',
    name: 'React developer in Manchester',
    seededFacts: [
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
      { subjectName: 'Beta Corp', subjectType: 'company', predicate: 'located_in', objectName: 'Manchester', objectType: 'place' },
      { subjectName: 'Alice', subjectType: 'person', predicate: 'has_role', objectValue: 'React developer' },
      { subjectName: 'Bob', subjectType: 'person', predicate: 'works_at', objectName: 'Omega Inc', objectType: 'company' },
      { subjectName: 'Omega Inc', subjectType: 'company', predicate: 'located_in', objectName: 'London', objectType: 'place' },
      { subjectName: 'Bob', subjectType: 'person', predicate: 'has_role', objectValue: 'Python developer' },
    ],
    query: 'Who could help with React development in Manchester?',
    expectedRelevantEntities: ['Alice'],
  },
  {
    id: 'G2',
    category: 'G',
    name: 'Project team manager',
    seededFacts: [
      { subjectName: 'Bob', subjectType: 'person', predicate: 'manages', objectName: 'Team Alpha', objectType: 'other' },
      { subjectName: 'Team Alpha', subjectType: 'other', predicate: 'works_on', objectName: 'Project X', objectType: 'project' },
      { subjectName: 'Carol', subjectType: 'person', predicate: 'member_of', objectName: 'Team Alpha', objectType: 'other' },
    ],
    query: 'Who manages the team working on Project X?',
    expectedRelevantEntities: ['Bob'],
  },
  {
    id: 'G3',
    category: 'G',
    name: 'Python developers in London',
    seededFacts: [
      { subjectName: 'Sarah', subjectType: 'person', predicate: 'has_role', objectValue: 'Python developer' },
      { subjectName: 'Sarah', subjectType: 'person', predicate: 'works_at', objectName: 'DataCo', objectType: 'company' },
      { subjectName: 'DataCo', subjectType: 'company', predicate: 'located_in', objectName: 'London', objectType: 'place' },
      { subjectName: 'Mike', subjectType: 'person', predicate: 'has_role', objectValue: 'Python developer' },
      { subjectName: 'Mike', subjectType: 'person', predicate: 'works_at', objectName: 'CloudTech', objectType: 'company' },
      { subjectName: 'CloudTech', subjectType: 'company', predicate: 'located_in', objectName: 'Berlin', objectType: 'place' },
    ],
    query: 'Python developers in London?',
    expectedRelevantEntities: ['Sarah'],
  },
  {
    id: 'G4',
    category: 'G',
    name: 'No match graceful degradation',
    seededFacts: [
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
    ],
    query: 'What is the status of the Mars colonization project?',
    expectedRelevantEntities: [],
  },
];

// --- Category H: Temporal state queries ---

const H_SCENARIOS: RetrievalScenario[] = [
  {
    id: 'H1',
    category: 'H',
    name: 'Alice employer at specific time',
    seededFacts: [
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Acme', objectType: 'company',
        validAt: new Date('2023-01-01'), invalidAt: new Date('2024-06-01'),
      },
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Beta Corp', objectType: 'company',
        validAt: new Date('2024-06-01'),
      },
    ],
    query: 'Where was Alice working in early 2024?',
    expectedRelevantEntities: ['Alice', 'Acme'],
  },
  {
    id: 'H2',
    category: 'H',
    name: 'Budget at specific time',
    seededFacts: [
      {
        subjectName: 'Project Alpha', subjectType: 'project', predicate: 'has_status',
        objectValue: 'Budget: £500k',
        validAt: new Date('2026-01-15'), invalidAt: new Date('2026-02-20'),
      },
      {
        subjectName: 'Project Alpha', subjectType: 'project', predicate: 'has_status',
        objectValue: 'Budget: £350k',
        validAt: new Date('2026-02-20'),
      },
    ],
    query: 'What was the Project Alpha budget in February?',
    expectedRelevantEntities: ['Project Alpha'],
  },
];

// --- Category J: ML-as-Judge scenarios ---

export const JUDGE_SCENARIOS: JudgeScenario[] = [
  {
    id: 'J1',
    name: 'Simple fact query',
    seededFacts: [
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
      { subjectName: 'Alice', subjectType: 'person', predicate: 'has_role', objectValue: 'Senior Engineer' },
    ],
    question: 'Where does Alice work?',
    knownFactsDescription: [
      'Alice works at Beta Corp',
      'Alice has the role of Senior Engineer',
    ],
    expectedJudgement: 'CONSISTENT',
  },
  {
    id: 'J2',
    name: 'Temporal query',
    seededFacts: [
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Acme', objectType: 'company',
        validAt: new Date('2023-01-01'), invalidAt: new Date('2024-06-01'),
      },
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Beta Corp', objectType: 'company',
        validAt: new Date('2024-06-01'),
      },
    ],
    question: 'Where did Alice work in 2023?',
    knownFactsDescription: [
      'Alice worked at Acme from January 2023 to June 2024',
      'Alice has worked at Beta Corp since June 2024',
    ],
    expectedJudgement: 'CONSISTENT',
  },
  {
    id: 'J3',
    name: 'Contradiction awareness (current state)',
    seededFacts: [
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Acme', objectType: 'company',
        validAt: new Date('2023-01-01'), invalidAt: new Date('2024-06-01'),
      },
      {
        subjectName: 'Alice', subjectType: 'person', predicate: 'works_at',
        objectName: 'Beta Corp', objectType: 'company',
        validAt: new Date('2024-06-01'),
      },
    ],
    question: 'Where does Alice currently work?',
    knownFactsDescription: [
      'Alice worked at Acme from January 2023 to June 2024 (no longer current)',
      'Alice has worked at Beta Corp since June 2024 (current)',
    ],
    expectedJudgement: 'CONSISTENT',
  },
  {
    id: 'J4',
    name: 'Multi-fact synthesis',
    seededFacts: [
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
      { subjectName: 'Beta Corp', subjectType: 'company', predicate: 'located_in', objectName: 'Manchester', objectType: 'place' },
      { subjectName: 'Alice', subjectType: 'person', predicate: 'has_role', objectValue: 'ML Platform Lead' },
    ],
    question: 'Tell me about Alice — where does she work and what does she do?',
    knownFactsDescription: [
      'Alice works at Beta Corp',
      'Beta Corp is located in Manchester',
      'Alice has the role of ML Platform Lead',
    ],
    expectedJudgement: 'CONSISTENT',
  },
  {
    id: 'J5',
    name: 'Knowledge boundary — unknown entity',
    seededFacts: [
      { subjectName: 'Alice', subjectType: 'person', predicate: 'works_at', objectName: 'Beta Corp', objectType: 'company' },
    ],
    question: 'What does Zephyr Technologies do?',
    knownFactsDescription: [
      'Alice works at Beta Corp',
      'No information about Zephyr Technologies exists in the knowledge base',
    ],
    expectedJudgement: 'UNCERTAIN',
  },
];

// --- Contradiction test pairs (for Layer 2 E5/E6) ---

export const CONTRADICTION_PAIRS: GoldenContradictionPair[] = [
  // True positives — should detect contradiction
  {
    fact1: { subject: 'Alice', predicate: 'works_at', object: 'Acme' },
    fact2: { subject: 'Alice', predicate: 'works_at', object: 'Beta Corp' },
    expectContradicts: true,
  },
  {
    fact1: { subject: 'Project', predicate: 'has_status', object: 'Budget is £500k' },
    fact2: { subject: 'Project', predicate: 'has_status', object: 'Budget is £350k' },
    expectContradicts: true,
  },
  {
    fact1: { subject: 'Office', predicate: 'located_in', object: 'Baker Street' },
    fact2: { subject: 'Office', predicate: 'located_in', object: 'King Street' },
    expectContradicts: true,
  },
  {
    fact1: { subject: 'Team', predicate: 'has_status', object: 'Size: 12 people' },
    fact2: { subject: 'Team', predicate: 'has_status', object: 'Size: 15 people' },
    expectContradicts: true,
  },
  {
    fact1: { subject: 'Launch', predicate: 'scheduled_for', object: 'April 15th' },
    fact2: { subject: 'Launch', predicate: 'scheduled_for', object: 'May 1st' },
    expectContradicts: true,
  },
  // True negatives — should NOT detect contradiction
  {
    fact1: { subject: 'Alice', predicate: 'knows', object: 'Bob' },
    fact2: { subject: 'Alice', predicate: 'knows', object: 'Carol' },
    expectContradicts: false,
  },
  {
    fact1: { subject: 'Alice', predicate: 'works_on', object: 'Project Alpha' },
    fact2: { subject: 'Alice', predicate: 'works_on', object: 'Project Beta' },
    expectContradicts: false,
  },
  {
    fact1: { subject: 'Alice', predicate: 'has_role', object: 'engineer' },
    fact2: { subject: 'Alice', predicate: 'has_role', object: 'ML Platform Lead' },
    expectContradicts: false,
  },
  {
    fact1: { subject: 'Alice', predicate: 'works_at', object: 'Acme' },
    fact2: { subject: 'Bob', predicate: 'works_at', object: 'Acme' },
    expectContradicts: false,
  },
  {
    fact1: { subject: 'Company', predicate: 'located_in', object: 'London' },
    fact2: { subject: 'Company', predicate: 'located_in', object: 'Manchester' },
    expectContradicts: true,
  },
];

// --- Classification test data (for Layer 2 E7) ---

export const CLASSIFICATION_SCENARIOS = [
  { text: 'Remember to call John about the project tomorrow', acceptableIntents: ['task', 'reminder', 'todo'] },
  { text: 'Had a great brainstorming session about the new onboarding flow', acceptableIntents: ['thought', 'note', 'idea'] },
  { text: 'How does the authentication module handle token refresh?', acceptableIntents: ['question', 'query'] },
  { text: 'https://arxiv.org/abs/2401.12345', acceptableIntents: ['link', 'url', 'reference'] },
  { text: 'Interesting that their API uses GraphQL instead of REST', acceptableIntents: ['thought', 'note', 'idea'] },
  { text: 'Buy office supplies and book the conference room for Monday', acceptableIntents: ['task', 'reminder', 'todo'] },
  { text: 'What is the SLA for our tier-1 customers?', acceptableIntents: ['question', 'query'] },
  { text: 'Deploy the hotfix to staging before EOD', acceptableIntents: ['task', 'reminder', 'todo'] },
  { text: 'Why did the last CI pipeline take 45 minutes?', acceptableIntents: ['question', 'query'] },
  { text: 'The new caching layer reduced P99 latency by 40%', acceptableIntents: ['thought', 'note', 'idea'] },
  { text: 'Set up a recurring 1:1 with the new hire starting next week', acceptableIntents: ['task', 'reminder', 'todo'] },
  { text: 'I think we should switch from Kafka to Redpanda for the event bus', acceptableIntents: ['thought', 'note', 'idea'] },
];

// --- Aggregate exports ---

export const EXTRACTION_SCENARIOS: ExtractionScenario[] = [
  ...A_SCENARIOS,
  ...B_SCENARIOS,
  ...C_SCENARIOS,
  ...D_SCENARIOS,
  ...E_SCENARIOS,
  ...F_SCENARIOS,
];

export const RETRIEVAL_SCENARIOS: RetrievalScenario[] = [
  ...G_SCENARIOS,
  ...H_SCENARIOS,
];

/** All expected entities across all extraction scenarios */
export function getAllExpectedEntities(): GoldenEntity[] {
  return EXTRACTION_SCENARIOS.flatMap(s => s.expectedEntities);
}

/** All expected relationships across all extraction scenarios */
export function getAllExpectedRelationships(): GoldenRelationship[] {
  return EXTRACTION_SCENARIOS.flatMap(s => s.expectedRelationships ?? []);
}

/** Scenarios with temporal language (for E4 test) */
export function getTemporalScenarios(): ExtractionScenario[] {
  return EXTRACTION_SCENARIOS.filter(s =>
    s.temporalExpectations && s.temporalExpectations.length > 0
  );
}
