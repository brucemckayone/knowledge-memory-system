import type { Job } from 'pg-boss';
import { createEnvelope, addEnrichment, logFailure } from '../core/envelope-factory.js';
import { embed } from '../services/ml.js';
import { storeMemory, searchMemories } from '../services/qdrant.js';
import { bot } from '../bot/index.js';

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
    // Process text content
    let textToEmbed = data.text;

    // If voice, transcribe first (future enhancement)
    if (data.voice) {
      console.log('🎤 Voice note detected - transcription pending');
      // TODO: Implement voice transcription in future packet
      return;
    }

    if (!textToEmbed) {
      console.log('⏭️ No text to process');
      return;
    }

    // Generate embedding
    console.log('🔢 Generating embedding...');
    const embedStart = Date.now();
    const embeddingResult = await embed(textToEmbed);
    
    addEnrichment(envelope, 'embed', {
      vector: embeddingResult.vector,
      model: embeddingResult.model,
    }, embedStart);
    
    console.log(`✅ Embedding generated (${embeddingResult.dimensions} dims)`);

    // Determine memory type (simple heuristic for now)
    const memoryType = classifySimple(textToEmbed);
    
    // Store in Qdrant
    console.log('💾 Storing memory...');
    const storeStart = Date.now();
    
    await storeMemory({
      id: envelope.trace_id,
      vector: embeddingResult.vector,
      payload: {
        // Core fields
        trace_id: envelope.trace_id,
        type: memoryType,
        content: textToEmbed,
        summary: textToEmbed.slice(0, 200),
        
        // Origin
        origin: envelope.origin,
        
        // Metadata
        created_at: envelope.created_at,
        status: 'active',
        tags: extractHashtags(textToEmbed),
        related_to: [],
        
        // For filtering
        platform: envelope.origin.platform,
        sender_id: envelope.origin.sender.id,
        conversation_id: envelope.origin.context.conversation_id,
      },
    });

    addEnrichment(envelope, 'store', { memory_id: envelope.trace_id }, storeStart);
    
    envelope.routing.status = 'completed';
    
    const totalTime = Date.now() - startTime;
    console.log(`✅ Memory stored: ${envelope.trace_id} (${totalTime}ms total)`);

  } catch (error) {
    console.error('❌ Processing failed:', error);
    logFailure(envelope, 'processing', String(error), startTime);
    envelope.routing.status = 'failed';
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
      const date = new Date(payload.created_at as string).toLocaleDateString();
      
      return `${i + 1}. [${score}%] ${content}...\n   📅 ${date}`;
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
 * Simple content classification (placeholder for LLM router)
 */
function classifySimple(text: string): string {
  const lowerText = text.toLowerCase();
  
  // URL detection
  if (lowerText.includes('http://') || lowerText.includes('https://')) {
    return 'link';
  }
  
  // Task indicators
  if (lowerText.includes('remind') || lowerText.includes('todo') || 
      lowerText.includes('need to') || lowerText.includes("don't forget")) {
    return 'task';
  }
  
  // Question detection
  if (text.endsWith('?') || lowerText.startsWith('how') || 
      lowerText.startsWith('what') || lowerText.startsWith('why')) {
    return 'question';
  }
  
  // Default to thought
  return 'thought';
}

/**
 * Extract hashtags from text
 */
function extractHashtags(text: string): string[] {
  const matches = text.match(/#\w+/g);
  return matches ? matches.map(tag => tag.slice(1).toLowerCase()) : [];
}
