import { config } from '../config.js';
import {
  client,
  embedEmbedPost,
  transcribeUrlTranscribePost,
  healthHealthGet,
  classifyMessageClassifyPost,
  extractEntitiesExtractEntitiesPost,
  checkContradictionCheckContradictionPost,
  parseContentParseContentPost,
  summarizeContentSummarizePost,
  extractTaskExtractTaskPost,
} from './api-client/index.js';

// Configure the client
client.setConfig({
  baseUrl: config.ML_SERVICES_URL,
});

/**
 * ML Services Client
 * Unified adapter for all ML capabilities.
 */

// Re-export types if needed, or consumers can import from api-client/types.gen
export type {
  EmbedEmbedPostData,
  TranscribeUrlTranscribePostData as TranscribeRequest,
  ClassifyMessageClassifyPostResponses as ClassifyResponse,
  ExtractEntitiesExtractEntitiesPostResponses as ExtractEntitiesResponse,
  CheckContradictionCheckContradictionPostResponses as ContradictionResponse,
  ParseContentParseContentPostResponses as ParseContentResponse,
  SummarizeContentSummarizePostResponses as SummarizeResponse,
  ExtractTaskExtractTaskPostResponses as ExtractTaskResponse,
} from './api-client/types.gen.js';

/**
 * Generate embedding for text
 */
export async function embed(text: string, model = 'nomic-embed-text') {
  const response = await embedEmbedPost({
    body: { text, model },
  });
  
  if (response.error) {
    throw new Error(`Embedding failed: ${response.error}`);
  }
  
  return response.data;
}

/**
 * Transcribe audio from URL
 */
export async function transcribe(audioUrl: string) {
  const response = await transcribeUrlTranscribePost({
    body: { audio_url: audioUrl },
  });

  if (response.error) {
    throw new Error(`Transcription failed: ${response.error}`);
  }

  return response.data;
}

/**
 * Classify message intent
 */
export async function classify(text: string, _includeDateContext = true) {
  const response = await classifyMessageClassifyPost({
    body: { text, include_reasoning: true },
  });

  if (response.error) {
    throw new Error(`Classification failed: ${response.error}`);
  }

  return response.data;
}

/**
 * Extract entities from text
 */
export async function extractEntities(text: string) {
  const response = await extractEntitiesExtractEntitiesPost({
    body: { text, include_context: true },
  });

  if (response.error) {
    throw new Error(`Entity extraction failed: ${response.error}`);
  }

  return response.data;
}

/**
 * Check for contradiction between facts
 */
export async function checkContradiction(fact1: any, fact2: any) {
  const response = await checkContradictionCheckContradictionPost({
    body: { fact1, fact2 },
  });

  if (response.error) {
    throw new Error(`Contradiction check failed: ${response.error}`);
  }

  return response.data;
}

/**
 * Parse content metadata
 */
export async function parseContent(content: string, hint?: string) {
  const response = await parseContentParseContentPost({
    body: { content, hint },
  });

  if (response.error) {
    throw new Error(`Content parsing failed: ${response.error}`);
  }

  return response.data;
}

/**
 * Summarize content
 */
export async function summarize(content: string, title?: string) {
  const response = await summarizeContentSummarizePost({
    body: { content, title: title || 'Untitled' },
  });

  if (response.error) {
    throw new Error(`Summarization failed: ${response.error}`);
  }

  return response.data;
}

/**
 * Extract task details
 */
export async function extractTask(text: string) {
  const response = await extractTaskExtractTaskPost({
    body: { text },
  });

  if (response.error) {
    throw new Error(`Task extraction failed: ${response.error}`);
  }

  return response.data;
}

/**
 * Health check for ML services
 */
export async function checkMlHealth(): Promise<boolean> {
  try {
    const response = await healthHealthGet();
    // In generated client, response.data contains the body, response.response is the raw fetch response if needed
    // Assuming 200 OK means success if no error thrown
    return !response.error;
  } catch {
    return false;
  }
}

/**
 * Chat with AI assistant
 * Simple conversational interface for general queries
 */
export async function chat(message: string, systemPrompt?: string): Promise<{ response: string }> {
  const response = await fetch(`${config.ML_SERVICES_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      system_prompt: systemPrompt || 'You are a helpful AI assistant for a knowledge management system.',
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}
