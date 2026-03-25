/**
 * Unified ML Services Client
 *
 * Single entry point for all ML service calls with timeouts and retries.
 * Replaces scattered fetch() calls and the generated SDK.
 */

import { config } from '../config.js';

// --- Error class ---

export class MlClientError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`ML ${endpoint} failed (${status}): ${detail}`);
    this.name = 'MlClientError';
  }
}

// --- Response types ---

export interface EmbedResponse {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface ClassifyResponse {
  intents: Array<{ type: string; confidence: number }>;
  primary_intent: string;
  suggested_workflow: string;
  reasoning?: string;
}

export interface SummarizeResponse {
  summary: string;
  key_points: string[];
  word_count: number;
}

export interface ChatResponse {
  response: string;
}

export interface ExtractTaskResponse {
  action: string;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  raw_due_text?: string;
  rejection_reason?: string;
}

export interface ExtractTaskEnhancedResponse extends ExtractTaskResponse {
  is_composite?: boolean;
  subtasks?: Array<{
    action: string;
    estimated_duration_minutes?: number;
    priority?: string;
    dependencies?: string[];
  }>;
  estimated_duration_minutes?: number;
  duration_confidence?: number;
  dependencies?: Array<{
    type: 'blocking' | 'prerequisite' | 'related';
    reference: string;
    confidence: number;
  }>;
  detected_conflicts?: Array<{
    type: string;
    description: string;
    severity: string;
  }>;
  suggestions?: string[];
  reasoning?: string;
}

export interface ExtractEntitiesResponse {
  entities: Array<{
    mention: string;
    type: string;
    properties?: Record<string, unknown>;
    start?: number;
    end?: number;
    confidence?: number;
  }>;
  text_length: number;
}

export interface ExtractRelationshipsResponse {
  relationships: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    temporal_hint?: string;
    source_text?: string;
  }>;
  source_content_hash: string;
  used_fallback: boolean;
}

export interface DebateLog {
  advocate_argument: string;
  defender_argument: string;
  judge_reasoning: string;
  advocate_saw_contradiction: boolean;
  defender_saw_coexistence: boolean;
}

export interface CheckContradictionResponse {
  contradicts: boolean;
  type: string;
  resolution: string;
  reasoning: string;
  confidence: number;
  debate?: DebateLog;
}

export interface ComparePredicateResponse {
  decision: string;
  reasoning: string;
  confidence: number;
}

export interface ParseContentResponse {
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
  used_fallback: boolean;
}

export interface ScrapeResponse {
  url: string;
  title: string;
  content: string;
  text: string;
  domain: string;
  word_count: number;
  description?: string;
  image?: string;
}

export interface TranscribeResponse {
  text: string;
  language: string;
  duration_ms: number;
  segments?: Array<{ start: number; end: number; text: string }>;
}

export interface HealthResponse {
  status: string;
  services: Record<string, string>;
}

// --- Core fetch wrapper with timeout + retry ---

const RETRY_STATUS_CODES = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000];

async function mlFetch<T>(
  endpoint: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const url = `${config.ML_SERVICES_URL}${endpoint}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        return (await response.json()) as T;
      }

      // Retryable status codes
      if (RETRY_STATUS_CODES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt]!);
        continue;
      }

      // Non-retryable error
      const detail = await response.text().catch(() => response.statusText);
      throw new MlClientError(endpoint, response.status, detail);
    } catch (error) {
      if (error instanceof MlClientError) throw error;

      // Abort by caller — don't retry
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new MlClientError(endpoint, 0, 'Request timed out');
      }

      // Network error — retry if attempts remain
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt]!);
        continue;
      }

      throw new MlClientError(
        endpoint,
        0,
        error instanceof Error ? error.message : 'Unknown network error',
      );
    }
  }

  // Should not reach here, but satisfy TS
  throw new MlClientError(endpoint, 0, 'Exhausted retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Public API ---

export const ml = {
  embed(text: string, model = config.EMBED_MODEL) {
    return mlFetch<EmbedResponse>('/embed', { text, model }, 10_000);
  },

  classify(text: string, includeReasoning = false) {
    return mlFetch<ClassifyResponse>('/classify', { text, include_reasoning: includeReasoning }, 15_000);
  },

  summarize(content: string, title = 'Untitled') {
    return mlFetch<SummarizeResponse>('/summarize', { content, title }, 30_000);
  },

  chat(message: string, systemPrompt?: string) {
    return mlFetch<ChatResponse>('/chat', {
      message,
      system_prompt: systemPrompt || 'You are a helpful AI assistant for a knowledge management system.',
    }, 30_000);
  },

  extractTask(text: string) {
    return mlFetch<ExtractTaskResponse>('/extract-task', { text }, 30_000);
  },

  extractTaskEnhanced(text: string, options: {
    contextMessages?: string[];
    existingTasks?: Array<{ content: string; id?: string }>;
    userPreferences?: Record<string, unknown>;
    includeReasoning?: boolean;
  } = {}) {
    return mlFetch<ExtractTaskEnhancedResponse>('/extract-task-enhanced', {
      text,
      context_messages: options.contextMessages,
      existing_tasks: options.existingTasks,
      user_preferences: options.userPreferences,
      include_reasoning: options.includeReasoning ?? false,
    }, 30_000);
  },

  extractEntities(text: string, validTypes?: string[]) {
    return mlFetch<ExtractEntitiesResponse>('/extract-entities', {
      text,
      ...(validTypes ? { valid_types: validTypes } : {}),
    }, 30_000);
  },

  extractRelationships(content: string, entities: Array<{ name: string; type?: string }>) {
    return mlFetch<ExtractRelationshipsResponse>('/extract-relationships', { content, entities }, 30_000);
  },

  checkContradiction(fact1: unknown, fact2: unknown) {
    return mlFetch<CheckContradictionResponse>('/check-contradiction', { fact1, fact2 }, 60_000);
  },

  comparePredicate(predicateA: string, descA: string, predicateB: string, descB: string) {
    return mlFetch<ComparePredicateResponse>('/compare-predicates', {
      predicate_a: predicateA,
      description_a: descA,
      predicate_b: predicateB,
      description_b: descB,
    }, 30_000);
  },

  parseContent(content: string, hint?: string) {
    return mlFetch<ParseContentResponse>('/parse-content', { content, hint }, 30_000);
  },

  scrape(url: string) {
    return mlFetch<ScrapeResponse>('/scrape', { url }, 20_000);
  },

  transcribe(audioUrl: string) {
    return mlFetch<TranscribeResponse>('/transcribe', { audio_url: audioUrl }, 120_000);
  },

  parseTranscript(content: string, formatHint?: string) {
    return mlFetch<{
      segments: Array<{ speaker: string; text: string; start_time?: string; end_time?: string }>;
      topics: Array<{ topic: string; summary: string }>;
      speakers: string[];
      summary: string;
      action_items: string[];
      word_count: number;
    }>('/parse-transcript', { content, format_hint: formatHint }, 60_000);
  },

  parseMarkdown(content: string, filename?: string) {
    return mlFetch<{
      title: string;
      frontmatter: Record<string, unknown>;
      sections: Array<{ heading?: string; level: number; content: string }>;
      links: string[];
      wikilinks: string[];
      tags: string[];
      word_count: number;
    }>('/parse-markdown', { content, filename }, 30_000);
  },

  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${config.ML_SERVICES_URL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  },
};
