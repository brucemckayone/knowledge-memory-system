/**
 * ML Services Client
 *
 * Stripped to graph essentials: embed, extractEntities, extractRelationships.
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
    return mlFetch<EmbedResponse>('/embed', { text, model }, 120_000);
  },

  extractEntities(text: string, validTypes?: string[]) {
    return mlFetch<ExtractEntitiesResponse>('/extract-entities', {
      text,
      ...(validTypes ? { valid_types: validTypes } : {}),
    }, 90_000);
  },

  extractRelationships(content: string, entities: Array<{ name: string; type?: string }>, validPredicates?: string[]) {
    return mlFetch<ExtractRelationshipsResponse>('/extract-relationships', {
      content,
      entities,
      ...(validPredicates ? { valid_predicates: validPredicates } : {}),
    }, 90_000);
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
