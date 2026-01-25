/**
 * Memory Generator
 *
 * Generates realistic memory test data with proper types,
 * entity mentions, and metadata.
 */

import { randomEmbedding, normalizeVector, randomUUID } from '../setup.js';
import type { GeneratedEntity } from './entity.js';

export type MemoryType = 'thought' | 'link' | 'task' | 'question' | 'voice';

// Sample content templates
const THOUGHT_TEMPLATES = [
  'Had a great meeting with {person} today about {project}. Key takeaway: {concept} is crucial.',
  'Need to follow up with {person} regarding the {project} timeline.',
  'Interesting observation: {company} is investing heavily in {concept}.',
  'Discussed {concept} implementation with the team. {person} raised good points.',
  'Thinking about how {concept} could improve our {project} workflow.',
  'Met {person} at the {place} office. They mentioned {company} is hiring.',
  'The {project} demo went well. {person} from {company} was impressed.',
  'Reading about {concept} - might be useful for {project}.',
  'Coffee chat with {person}. Learned about their work on {concept}.',
  'Team standup: {project} on track, {person} handling the {concept} piece.',
];

const LINK_SUMMARIES = [
  'Article about {concept} best practices from {company}\'s engineering blog.',
  'Tutorial: Implementing {concept} in modern applications.',
  'Case study: How {company} scaled their {project} using {concept}.',
  'Research paper on {concept} optimization techniques.',
  'Blog post: {person}\'s thoughts on {concept} and its future.',
  'Documentation for {concept} integration patterns.',
  'Video: {person} presenting {concept} at tech conference.',
  'Guide: Getting started with {concept} for {project} development.',
];

const TASK_TEMPLATES = [
  'Review {person}\'s PR for the {project} feature',
  'Schedule meeting with {person} about {concept}',
  'Update {project} documentation for {concept} integration',
  'Send {company} proposal to {person}',
  'Follow up with {person} on {project} status',
  'Research {concept} alternatives for {project}',
  'Prepare presentation on {concept} for the team',
  'Complete code review for {project} module',
  'Set up {concept} testing environment',
  'Document {project} architecture decisions',
];

const QUESTION_TEMPLATES = [
  'How does {company} handle {concept} at scale?',
  'What\'s the best approach for implementing {concept} in {project}?',
  'Who should I talk to about {concept}?',
  'When is the {project} deadline?',
  'Where can I find documentation for {concept}?',
  'Why did {person} choose {concept} for {project}?',
  'What are the trade-offs of using {concept}?',
  'How do I contact {person} at {company}?',
];

const URLS = [
  'https://engineering.example.com/blog/{concept}',
  'https://docs.example.com/{concept}/guide',
  'https://github.com/example/{project}',
  'https://medium.com/@{person}/{concept}-explained',
  'https://www.{company}.com/resources/{concept}',
  'https://arxiv.org/abs/{concept}-paper',
];

export interface GeneratedMemory {
  id: string;
  type: MemoryType;
  content: string;
  summary?: string;
  url?: string;
  embedding: number[];
  mentionedEntities: Array<{
    entityId: string;
    mention: string;
    start: number;
    end: number;
  }>;
  metadata: {
    source: string;
    processedAt: Date;
    classification?: {
      primaryIntent: MemoryType;
      confidence: number;
    };
    task?: {
      action: string;
      dueDate?: Date;
      priority: 'low' | 'medium' | 'high' | 'urgent';
    };
  };
  createdAt: Date;
}

export interface MemoryGeneratorOptions {
  type?: MemoryType;
  withEmbedding?: boolean;
  entities?: GeneratedEntity[];
  createdAt?: Date;
}

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomDate(daysAgo: number = 90): Date {
  const now = Date.now();
  const pastMs = daysAgo * 24 * 60 * 60 * 1000;
  return new Date(now - Math.random() * pastMs);
}

/**
 * Fill a template with entity names and track mentions
 */
function fillTemplate(
  template: string,
  entities: GeneratedEntity[]
): { content: string; mentions: GeneratedMemory['mentionedEntities'] } {
  const mentions: GeneratedMemory['mentionedEntities'] = [];
  let content = template;

  // Find placeholder types and their required entity types
  const placeholders: Array<{ placeholder: string; entityType: string }> = [
    { placeholder: '{person}', entityType: 'person' },
    { placeholder: '{company}', entityType: 'company' },
    { placeholder: '{project}', entityType: 'project' },
    { placeholder: '{concept}', entityType: 'concept' },
    { placeholder: '{place}', entityType: 'place' },
  ];

  for (const { placeholder, entityType } of placeholders) {
    while (content.includes(placeholder)) {
      const matchingEntities = entities.filter(e => e.entityType === entityType);
      if (matchingEntities.length === 0) {
        // Use a fallback name if no matching entity
        content = content.replace(placeholder, `[${entityType}]`);
        continue;
      }

      const entity = randomElement(matchingEntities);
      const start = content.indexOf(placeholder);
      content = content.replace(placeholder, entity.canonicalName);
      const end = start + entity.canonicalName.length;

      mentions.push({
        entityId: '', // Will be set when entity is created in DB
        mention: entity.canonicalName,
        start,
        end,
      });
    }
  }

  return { content, mentions };
}

/**
 * Generate a thought memory
 */
function generateThought(options: MemoryGeneratorOptions): GeneratedMemory {
  const template = randomElement(THOUGHT_TEMPLATES);
  const { content, mentions } = fillTemplate(template, options.entities || []);

  return {
    id: randomUUID(),
    type: 'thought',
    content,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
    mentionedEntities: mentions,
    metadata: {
      source: 'telegram',
      processedAt: new Date(),
      classification: {
        primaryIntent: 'thought',
        confidence: 0.85 + Math.random() * 0.15,
      },
    },
    createdAt: options.createdAt ?? randomDate(),
  };
}

/**
 * Generate a link memory
 */
function generateLink(options: MemoryGeneratorOptions): GeneratedMemory {
  const summaryTemplate = randomElement(LINK_SUMMARIES);
  const urlTemplate = randomElement(URLS);
  const { content: summary, mentions } = fillTemplate(summaryTemplate, options.entities || []);
  const { content: url } = fillTemplate(urlTemplate, options.entities || []);

  return {
    id: randomUUID(),
    type: 'link',
    content: url.replace(/\s+/g, '-').toLowerCase(),
    summary,
    url: url.replace(/\s+/g, '-').toLowerCase(),
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
    mentionedEntities: mentions,
    metadata: {
      source: 'telegram',
      processedAt: new Date(),
      classification: {
        primaryIntent: 'link',
        confidence: 0.95,
      },
    },
    createdAt: options.createdAt ?? randomDate(),
  };
}

/**
 * Generate a task memory
 */
function generateTask(options: MemoryGeneratorOptions): GeneratedMemory {
  const template = randomElement(TASK_TEMPLATES);
  const { content, mentions } = fillTemplate(template, options.entities || []);
  const priorities: Array<'low' | 'medium' | 'high' | 'urgent'> = ['low', 'medium', 'high', 'urgent'];

  // Generate a due date (some tasks have no due date)
  const hasDueDate = Math.random() > 0.3;
  const dueDate = hasDueDate
    ? new Date(Date.now() + Math.random() * 14 * 24 * 60 * 60 * 1000) // Within 2 weeks
    : undefined;

  return {
    id: randomUUID(),
    type: 'task',
    content,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
    mentionedEntities: mentions,
    metadata: {
      source: 'telegram',
      processedAt: new Date(),
      classification: {
        primaryIntent: 'task',
        confidence: 0.9,
      },
      task: {
        action: content.split(' ').slice(0, 2).join(' '),
        dueDate,
        priority: randomElement(priorities),
      },
    },
    createdAt: options.createdAt ?? randomDate(),
  };
}

/**
 * Generate a question memory
 */
function generateQuestion(options: MemoryGeneratorOptions): GeneratedMemory {
  const template = randomElement(QUESTION_TEMPLATES);
  const { content, mentions } = fillTemplate(template, options.entities || []);

  return {
    id: randomUUID(),
    type: 'question',
    content,
    embedding: options.withEmbedding !== false ? normalizeVector(randomEmbedding()) : [],
    mentionedEntities: mentions,
    metadata: {
      source: 'telegram',
      processedAt: new Date(),
      classification: {
        primaryIntent: 'question',
        confidence: 0.88,
      },
    },
    createdAt: options.createdAt ?? randomDate(),
  };
}

/**
 * Generate a voice memory (transcribed)
 */
function generateVoice(options: MemoryGeneratorOptions): GeneratedMemory {
  const thought = generateThought(options);

  return {
    ...thought,
    type: 'voice',
    metadata: {
      ...thought.metadata,
      source: 'telegram_voice',
      classification: {
        primaryIntent: 'thought',
        confidence: 0.75, // Lower confidence due to transcription
      },
    },
  };
}

/**
 * Generate a single memory
 */
export function generateMemory(options: MemoryGeneratorOptions = {}): GeneratedMemory {
  const types: MemoryType[] = ['thought', 'link', 'task', 'question', 'voice'];
  const type = options.type ?? randomElement(types);

  switch (type) {
    case 'thought':
      return generateThought(options);
    case 'link':
      return generateLink(options);
    case 'task':
      return generateTask(options);
    case 'question':
      return generateQuestion(options);
    case 'voice':
      return generateVoice(options);
  }
}

/**
 * Generate multiple memories
 */
export function generateMemories(
  count: number,
  options: MemoryGeneratorOptions = {}
): GeneratedMemory[] {
  return Array.from({ length: count }, () => generateMemory(options));
}

/**
 * Generate a batch of memories with type distribution
 */
export function generateMemoryBatch(
  distribution: {
    thoughts?: number;
    links?: number;
    tasks?: number;
    questions?: number;
    voices?: number;
  },
  entities?: GeneratedEntity[]
): GeneratedMemory[] {
  const memories: GeneratedMemory[] = [];
  const options = { entities };

  if (distribution.thoughts) {
    memories.push(...generateMemories(distribution.thoughts, { ...options, type: 'thought' }));
  }
  if (distribution.links) {
    memories.push(...generateMemories(distribution.links, { ...options, type: 'link' }));
  }
  if (distribution.tasks) {
    memories.push(...generateMemories(distribution.tasks, { ...options, type: 'task' }));
  }
  if (distribution.questions) {
    memories.push(...generateMemories(distribution.questions, { ...options, type: 'question' }));
  }
  if (distribution.voices) {
    memories.push(...generateMemories(distribution.voices, { ...options, type: 'voice' }));
  }

  return memories;
}

/**
 * Generate a conversation timeline (memories over time)
 */
export function generateConversationTimeline(
  days: number,
  memoriesPerDay: number,
  entities?: GeneratedEntity[]
): GeneratedMemory[] {
  const memories: GeneratedMemory[] = [];
  const now = Date.now();

  for (let day = 0; day < days; day++) {
    for (let i = 0; i < memoriesPerDay; i++) {
      const createdAt = new Date(now - (days - day) * 24 * 60 * 60 * 1000 +
        Math.random() * 12 * 60 * 60 * 1000); // Random time during day

      memories.push(generateMemory({ entities, createdAt }));
    }
  }

  return memories.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
