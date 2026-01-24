import { Bot } from 'grammy';
import { config } from '../config.js';
import { getQueue, QUEUES } from '../queue/index.js';
import { embed } from '../services/ml.js';
import { searchMemories, qdrant, COLLECTIONS } from '../services/qdrant.js';
import { db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';

// Re-export file utilities
export { getFileUrl } from './files.js';

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
    `**Cognitive Platform - Commands**\n\n` +
    `**📝 Capture**\n` +
    `Just send any message to save it as a memory.\n\n` +
    `**🔍 Search**\n` +
    `/search <query> - Find memories\n` +
    `search: <query> - Inline search\n\n` +
    `**📋 Tasks**\n` +
    `/tasks - View pending tasks\n` +
    `"Remind me to..." - Create task\n\n` +
    `**📚 Browse**\n` +
    `/recent - Show recent memories\n` +
    `/stats - Your stats\n\n` +
    `**🎤 Voice**\n` +
    `Send voice messages - I'll transcribe them!\n\n` +
    `**🔗 Links**\n` +
    `Send URLs - I'll summarize them!`,
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

// Command: /tasks - List pending tasks
bot.command('tasks', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');

    // Fetch pending tasks
    const pendingTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'pending'))
      .orderBy(desc(tasks.createdAt))
      .limit(10);

    if (pendingTasks.length === 0) {
      await ctx.reply("✅ No pending tasks! You're all caught up.");
      return;
    }

    const taskList = pendingTasks.map((task, i) => {
      const priorityEmoji = {
        high: '🔴',
        medium: '🟡',
        low: '🟢',
      }[task.priority || 'medium'];

      const dueStr = task.dueDate
        ? `📅 ${formatDueDate(task.dueDate)}`
        : '';

      return `${i + 1}. ${priorityEmoji} ${task.content}\n   ${dueStr}`;
    }).join('\n\n');

    await ctx.reply(
      `📋 **Your Tasks (${pendingTasks.length})**\n\n${taskList}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Tasks command error:', error);
    await ctx.reply('❌ Failed to fetch tasks. Please try again.');
  }
});

// Command: /recent - Show recent memories
bot.command('recent', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');

    // Get recent memories from Qdrant
    const recent = await qdrant.scroll(COLLECTIONS.MEMORIES, {
      limit: 5,
      with_payload: true,
      with_vector: false,
    });

    if (!recent.points?.length) {
      await ctx.reply('📭 No memories found. Send me something to remember!');
      return;
    }

    const memories = recent.points.map((p, i) => {
      const payload = p.payload as Record<string, any>;
      const typeEmoji: Record<string, string> = {
        thought: '💭',
        link: '🔗',
        task: '📋',
        question: '❓',
      };

      const content = (payload.summary || payload.content || '').slice(0, 100);
      const date = payload.created_at
        ? new Date(payload.created_at as string).toLocaleDateString()
        : '';

      return `${i + 1}. ${typeEmoji[payload.type] || '📝'} ${content}${content.length === 100 ? '...' : ''}\n   _${date}_`;
    }).join('\n\n');

    await ctx.reply(
      `📚 **Recent Memories**\n\n${memories}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Recent command error:', error);
    await ctx.reply('❌ Failed to fetch recent memories.');
  }
});

// Command: /stats - Show statistics
bot.command('stats', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');

    // Get collection info from Qdrant
    const collectionInfo = await qdrant.getCollection(COLLECTIONS.MEMORIES);
    const pointCount = collectionInfo.points_count || 0;

    // Get task counts
    const taskCounts = await db
      .select({
        status: tasks.status,
        count: sql<number>`count(*)::int`,
      })
      .from(tasks)
      .groupBy(tasks.status);

    const pending = taskCounts.find(t => t.status === 'pending')?.count || 0;
    const completed = taskCounts.find(t => t.status === 'completed')?.count || 0;

    await ctx.reply(
      `📊 **Your Knowledge Stats**\n\n` +
      `📚 Memories: ${pointCount}\n` +
      `📋 Tasks pending: ${pending}\n` +
      `✅ Tasks completed: ${completed}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Stats command error:', error);
    await ctx.reply('❌ Failed to fetch stats.');
  }
});

/**
 * Format due date for display
 */
function formatDueDate(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === now.toDateString()) {
    return `Today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  if (date.toDateString() === tomorrow.toDateString()) {
    return `Tomorrow ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

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
  const duration = ctx.message.voice.duration;
  console.log(`🎤 Voice from ${ctx.from?.first_name}: ${duration}s`);

  // Check duration (max 2 minutes)
  if (duration > 120) {
    await ctx.reply('⚠️ Voice note too long! Please keep it under 2 minutes.');
    return;
  }

  // Acknowledge voice receipt
  await ctx.reply(`🎤 Got ${duration}s voice note! Transcribing...`);

  // Queue for processing
  await queueMessage(ctx);
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
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Set webhook URL with Telegram (with retry for transient errors)
 */
export async function setupWebhook(): Promise<void> {
  if (!config.WEBHOOK_URL) {
    console.log('⚠️ No WEBHOOK_URL set, skipping webhook setup');
    return;
  }

  const webhookUrl = `${config.WEBHOOK_URL}/webhook/telegram`;
  const maxRetries = 3;
  const baseDelay = 2000; // 2 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.api.setWebhook(webhookUrl, {
        drop_pending_updates: true,
        allowed_updates: ['message', 'edited_message'],
      });
      console.log(`✅ Webhook set to: ${webhookUrl}`);
      return;
    } catch (error) {
      const err = error as Error;
      const isTransientError =
        err.message?.includes('Failed to resolve host') ||
        err.message?.includes('ECONNREFUSED');

      if (isTransientError && attempt < maxRetries) {
        const delay = baseDelay * attempt;
        console.log(`⏳ Webhook attempt ${attempt}/${maxRetries} failed. Retrying in ${delay/1000}s...`);
        await sleep(delay);
      } else {
        console.error('❌ Failed to set webhook:', error);
        throw error;
      }
    }
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
