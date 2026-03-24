/**
 * ML Services Client
 * Re-exports from the unified ml-client for backward compatibility.
 */

export {
  ml,
  MlClientError,
  type EmbedResponse,
  type ClassifyResponse,
  type SummarizeResponse,
  type ChatResponse,
  type ExtractTaskResponse,
  type ExtractTaskEnhancedResponse,
  type ExtractEntitiesResponse,
  type ExtractRelationshipsResponse,
  type CheckContradictionResponse,
  type DebateLog,
  type ParseContentResponse,
  type ScrapeResponse,
  type TranscribeResponse,
} from './ml-client.js';

import { ml } from './ml-client.js';
import { config } from '../config.js';

/**
 * Generate embedding for text
 */
export async function embed(text: string, model = config.EMBED_MODEL) {
  return ml.embed(text, model);
}

/**
 * Transcribe audio from URL
 */
export async function transcribe(audioUrl: string) {
  return ml.transcribe(audioUrl);
}

/**
 * Extract entities from text
 */
export async function extractEntities(text: string) {
  return ml.extractEntities(text);
}

/**
 * Check for contradiction between facts
 */
export async function checkContradiction(fact1: unknown, fact2: unknown) {
  return ml.checkContradiction(fact1, fact2);
}

/**
 * Parse content metadata
 */
export async function parseContent(content: string, hint?: string) {
  return ml.parseContent(content, hint);
}

/**
 * Summarize content
 */
export async function summarize(content: string, title?: string) {
  return ml.summarize(content, title);
}

/**
 * Extract task details
 */
export async function extractTask(text: string) {
  return ml.extractTask(text);
}

/**
 * Health check for ML services
 */
export async function checkMlHealth(): Promise<boolean> {
  return ml.health();
}

/**
 * Chat with AI assistant
 */
export async function chat(message: string, systemPrompt?: string): Promise<{ response: string }> {
  return ml.chat(message, systemPrompt);
}
