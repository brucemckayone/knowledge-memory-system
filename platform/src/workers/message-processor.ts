import type { Job } from 'pg-boss';
import { createEnvelope, addEnrichment, logFailure } from '../core/envelope-factory.js';
import { embed, transcribe } from '../services/ml.js';
import { storeMemory } from '../services/qdrant.js';
import { classify } from '../services/classify.js';
import { bot, getFileUrl } from '../bot/index.js';
import { createSkillContext } from '../skills/index.js';
import { processLink } from '../workflows/process-link.js';
import { processTask, formatDueDate } from '../workflows/process-task.js';
import { getController } from '../gardener/controller.js';
import { priorityEmoji } from '../utils/format.js';
import { chunkContent, storeChunks } from '../services/chunks.js';

interface MessageJobData {
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
}

/**
 * Main message processing worker
 * Routes messages through appropriate workflows based on LLM classification
 */
export async function processMessage(job: Job<MessageJobData>): Promise<void> {
  const data = job.data;
  const startTime = Date.now();

  console.log(`\n📝 Processing message ${data.messageId} from ${data.senderName}`);

  // Skip if no processable content
  if (!data.text && !data.voice) {
    console.log('⏭️ Skipping: no processable content');
    return;
  }

  // Create envelope
  const envelope = createEnvelope({
    platform: 'telegram',
    senderId: String(data.senderId),
    senderName: data.senderName,
    senderHandle: data.senderUsername,
    conversationId: String(data.chatId),
    messageId: String(data.messageId),
    rawType: data.voice ? 'voice' : 'text',
    content: data.text,
    mediaUrl: data.voice?.fileId,
  });

  console.log(`🆔 Trace ID: ${envelope.trace_id}`);

  try {
    let textToEmbed = data.text;

    // Handle voice messages - transcribe first
    if (data.voice) {
      console.log(`🎤 Processing voice note (${data.voice.duration}s)...`);

      try {
        // Get Telegram file URL
        const fileUrl = await getFileUrl(data.voice.fileId);
        console.log(`📥 Got file URL`);

        // Transcribe
        const transcribeStart = Date.now();
        const transcription = await transcribe(fileUrl);

        addEnrichment(envelope, 'transcribe', {
          text: transcription.text,
          language: transcription.language,
          duration_ms: transcription.duration_ms,
        }, transcribeStart);

        console.log(`✅ Transcribed: "${transcription.text.slice(0, 100)}..."`);

        // Use transcribed text for processing
        textToEmbed = transcription.text;
        envelope.raw.content = transcription.text;

      } catch (error) {
        console.error('❌ Transcription failed:', error);
        logFailure(envelope, 'transcribe', String(error), Date.now());

        await safeSendMessage(data.chatId,
          "❌ Sorry, I couldn't transcribe your voice note. Please try again or send text instead."
        );
        return;
      }
    }

    if (!textToEmbed) {
      console.log('⏭️ No text to process');
      return;
    }

    // Create skill context
    const context = createSkillContext(envelope);

    // Skip LLM classification — default to thought workflow
    // TODO: re-enable classification when not bulk-testing
    const classification = {
      primary_intent: 'thought' as const,
      intents: [{ type: 'thought' as const, confidence: 1.0 }],
      suggested_workflow: 'process-thought' as const,
    };

    addEnrichment(envelope, 'classify', {
      intents: classification.intents,
      primary_intent: classification.primary_intent,
    }, Date.now());

    envelope.routing.intents = [classification.primary_intent];
    envelope.routing.workflows = [classification.suggested_workflow];

    console.log(`⚡ Skipped classification — defaulting to thought workflow`);

    // Generate embedding
    const embedStart = Date.now();
    const embeddingResult = await embed(textToEmbed);

    addEnrichment(envelope, 'embed', {
      vector: embeddingResult.vector,
      model: embeddingResult.model,
    }, embedStart);

    console.log(`✅ Embedding generated (${embeddingResult.dimensions} dims)`);

    // Store in Qdrant
    console.log('💾 Storing memory...');
    const storeStart = Date.now();

    await storeMemory({
      id: envelope.trace_id,
      vector: embeddingResult.vector,
      payload: {
        trace_id: envelope.trace_id,
        type: classification.primary_intent,
        content: textToEmbed,
        summary: textToEmbed.slice(0, 200),
        origin: envelope.origin,
        created_at: envelope.created_at,
        status: 'active',
        tags: extractHashtags(textToEmbed),
        related_to: [],
        platform: envelope.origin.platform,
        sender_id: envelope.origin.sender.id,
        conversation_id: envelope.origin.context.conversation_id,
      },
    });

    addEnrichment(envelope, 'store', { memory_id: envelope.trace_id }, storeStart);

    // Register in ingestion session for cross-item context linking
    try {
      const { registerInSession } = await import('../services/ingestion-context.js');
      await registerInSession({
        memoryId: envelope.trace_id,
        senderId: envelope.origin.sender.id,
        platform: envelope.origin.platform,
        rawType: envelope.raw.type,
        contentPreview: textToEmbed.slice(0, 200),
        timestamp: new Date(envelope.created_at),
      });
    } catch (error) {
      console.warn('⚠️ Failed to register ingestion session:', error);
    }

    // Inline KARMA pipeline fan-out (replaces ingestion agent)
    try {
      const controller = getController();
      const content = textToEmbed;
      const MAX_CHUNK_SIZE = 4000;
      const CHUNK_OVERLAP = 200;

      // Chunk content if needed
      const chunks = chunkContent(content, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
      const needsChunking = chunks.length > 1;

      if (needsChunking) {
        console.log(`📦 Chunked into ${chunks.length} parts`);
        await storeChunks(envelope.trace_id, chunks);
      }

      // Queue reader agent
      await controller.enqueue({
        type: 'gardener:reader',
        tier: 'realtime',
        payload: {
          memoryId: envelope.trace_id,
          content,
          contentLength: content.length,
          chunked: needsChunking,
          chunkCount: chunks.length,
          type: classification.primary_intent,
          source: envelope.origin.platform,
        },
      });

      // Queue entity extraction
      await controller.enqueue({
        type: 'gardener:extract-entities',
        tier: 'realtime',
        payload: {
          memoryId: envelope.trace_id,
          content,
          type: classification.primary_intent,
        },
      });

      console.log('🌱 Queued for KARMA processing (reader + entity extraction)');
    } catch (error) {
      // Non-fatal: gardener processing can catch up later
      console.warn('⚠️ Failed to queue gardener jobs:', error);
      logFailure(envelope, 'gardener_queue', String(error), Date.now());
    }

    envelope.routing.status = 'completed';

    const totalTime = Date.now() - startTime;
    console.log(`✅ Memory stored: ${envelope.trace_id} (${totalTime}ms total)`);

    // Send confirmation based on type
    const typeEmoji = classification.primary_intent === 'question' ? '❓' : '💭';
    const typeLabel = classification.primary_intent === 'question' ? 'Question' : 'Thought';

    // Only send notification for voice messages (text messages don't need confirmation)
    if (data.voice) {
      await safeSendMessage(data.chatId,
        `${typeEmoji} **${typeLabel} saved!**\n\n` +
        `📝 "${textToEmbed.slice(0, 150)}${textToEmbed.length > 150 ? '...' : ''}"`,
        { parse_mode: 'Markdown' }
      );
    }

  } catch (error) {
    console.error('❌ Processing failed:', error);
    logFailure(envelope, 'processing', String(error), startTime);
    envelope.routing.status = 'failed';


    // User-friendly error message
    let errorMessage = '❌ Something went wrong. Please try again.';

    if (String(error).includes('transcription')) {
      errorMessage = "❌ Couldn't transcribe your voice note. Please try again or send text.";
    } else if (String(error).includes('fetch') || String(error).includes('scrape')) {
      errorMessage = "❌ Couldn't fetch that link. It may be blocked or unavailable.";
    } else if (String(error).includes('timeout')) {
      errorMessage = '❌ Request timed out. Please try again.';
    }

    await safeSendMessage(data.chatId, errorMessage);

    throw error; // pg-boss will retry
  }
}

/**
 * Safely send a Telegram message, catching common errors (like 400 Bad Request during E2E tests)
 */
async function safeSendMessage(chatId: number, text: string, options?: any): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text, options);
  } catch (error) {
    const errString = String(error);
    if (errString.includes('Bad Request: chat not found') || errString.includes('400')) {
      console.warn(`⚠️ Suppressed telegram error for chat ${chatId}: ${errString}`);
    } else {
      console.error(`❌ Failed to send telegram message to ${chatId}:`, error);
    }
  }
}

/**
 * Extract hashtags from text
 */
function extractHashtags(text: string): string[] {
  const matches = text.match(/#\w+/g);
  return matches ? matches.map(tag => tag.slice(1).toLowerCase()) : [];
}
