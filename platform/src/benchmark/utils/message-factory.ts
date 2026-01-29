/**
 * Message Factory
 *
 * Creates Telegram-like message objects for benchmark injection.
 * These messages match the format expected by the message processor.
 */

export interface BenchmarkMessage {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  text?: string;
  voice?: {
    fileId: string;
    duration: number;
  };
  timestamp: string;
  /** For tracking in benchmark results */
  benchmarkMetadata?: {
    scenario: string;
    expectedEntities?: string[];
    expectedFacts?: number;
    threadId?: string;
  };
}

/**
 * Message type for content generation
 */
export type MessageType = 'text' | 'link' | 'voice' | 'question' | 'task';

/**
 * Create a text message
 */
export function createTextMessage(params: {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  text: string;
  timestamp: Date;
  metadata?: BenchmarkMessage['benchmarkMetadata'];
}): BenchmarkMessage {
  return {
    chatId: params.chatId,
    messageId: params.messageId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    text: params.text,
    timestamp: params.timestamp.toISOString(),
    benchmarkMetadata: params.metadata,
  };
}

/**
 * Create a link message
 */
export function createLinkMessage(params: {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  url: string;
  context?: string; // Optional comment about the link
  timestamp: Date;
  metadata?: BenchmarkMessage['benchmarkMetadata'];
}): BenchmarkMessage {
  const text = params.context ? `${params.context}\n${params.url}` : params.url;
  return {
    chatId: params.chatId,
    messageId: params.messageId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    text,
    timestamp: params.timestamp.toISOString(),
    benchmarkMetadata: params.metadata,
  };
}

/**
 * Create a voice note message (transcribed)
 *
 * Note: We don't actually upload audio files. Instead, we provide
 * pre-transcribed text directly to simulate voice-to-text output.
 */
export function createVoiceMessage(params: {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  transcription: string; // Pre-transcribed text
  duration: number; // Simulated duration in seconds
  timestamp: Date;
  metadata?: BenchmarkMessage['benchmarkMetadata'];
}): BenchmarkMessage {
  return {
    chatId: params.chatId,
    messageId: params.messageId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    text: params.transcription,
    voice: {
      fileId: `voice_${params.messageId}`, // Mock file ID
      duration: params.duration,
    },
    timestamp: params.timestamp.toISOString(),
    benchmarkMetadata: params.metadata,
  };
}

/**
 * Create a question message
 */
export function createQuestionMessage(params: {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  question: string;
  timestamp: Date;
  metadata?: BenchmarkMessage['benchmarkMetadata'];
}): BenchmarkMessage {
  const text = params.question.startsWith('?')
    ? params.question
    : `? ${params.question}`;

  return {
    chatId: params.chatId,
    messageId: params.messageId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    text,
    timestamp: params.timestamp.toISOString(),
    benchmarkMetadata: params.metadata,
  };
}

/**
 * Create a task message
 */
export function createTaskMessage(params: {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  task: string;
  dueDate?: Date;
  timestamp: Date;
  metadata?: BenchmarkMessage['benchmarkMetadata'];
}): BenchmarkMessage {
  let text = params.task;
  if (params.dueDate) {
    const dueStr = params.dueDate.toLocaleDateString();
    text += ` (due: ${dueStr})`;
  }

  return {
    chatId: params.chatId,
    messageId: params.messageId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    text,
    timestamp: params.timestamp.toISOString(),
    benchmarkMetadata: params.metadata,
  };
}

/**
 * Create a message sequence (conversation thread)
 */
export function createMessageThread(messages: {
  type: MessageType;
  content: string;
  delaySeconds?: number;
}[], baseParams: {
  chatId: number;
  startMessageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  startTime: Date;
}): BenchmarkMessage[] {
  const thread: BenchmarkMessage[] = [];
  let currentTime = baseParams.startTime.getTime();

  messages.forEach((msg, index) => {
    const delay = (msg.delaySeconds || 0) * 1000;
    currentTime += delay;
    const timestamp = new Date(currentTime);
    const messageId = baseParams.startMessageId + index;

    switch (msg.type) {
      case 'text':
        thread.push(createTextMessage({
          ...baseParams,
          messageId,
          text: msg.content,
          timestamp,
        }));
        break;

      case 'link':
        thread.push(createLinkMessage({
          ...baseParams,
          messageId,
          url: msg.content,
          timestamp,
        }));
        break;

      case 'voice':
        thread.push(createVoiceMessage({
          ...baseParams,
          messageId,
          transcription: msg.content,
          duration: 30, // Default 30s
          timestamp,
        }));
        break;

      case 'question':
        thread.push(createQuestionMessage({
          ...baseParams,
          messageId,
          question: msg.content,
          timestamp,
        }));
        break;

      case 'task':
        thread.push(createTaskMessage({
          ...baseParams,
          messageId,
          task: msg.content,
          timestamp,
        }));
        break;
    }
  });

  return thread;
}
