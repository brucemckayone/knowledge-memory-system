import { randomUUID } from 'crypto';
import type { Envelope, Origin, RawInput } from '../types/envelope.js';

interface CreateEnvelopeParams {
  platform: Origin['platform'];
  senderId: string;
  senderName: string;
  senderHandle?: string;
  conversationId: string;
  conversationName?: string;
  messageId?: string;
  replyToId?: string;
  rawType: RawInput['type'];
  content?: string;
  mediaUrl?: string;
  forwardedFrom?: { sender: string; date: string };
}

/**
 * Create a new envelope from message data
 */
export function createEnvelope(params: CreateEnvelopeParams): Envelope {
  return {
    envelope_version: '1.0',
    trace_id: randomUUID(),
    created_at: new Date().toISOString(),
    
    origin: {
      platform: params.platform,
      sender: {
        id: params.senderId,
        name: params.senderName,
        handle: params.senderHandle,
      },
      context: {
        conversation_id: params.conversationId,
        conversation_name: params.conversationName,
        message_id: params.messageId,
        reply_to_id: params.replyToId,
      },
      platform_data: {},
    },
    
    raw: {
      type: params.rawType,
      content: params.content,
      media_url: params.mediaUrl,
      forwarded_from: params.forwardedFrom,
    },
    
    enrichments: {},
    pipeline_log: [],
    
    routing: {
      intents: [],
      workflows: [],
      status: 'pending',
    },
  };
}

/**
 * Add enrichment to envelope
 */
export function addEnrichment<T>(
  envelope: Envelope,
  stage: string,
  result: T,
  startTime: number
): void {
  envelope.enrichments[stage] = result;
  
  envelope.pipeline_log.push({
    stage,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'success',
  });
}

/**
 * Log pipeline failure
 */
export function logFailure(
  envelope: Envelope,
  stage: string,
  error: string,
  startTime: number
): void {
  envelope.pipeline_log.push({
    stage,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'failed',
    error,
  });
}
