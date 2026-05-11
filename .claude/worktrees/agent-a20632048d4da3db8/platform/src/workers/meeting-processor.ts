/**
 * Meeting Processor (W38)
 *
 * Processes meeting recordings and transcripts.
 * Handles: audio → transcription → transcript parsing → memory storage.
 */

import { ml } from '../services/ml-client.js';
import { storeMemory } from '../services/qdrant.js';
import { getController } from '../gardener/controller.js';

export interface MeetingInput {
  /** Meeting ID (for dedup and tracking) */
  meetingId: string;
  /** Pre-existing transcript text (if already transcribed) */
  transcript?: string;
  /** Audio file URL (for transcription) */
  audioUrl?: string;
  /** Meeting title/subject */
  title?: string;
  /** Participant names */
  participants?: string[];
  /** When the meeting occurred */
  meetingDate?: string;
  /** Source adapter that captured this */
  source: string;
}

export interface MeetingResult {
  success: boolean;
  memoryId?: string;
  segments?: number;
  topics?: string[];
  actionItems?: string[];
  error?: string;
}

/**
 * Process a meeting recording or transcript.
 */
export async function processMeeting(input: MeetingInput): Promise<MeetingResult> {
  const meetingId = input.meetingId;
  let transcript = input.transcript;

  try {
    // Step 1: Transcribe audio if no transcript provided
    if (!transcript && input.audioUrl) {
      console.log(`🎙️ Transcribing meeting ${meetingId}...`);
      const transcription = await ml.transcribe(input.audioUrl);
      transcript = transcription.text;
    }

    if (!transcript) {
      return { success: false, error: 'No transcript or audio provided' };
    }

    // Step 2: Parse transcript via ML service
    console.log(`📝 Parsing transcript for meeting ${meetingId}...`);
    let parsed;
    try {
      parsed = await parseTranscript(transcript);
    } catch {
      // If parse endpoint not available, use basic parsing
      parsed = {
        segments: [{ speaker: 'Unknown', text: transcript }],
        topics: [],
        summary: transcript.slice(0, 500),
        action_items: [],
        speakers: [],
      };
    }

    // Step 3: Generate embedding of the full transcript
    const summaryText = `Meeting: ${input.title || 'Untitled'}. ${parsed.summary}`;
    const embedding = await ml.embed(summaryText);

    // Step 4: Store as memory
    const memoryId = meetingId;
    await storeMemory({
      id: memoryId,
      vector: embedding.vector,
      payload: {
        trace_id: memoryId,
        type: 'meeting',
        content: transcript,
        summary: parsed.summary,
        origin: {
          platform: input.source,
          sender: { id: 'meeting', name: input.participants?.join(', ') || 'Unknown' },
          context: { conversation_id: meetingId },
        },
        created_at: input.meetingDate || new Date().toISOString(),
        status: 'active',
        tags: ['meeting'],
        platform: input.source,
        meeting_metadata: {
          title: input.title,
          participants: input.participants,
          segments: parsed.segments?.length || 0,
          topics: parsed.topics?.map((t: { topic: string }) => t.topic) || [],
          action_items: parsed.action_items || [],
          speakers: parsed.speakers || [],
        },
      },
    });

    // Step 5: Queue KARMA processing
    try {
      const controller = getController();
      await controller.enqueue({
        type: 'gardener:reader',
        tier: 'realtime',
        payload: {
          memoryId,
          content: transcript,
          contentLength: transcript.length,
          type: 'meeting',
          source: input.source,
        },
      });
      await controller.enqueue({
        type: 'gardener:extract-entities',
        tier: 'realtime',
        payload: {
          memoryId,
          content: transcript,
          type: 'meeting',
        },
      });
    } catch (error) {
      console.warn('⚠️ Failed to queue KARMA jobs for meeting:', error);
    }

    return {
      success: true,
      memoryId,
      segments: parsed.segments?.length || 0,
      topics: parsed.topics?.map((t: { topic: string }) => t.topic) || [],
      actionItems: parsed.action_items || [],
    };
  } catch (error) {
    console.error(`❌ Meeting processing failed for ${meetingId}:`, error);
    return { success: false, error: String(error) };
  }
}

/**
 * Parse transcript via ML service.
 */
async function parseTranscript(content: string) {
  const url = `${process.env.ML_SERVICES_URL || 'http://localhost:8000'}/parse-transcript`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Parse transcript failed: ${response.status}`);
  }

  return response.json();
}
