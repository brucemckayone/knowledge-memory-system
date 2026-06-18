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

const RETRY_STATUS_CODES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000];
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parse an HTTP Retry-After header value. Accepts either a seconds count
 * ("5", "30") or an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns
 * milliseconds capped at MAX_RETRY_AFTER_MS, or null if the header is
 * absent / unparseable. Negative dates (already in the past) clamp to 0.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  // Try seconds-format first (integer-only — Date.parse would accept "5"
  // as a year on some engines).
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const asSeconds = Number(trimmed);
    if (Number.isFinite(asSeconds)) {
      return Math.min(asSeconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  const asDateMs = Date.parse(trimmed);
  if (Number.isFinite(asDateMs)) {
    return Math.min(Math.max(0, asDateMs - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return null;
}

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

      // Retryable status codes. 429 honours Retry-After when present;
      // 502/503/504 keep the existing linear backoff schedule.
      if (RETRY_STATUS_CODES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
        const retryAfterMs = response.status === 429
          ? parseRetryAfter(response.headers.get('Retry-After'))
          : null;
        await sleep(retryAfterMs ?? BACKOFF_MS[attempt]!);
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

// --- Predicate resolution (doc 42 §6, PC3/PC4) ---

export interface ResolvePredicateCandidate {
  predicate: string;
  description?: string;
  embedding: number[];
  subjectType?: string | null;
  objectType?: string | null;
  inversePredicate?: string | null;
  aliases?: string[];
}

export interface ResolvePredicateRequest {
  predicate: string;
  subjectType?: string | null;
  objectType?: string | null;
  candidates: ResolvePredicateCandidate[];
  mergeThreshold?: number;
  distinctThreshold?: number;
}

export interface ResolvePredicateResponse {
  decision: 'merge' | 'distinct' | 'ambiguous';
  canonical: string | null;
  base: string;
  temporal_hint: string | null;
  score: number;
  signals: Record<string, unknown>;
  top: Array<{ predicate: string; combined: number; inverse_blocked: boolean }>;
}

// --- Public API ---

export const ml = {
  embed(text: string, model = config.EMBED_MODEL) {
    return mlFetch<EmbedResponse>('/embed', { text, model }, 600_000);
  },

  /** Resolve a raw predicate to canonical/mint/ambiguous (doc 42 §6). Stateless:
   * the caller passes the candidate canonicals (with their stored embeddings). */
  resolvePredicate(req: ResolvePredicateRequest) {
    return mlFetch<ResolvePredicateResponse>('/resolve-predicate', {
      predicate: req.predicate,
      ...(req.subjectType != null ? { subject_type: req.subjectType } : {}),
      ...(req.objectType != null ? { object_type: req.objectType } : {}),
      candidates: req.candidates.map((c) => ({
        predicate: c.predicate,
        description: c.description ?? '',
        embedding: c.embedding,
        subject_type: c.subjectType ?? null,
        object_type: c.objectType ?? null,
        inverse_predicate: c.inversePredicate ?? null,
        aliases: c.aliases ?? [],
      })),
      ...(req.mergeThreshold != null ? { merge_threshold: req.mergeThreshold } : {}),
      ...(req.distinctThreshold != null ? { distinct_threshold: req.distinctThreshold } : {}),
    }, 120_000);
  },

  extractEntities(
    text: string,
    validTypes?: string[],
    knownEntities?: Array<{ name: string; type: string }>,
    contextSnippets?: string[],
  ) {
    return mlFetch<ExtractEntitiesResponse>('/extract-entities', {
      text,
      ...(validTypes ? { valid_types: validTypes } : {}),
      ...(knownEntities?.length ? { known_entities: knownEntities } : {}),
      ...(contextSnippets?.length ? { context_snippets: contextSnippets } : {}),
    }, 600_000);
  },

  extractRelationships(
    content: string,
    entities: Array<{ name: string; type?: string }>,
    validPredicates?: string[],
    knownFacts?: Array<{ subject: string; predicate: string; object: string }>,
    contextSnippets?: string[],
  ) {
    return mlFetch<ExtractRelationshipsResponse>('/extract-relationships', {
      content,
      entities,
      ...(validPredicates ? { valid_predicates: validPredicates } : {}),
      ...(knownFacts?.length ? { known_facts: knownFacts } : {}),
      ...(contextSnippets?.length ? { context_snippets: contextSnippets } : {}),
    }, 600_000);
  },

  /**
   * Generic JSON-output Haiku call. Wraps /chat with a system prompt that
   * instructs the model to return raw JSON (no code fences, no prose) and
   * parses the response. Used by the Phase 6 pattern-naming pipeline; safe
   * to call for any small structured-output task.
   *
   * Throws MlClientError on HTTP failure or JSON parse failure. Callers
   * should wrap in try/catch when failures must not block the surrounding
   * operation (e.g. nameCandidatePatterns falls back to name=NULL).
   */
  async generateJson<T = Record<string, unknown>>(prompt: string): Promise<T> {
    type ChatResponse = { response: string };
    const SYSTEM = 'Respond ONLY with a JSON object. No prose, no code fences, no markdown — just the raw JSON.';
    const result = await mlFetch<ChatResponse>('/chat', {
      message: prompt,
      system_prompt: SYSTEM,
    }, 60_000);
    const cleaned = result.response
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MlClientError(
        '/chat',
        422,
        `generateJson: response is not valid JSON (${message}); cleaned=${JSON.stringify(cleaned.slice(0, 200))}`,
      );
    }
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
