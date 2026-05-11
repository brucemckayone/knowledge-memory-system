import type { Skill, SkillContext } from '../types.js';

export interface TranscribeInput {
  audio_url: string;
  language?: string;
}

export interface TranscribeOutput {
  text: string;
  language: string;
  duration_ms: number;
}

/**
 * Transcribe skill - Convert audio to text
 * Uses faster-whisper via Python ML services
 */
export const transcribeSkill: Skill<TranscribeInput, TranscribeOutput> = {
  name: 'transcribe',
  description: 'Transcribe audio to text using Whisper',
  version: '1.0.0',

  async execute(input: TranscribeInput, context: SkillContext): Promise<TranscribeOutput> {
    context.log(`Transcribing audio: ${input.audio_url.slice(-30)}`);

    const result = await context.services.ml.transcribe(input.audio_url);

    context.log(`Transcribed ${result.duration_ms}ms audio -> ${result.text.length} chars`);

    return result;
  },
};
