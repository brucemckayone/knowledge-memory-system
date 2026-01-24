import { config } from '../config.js';

interface EmbedResponse {
  vector: number[];
  model: string;
  dimensions: number;
}

interface TranscribeResponse {
  text: string;
  language: string;
  duration_ms: number;
}

/**
 * Generate embedding for text
 */
export async function embed(text: string, model = 'nomic-embed-text'): Promise<EmbedResponse> {
  const response = await fetch(`${config.ML_SERVICES_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model }),
  });

  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.statusText}`);
  }

  return response.json() as Promise<EmbedResponse>;
}

/**
 * Transcribe audio file
 */
export async function transcribe(audioUrl: string): Promise<TranscribeResponse> {
  const response = await fetch(`${config.ML_SERVICES_URL}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl }),
  });

  if (!response.ok) {
    throw new Error(`Transcription failed: ${response.statusText}`);
  }

  return response.json() as Promise<TranscribeResponse>;
}

/**
 * Health check for ML services
 */
export async function checkMlHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
