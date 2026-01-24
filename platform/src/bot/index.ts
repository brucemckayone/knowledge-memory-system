import { Bot } from 'grammy';
import { config } from '../config.js';
import { getQueue, QUEUES } from '../queue/index.js';
import { embed } from '../services/ml.js';
import { searchMemories } from '../services/qdrant.js';

// Create bot instance
export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

/**
 * Perform semantic search and return formatted results
 */
async function performSearch(query: string): Promise<string> {
  try {
    // Generate embedding for the query
    const embedResult = await embed(query);
    
    // Search Qdrant
    const results = await searchMemories(embedResult.vector, { limit: 5 });
    
    if (results.length === 0) {
      return `🔍 No memories found for: "${query}"`;
    }
    
    // Format results
    let response = `🔍 **Found ${results.length} memories for "${query}":**\n\n`;
    
    results.forEach((result, index) => {
      const payload = result.payload as Record<string, any>;
      const content = payload.content || payload.text || 'No content';
      const score = (result.score * 100).toFixed(1);
      const type = payload.type || 'thought';
      const date = payload.created_at 
        ? new Date(payload.created_at as string).toLocaleDateString()
        : 'Unknown date';
      
      // Truncate content to keep messages manageable
      const truncated = content.length > 150 ? content.slice(0, 150) + '...' : content;
      
      response += `**${index + 1}.** [${score}% match]\n`;
      response += `📝 ${truncated}\n`;
      response += `_${type} • ${date}_\n\n`;
    });
    
    return response;
  } catch (error) {
    console.error('Search error:', error);
    return `❌ Search failed: ${(error as Error).message}`;
  }
}

/**
 * Queue a message for memory processing
 */
async function queueMessage(ctx: { message: any; from: any }) {
  try {
    const boss = getQueue();
    const message = ctx.message;
    
    await boss.send(QUEUES.MESSAGE_PROCESSING, {
      chatId: message.chat.id,
      messageId: message.message_id,
      senderId: ctx.from.id,
      senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
      senderUsername: ctx.from.username,
      text: message.text,
      voice: message.voice ? {
        fileId: message.voice.file_id,
        duration: message.voice.duration,
      } : undefined,
      timestamp: new Date(message.date * 1000).toISOString(),
    });
    
    console.log(`📤 Queued message ${message.message_id} for processing`);
  } catch (error) {
    console.error('Failed to queue message:', error);
  }
}

// Middleware: Log all updates
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`📨 Update ${ctx.update.update_id} processed in ${ms}ms`);
});

// Command: /start
bot.command('start', async (ctx) => {
  await ctx.reply(
    `👋 Hello ${ctx.from?.first_name}!\n\n` +
    `I'm your personal cognitive assistant. Here's what I can do:\n\n` +
    `📝 **Capture thoughts** - Just send me any message\n` +
    `🔗 **Save links** - Forward or send URLs\n` +
    `🎤 **Voice notes** - Record and send voice messages\n` +
    `🔍 **Search** - Say "search: your query"\n\n` +
    `Everything you send is stored in your personal knowledge base.`,
    { parse_mode: 'Markdown' }
  );
});

// Command: /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `**How to use Cognitive:**\n\n` +
    `1️⃣ **Capture a thought**\n` +
    `Just type anything and send it.\n\n` +
    `2️⃣ **Save a link**\n` +
    `Send any URL - I'll fetch and summarize it.\n\n` +
    `3️⃣ **Voice notes**\n` +
    `Record a voice message - I'll transcribe and save it.\n\n` +
    `4️⃣ **Search**\n` +
    `Type "search: kubernetes" to find related memories.\n\n` +
    `5️⃣ **Context**\n` +
    `Add me to a group chat - I'll remember conversations.`,
    { parse_mode: 'Markdown' }
  );
});

// Command: /search
bot.command('search', async (ctx) => {
  const query = ctx.match;
  if (!query) {
    await ctx.reply('Usage: /search <query>\n\nExample: /search kubernetes');
    return;
  }
  
  // Send typing indicator while searching
  await ctx.api.sendChatAction(ctx.chat.id, 'typing');
  
  // Perform actual semantic search
  const results = await performSearch(query);
  await ctx.reply(results, { parse_mode: 'Markdown' });
});

// Handle text messages
bot.on('message:text', async (ctx) => {
  // Check for inline search
  const text = ctx.message.text;
  if (text.toLowerCase().startsWith('search:')) {
    const query = text.slice(7).trim();
    if (!query) {
      await ctx.reply('Usage: search: <query>\n\nExample: search: kubernetes');
      return;
    }
    
    // Send typing indicator while searching
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    
    // Perform actual semantic search
    const results = await performSearch(query);
    await ctx.reply(results, { parse_mode: 'Markdown' });
    return;
  }
  
  // Queue for memory processing
  console.log(`💬 Text from ${ctx.from?.first_name}: ${text.slice(0, 50)}...`);
  await queueMessage(ctx);
});

// Handle voice messages
bot.on('message:voice', async (ctx) => {
  console.log(`🎤 Voice from ${ctx.from?.first_name}: ${ctx.message.voice.duration}s`);
  // Acknowledge voice receipt
  await ctx.reply('🎤 Got your voice note! Transcribing...');
});

// Handle photos
bot.on('message:photo', async (ctx) => {
  console.log(`📷 Photo from ${ctx.from?.first_name}`);
  await ctx.reply('📷 Got your photo! Processing...');
});

// Handle documents
bot.on('message:document', async (ctx) => {
  console.log(`📄 Document from ${ctx.from?.first_name}: ${ctx.message.document.file_name}`);
  await ctx.reply('📄 Got your document! Processing...');
});

// Handle forwarded messages
bot.on('message:forward_origin', async (ctx) => {
  console.log(`↪️ Forwarded message from ${ctx.from?.first_name}`);
  // Will be processed with forward context
});

// Error handler
bot.catch((err) => {
  console.error('❌ Bot error:', err);
});

/**
 * Set webhook URL with Telegram
 */
export async function setupWebhook(): Promise<void> {
  if (!config.WEBHOOK_URL) {
    console.log('⚠️ No WEBHOOK_URL set, skipping webhook setup');
    return;
  }
  
  const webhookUrl = `${config.WEBHOOK_URL}/webhook/telegram`;
  
  try {
    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'edited_message'],
    });
    console.log(`✅ Webhook set to: ${webhookUrl}`);
  } catch (error) {
    console.error('❌ Failed to set webhook:', error);
    throw error;
  }
}

/**
 * Get webhook info
 */
export async function getWebhookInfo() {
  return bot.api.getWebhookInfo();
}

/**
 * Delete webhook (for switching to polling)
 */
export async function deleteWebhook(): Promise<void> {
  await bot.api.deleteWebhook();
  console.log('✅ Webhook deleted');
}

/**
 * Start polling mode (for local testing without webhooks)
 */
export async function startPolling(): Promise<void> {
  console.log('🔄 Starting bot in polling mode...');
  
  // Delete any existing webhook first
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  
  bot.start({
    drop_pending_updates: true,
    onStart: () => {
      console.log('✅ Bot is running in polling mode');
    },
  });
}

/**
 * Stop the bot
 */
export function stopBot(): void {
  bot.stop();
}
