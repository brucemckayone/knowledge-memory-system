import type { Job } from 'pg-boss';
import { createEnvelope, addEnrichment, logFailure } from '../core/envelope-factory.js';
import { embed, transcribe } from '../services/ml.js';
import { storeMemory, searchMemories } from '../services/qdrant.js';
import { classify } from '../services/classify.js';
import { bot, getFileUrl } from '../bot/index.js';
import { createSkillContext } from '../skills/index.js';
import { processLink } from '../workflows/process-link.js';
import { processTask, formatDueDate } from '../workflows/process-task.js';

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

  // Check if this is a search query
  if (data.text?.toLowerCase().startsWith('search:')) {
    await handleSearch(data.chatId, data.text.slice(7).trim());
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

        await bot.api.sendMessage(data.chatId,
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

    // Classify intent using LLM
    console.log('🤖 Classifying intent...');
    const classifyStart = Date.now();
    const classification = await classify(textToEmbed);

    addEnrichment(envelope, 'classify', {
      intents: classification.intents,
      primary_intent: classification.primary_intent,
    }, classifyStart);

    // Add intents to routing
    envelope.routing.intents = classification.intents.map(i => i.type);
    envelope.routing.workflows = [classification.suggested_workflow];

    console.log(`✅ Classified as: ${classification.primary_intent} -> ${classification.suggested_workflow}`);

    // Route to appropriate workflow
    if (classification.primary_intent === 'link') {
      // Link workflow
      console.log('🔗 Routing to link workflow');
      const result = await processLink(envelope, context);

      if (result.success) {
        await bot.api.sendMessage(data.chatId,
          `🔗 **Link saved!**\n\n` +
          `📰 ${result.title}\n\n` +
          `📝 ${result.summary}`,
          { parse_mode: 'Markdown' }
        );
      } else {
        console.warn('Link processing failed:', result.error);
        await bot.api.sendMessage(data.chatId,
          `💭 Saved your message (couldn't fetch link details)`
        );
      }
      return;
    }

    if (classification.primary_intent === 'task') {
      // Task workflow
      console.log('📋 Routing to task workflow');
      const result = await processTask(envelope, context);

      if (result.success) {
        const priorityEmoji = {
          high: '🔴',
          medium: '🟡',
          low: '🟢',
        }[result.priority || 'medium'];

        await bot.api.sendMessage(data.chatId,
          `✅ **Task created!**\n\n` +
          `📋 ${result.action}\n` +
          `📅 ${formatDueDate(result.due_date)}\n` +
          `${priorityEmoji} Priority: ${result.priority}`,
          { parse_mode: 'Markdown' }
        );
      } else {
        console.warn('Task processing failed:', result.error);
      }
      return;
    }

    // Default: thought/question workflow
    console.log('💭 Processing as thought/question');

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

    envelope.routing.status = 'completed';

    const totalTime = Date.now() - startTime;
    console.log(`✅ Memory stored: ${envelope.trace_id} (${totalTime}ms total)`);

    // Send confirmation based on type
    const typeEmoji = classification.primary_intent === 'question' ? '❓' : '💭';
    const typeLabel = classification.primary_intent === 'question' ? 'Question' : 'Thought';

    // Only send notification for voice messages (text messages don't need confirmation)
    if (data.voice) {
      await bot.api.sendMessage(data.chatId,
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

    try {
      await bot.api.sendMessage(data.chatId, errorMessage);
    } catch {
      // Ignore notification error
    }

    throw error; // pg-boss will retry
  }
}

/**
 * Handle search queries
 */
async function handleSearch(chatId: number, query: string): Promise<void> {
  console.log(`🔍 Searching for: "${query}"`);

  try {
    // Generate query embedding
    const queryEmbedding = await embed(query);

    // Search Qdrant
    const results = await searchMemories(queryEmbedding.vector, { limit: 5 });

    if (results.length === 0) {
      await bot.api.sendMessage(chatId, '🔍 No memories found for your query.');
      return;
    }

    // Format results
    const formatted = results.map((r, i) => {
      const payload = r.payload as Record<string, unknown>;
      const score = (r.score * 100).toFixed(1);
      const content = (payload.content as string)?.slice(0, 100) || 'No content';
      const type = (payload.type as string) || 'thought';
      const typeEmoji = { thought: '💭', link: '🔗', task: '📋', question: '❓' }[type] || '📝';
      const date = new Date(payload.created_at as string).toLocaleDateString();

      return `${i + 1}. ${typeEmoji} [${score}%] ${content}...\n   📅 ${date}`;
    }).join('\n\n');

    await bot.api.sendMessage(
      chatId,
      `🔍 **Found ${results.length} memories:**\n\n${formatted}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Search failed:', error);
    await bot.api.sendMessage(chatId, '❌ Search failed. Please try again.');
  }
}

/**
 * Extract hashtags from text
 */
function extractHashtags(text: string): string[] {
  const matches = text.match(/#\w+/g);
  return matches ? matches.map(tag => tag.slice(1).toLowerCase()) : [];
}
