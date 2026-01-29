/**
 * ML Service Mock
 *
 * Provides deterministic ML service responses for integration testing.
 * Allows tests to run without requiring the actual ML service.
 */

import { vi, type Mock } from 'vitest';

/**
 * Mock response types
 */
export interface MockEntityExtraction {
  entities: Array<{
    mention: string;
    type: string;
    start?: number;
    end?: number;
    confidence?: number;
  }>;
}

export interface MockRelationshipExtraction {
  relationships: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    temporal_hint?: string;
    source_text?: string;
  }>;
}

export interface MockContradictionCheck {
  contradicts: boolean;
  contradiction_type?: string;
  resolution?: 'supersede' | 'invalidate' | 'coexist' | 'flag';
  confidence?: number;
  reasoning?: string;
}

export interface MockParsedContent {
  content_type: string;
  title: string;
  summary: string;
  mentions: string[];
  dates: string[];
  links: string[];
  tags: string[];
  sentiment: string;
  language: string;
  word_count: number;
}

export interface MockSummary {
  summary: string;
  key_points: string[];
  word_count: number;
}

export interface MockEmbedding {
  embedding?: number[];
  vector?: number[];
}

export interface MockEntityResolution {
  decision: 'MERGE' | 'LINK' | 'CREATE';
  confidence: number;
  reasoning?: string;
}

/**
 * Configurable mock responses
 */
export interface MockMLServiceConfig {
  extractEntities?: MockEntityExtraction | ((text: string) => MockEntityExtraction);
  extractRelationships?: MockRelationshipExtraction | ((content: string, entities: unknown[]) => MockRelationshipExtraction);
  detectContradiction?: MockContradictionCheck | ((fact1: unknown, fact2: unknown) => MockContradictionCheck);
  parseContent?: MockParsedContent | ((content: string) => MockParsedContent);
  summarize?: MockSummary | ((text: string) => MockSummary);
  embed?: MockEmbedding | ((text: string) => MockEmbedding);
  resolveEntity?: MockEntityResolution | ((mention: string, existing: unknown) => MockEntityResolution);
  health?: boolean;
}

/**
 * Default mock responses
 */
const defaultResponses: Required<MockMLServiceConfig> = {
  extractEntities: (text: string) => {
    // Simple pattern-based entity extraction for testing
    const entities: MockEntityExtraction['entities'] = [];

    // Extract potential person names (capitalized words)
    const personMatches = text.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g);
    if (personMatches) {
      for (const match of personMatches) {
        const start = text.indexOf(match);
        entities.push({
          mention: match,
          type: 'person',
          start,
          end: start + match.length,
          confidence: 0.9,
        });
      }
    }

    // Extract potential company names (capitalized words followed by Corp/Inc/LLC)
    const companyMatches = text.match(/\b([A-Z][a-zA-Z]*(?: [A-Z][a-zA-Z]*)*(?:\s+(?:Corp|Inc|LLC|Ltd|Company))?)\b/g);
    if (companyMatches) {
      for (const match of companyMatches) {
        if (match.includes('Corp') || match.includes('Inc') || match.includes('LLC')) {
          const start = text.indexOf(match);
          entities.push({
            mention: match,
            type: 'company',
            start,
            end: start + match.length,
            confidence: 0.85,
          });
        }
      }
    }

    return { entities };
  },

  extractRelationships: (content: string, entities: unknown[]) => {
    const relationships: MockRelationshipExtraction['relationships'] = [];
    const entityNames = (entities as Array<{ name: string; type: string }>).map(e => e.name);

    // Pattern: "[Person] works at [Company]"
    const worksAtMatch = content.match(/(\w+ \w+) works at (\w+(?: \w+)*)/i);
    if (worksAtMatch) {
      const [, subject, object] = worksAtMatch;
      if (subject && object && entityNames.some(n => n.toLowerCase() === subject.toLowerCase())) {
        relationships.push({
          subject,
          predicate: 'works_at',
          object,
          confidence: 0.9,
          source_text: worksAtMatch[0],
        });
      }
    }

    // Pattern: "[Person] knows [Person]"
    const knowsMatch = content.match(/(\w+ \w+) knows (\w+ \w+)/i);
    if (knowsMatch) {
      const [, subject, object] = knowsMatch;
      if (subject && object) {
        relationships.push({
          subject,
          predicate: 'knows',
          object,
          confidence: 0.85,
          source_text: knowsMatch[0],
        });
      }
    }

    // Pattern: "[Person] used to work at [Company]" (past tense)
    const usedToMatch = content.match(/(\w+ \w+) used to work at (\w+(?: \w+)*)/i);
    if (usedToMatch) {
      const [, subject, object] = usedToMatch;
      if (subject && object) {
        relationships.push({
          subject,
          predicate: 'worked_at',
          object,
          confidence: 0.85,
          temporal_hint: 'past',
          source_text: usedToMatch[0],
        });
      }
    }

    return { relationships };
  },

  detectContradiction: (fact1: unknown, fact2: unknown) => {
    const f1 = fact1 as { subject: string; predicate: string; object: string };
    const f2 = fact2 as { subject: string; predicate: string; object: string };

    // Same subject + exclusive predicate + different object = contradiction
    const exclusivePredicates = ['works_at', 'has_role', 'reports_to', 'married_to', 'lives_in', 'ceo_of'];

    if (f1.subject === f2.subject && f1.predicate === f2.predicate) {
      if (exclusivePredicates.includes(f1.predicate) && f1.object !== f2.object) {
        return {
          contradicts: true,
          contradiction_type: 'exclusive',
          resolution: 'supersede' as const,
          confidence: 0.9,
          reasoning: `${f1.predicate} is an exclusive predicate - cannot have multiple values`,
        };
      }
    }

    return {
      contradicts: false,
      confidence: 0.95,
    };
  },

  parseContent: (content: string) => {
    const words = content.split(/\s+/);
    const tags = (content.match(/#(\w+)/g) || []).map(t => t.slice(1).toLowerCase());
    const mentions = (content.match(/@(\w+)/g) || []).map(m => m.slice(1));
    const links = content.match(/https?:\/\/[^\s]+/g) || [];
    const dates = content.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/g) || [];

    let contentType = 'thought';
    if (links.length > 0) contentType = 'link';
    else if (content.includes('TODO') || content.includes('task')) contentType = 'task';
    else if (content.includes('meeting') || content.includes('event')) contentType = 'event';

    return {
      content_type: contentType,
      title: content.slice(0, 100),
      summary: content.slice(0, 200),
      mentions,
      dates,
      links,
      tags,
      sentiment: 'neutral',
      language: 'en',
      word_count: words.length,
    };
  },

  summarize: (text: string) => {
    const sentences = text.split(/[.!?]+\s+/);
    const summary = sentences.length > 2
      ? `${sentences[0]}. ${sentences[Math.floor(sentences.length / 2)]}.`
      : text.slice(0, 200);

    // Extract key terms
    const words = text.toLowerCase().split(/\s+/);
    const wordFreq = new Map<string, number>();
    for (const word of words) {
      if (word.length > 4) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    const keyPoints = Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word]) => word);

    return {
      summary,
      key_points: keyPoints,
      word_count: words.length,
    };
  },

  embed: () => {
    // Generate a consistent mock embedding
    const vector = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.1) * 0.5);
    return { vector };
  },

  resolveEntity: (mention: string, existing: unknown) => {
    const existingEntity = existing as { name: string; type: string } | null;

    if (!existingEntity) {
      return { decision: 'CREATE' as const, confidence: 0.8 };
    }

    // Simple string similarity
    const mentionLower = mention.toLowerCase();
    const existingLower = existingEntity.name.toLowerCase();

    if (mentionLower === existingLower) {
      return { decision: 'MERGE' as const, confidence: 0.99 };
    }

    // Check if one is substring of other
    if (existingLower.includes(mentionLower) || mentionLower.includes(existingLower)) {
      return { decision: 'MERGE' as const, confidence: 0.85 };
    }

    // Check initials match
    const mentionInitials = mention.split(/\s+/).map(w => w[0]).join('').toLowerCase();
    const existingInitials = existingEntity.name.split(/\s+/).map(w => w[0]).join('').toLowerCase();
    if (mentionInitials === existingInitials) {
      return { decision: 'LINK' as const, confidence: 0.7 };
    }

    return { decision: 'CREATE' as const, confidence: 0.8 };
  },

  health: true,
};

/**
 * Create a mock response with proper headers
 */
function createMockResponse(data: unknown, status = 200): Response {
  const jsonStr = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') {
          return 'application/json';
        }
        if (name.toLowerCase() === 'content-length') {
          return String(jsonStr.length);
        }
        return null;
      },
    } as Headers,
    json: async () => data,
    text: async () => jsonStr,
  } as Response;
}

/**
 * Helper to extract URL and body from fetch input
 *
 * fetch() accepts either:
 * - url: string | URL, init?: RequestInit
 * - request: Request (which contains both url and body)
 *
 * The generated API client uses Request objects, so we need to handle both.
 */
async function extractFetchInfo(input: RequestInfo | URL, init?: RequestInit) {
  let urlStr: string;
  let bodyStr: string | undefined;

  if (input instanceof Request) {
    urlStr = input.url;
    // Request.body is a ReadableStream - we need to clone and read it
    const clonedRequest = input.clone();
    bodyStr = await clonedRequest.text();
  } else {
    urlStr = input.toString();
    bodyStr = init?.body as string | undefined;
  }

  const body = bodyStr ? JSON.parse(bodyStr) : {};
  return { urlStr, body };
}

/**
 * Create a mock fetch function for ML service
 */
export function createMLServiceMock(config: MockMLServiceConfig = {}): Mock {
  const responses = { ...defaultResponses, ...config };

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { urlStr, body } = await extractFetchInfo(input, init);

    // Health check
    if (urlStr.includes('/health')) {
      return createMockResponse({ status: responses.health ? 'ok' : 'unavailable' }, responses.health ? 200 : 503);
    }

    // Extract entities
    if (urlStr.includes('/extract-entities')) {
      const result = typeof responses.extractEntities === 'function'
        ? responses.extractEntities(body.text || body.content || '')
        : responses.extractEntities;
      return createMockResponse(result);
    }

    // Extract relationships
    if (urlStr.includes('/extract-relationships')) {
      const result = typeof responses.extractRelationships === 'function'
        ? responses.extractRelationships(body.content || '', body.entities || [])
        : responses.extractRelationships;
      return createMockResponse(result);
    }

    // Detect contradiction
    if (urlStr.includes('/detect-contradiction') || urlStr.includes('/check-contradiction')) {
      const result = typeof responses.detectContradiction === 'function'
        ? responses.detectContradiction(body.fact1, body.fact2)
        : responses.detectContradiction;
      return createMockResponse(result);
    }

    // Parse content
    if (urlStr.includes('/parse-content')) {
      const result = typeof responses.parseContent === 'function'
        ? responses.parseContent(body.content || '')
        : responses.parseContent;
      return createMockResponse(result);
    }

    // Summarize
    if (urlStr.includes('/summarize')) {
      const result = typeof responses.summarize === 'function'
        ? responses.summarize(body.text || '')
        : responses.summarize;
      return createMockResponse(result);
    }

    // Embed
    if (urlStr.includes('/embed')) {
      const result = typeof responses.embed === 'function'
        ? responses.embed(body.text || '')
        : responses.embed;
      return createMockResponse(result);
    }

    // Resolve entity
    if (urlStr.includes('/resolve-entity')) {
      const result = typeof responses.resolveEntity === 'function'
        ? responses.resolveEntity(body.new_mention || '', body.existing_entity)
        : responses.resolveEntity;
      return createMockResponse(result);
    }

    // Unknown endpoint
    return createMockResponse({ error: 'Not found' }, 404);
  });
}

/**
 * Install ML service mock globally
 */
export function installMLServiceMock(config: MockMLServiceConfig = {}): Mock {
  const mock = createMLServiceMock(config);
  vi.spyOn(global, 'fetch').mockImplementation(mock);
  return mock;
}

/**
 * Restore original fetch
 */
export function restoreMLServiceMock(): void {
  vi.restoreAllMocks();
}

/**
 * Create a mock that fails for specific endpoints
 */
export function createFailingMLServiceMock(failingEndpoints: string[]): Mock {
  const baseMock = createMLServiceMock();

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Extract URL for endpoint matching
    const urlStr = input instanceof Request ? input.url : input.toString();

    for (const endpoint of failingEndpoints) {
      if (urlStr.includes(endpoint)) {
        return createMockResponse({ error: `${endpoint} service unavailable` }, 500);
      }
    }

    return baseMock(input, init);
  });
}

/**
 * Create a mock with delayed responses for testing timeouts
 */
export function createSlowMLServiceMock(delayMs: number): Mock {
  const baseMock = createMLServiceMock();

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return baseMock(input, init);
  });
}
