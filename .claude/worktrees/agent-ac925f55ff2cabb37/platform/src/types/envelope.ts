/**
 * Core Envelope Schema v1.0
 * 
 * Every message flowing through the system uses this structure.
 * See: ARCHITECTURE.md Section 3
 */

export interface Envelope {
  // Identity
  envelope_version: '1.0';
  trace_id: string;
  created_at: string;

  // Origin
  origin: Origin;

  // Raw input
  raw: RawInput;

  // Accumulated enrichments
  enrichments: Enrichments;

  // Pipeline execution log
  pipeline_log: PipelineEntry[];

  // Routing decisions
  routing: Routing;
}

export interface Origin {
  platform: 'telegram' | 'email' | 'browser' | 'voice' | 'api';

  sender: {
    id: string;
    name: string;
    handle?: string;
  };

  context: {
    conversation_id: string;
    conversation_name?: string;
    thread_id?: string;
    reply_to_id?: string;
    message_id?: string;
  };

  device?: {
    type: 'mobile' | 'desktop' | 'unknown';
    name?: string;
    location?: { lat: number; lng: number };
  };

  platform_data: Record<string, unknown>;
}

export interface RawInput {
  type: 'text' | 'voice' | 'image' | 'file' | 'forward' | 'location';
  content?: string;
  media_url?: string;
  file_name?: string;
  file_type?: string;
  forwarded_from?: {
    sender: string;
    date: string;
  };
}

export interface Enrichments {
  transcribe?: {
    text: string;
    language?: string;
    duration_ms?: number;
  };
  classify?: {
    intents: Intent[];
    primary_intent: string;
  };
  extract_url?: {
    url: string;
    domain: string;
  };
  fetch?: {
    title: string;
    content: string;
    author?: string;
  };
  summarize?: {
    summary: string;
    key_points?: string[];
  };
  extract_task?: {
    action: string;
    due_date?: string;
    priority?: string;
  };
  embed?: {
    vector: number[];
    model: string;
  };
  [key: string]: unknown;
}

export interface Intent {
  type: string;
  confidence: number;
}

export interface PipelineEntry {
  stage: string;
  timestamp: string;
  duration_ms: number;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
}

export interface Routing {
  intents: string[];
  workflows: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'filtered' | 'duplicate';
}

// Helper to create a new envelope
export function createEnvelope(params: {
  origin: Origin;
  raw: RawInput;
}): Envelope {
  return {
    envelope_version: '1.0',
    trace_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    origin: params.origin,
    raw: params.raw,
    enrichments: {},
    pipeline_log: [],
    routing: {
      intents: [],
      workflows: [],
      status: 'pending',
    },
  };
}
