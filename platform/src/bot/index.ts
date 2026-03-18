import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import { getQueue, QUEUES } from '../queue/index.js';
import { embed } from '../services/ml.js';
import { searchMemories, qdrant, COLLECTIONS } from '../services/qdrant.js';
import { db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { priorityEmoji } from '../utils/format.js';
import { rateLimiter } from './rate-limiter.js';

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
 * Safely send a typing indicator, suppressing errors if chat is unavailable
 */
async function safeSendTyping(ctx: Context): Promise<void> {
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
  } catch { /* non-critical: chat may be deleted or bot blocked */ }
}

/**
 * Queue a message for memory processing.
 * Returns true if successfully queued, false on failure.
 */
async function queueMessage(ctx: { message: any; from: any }): Promise<boolean> {
  try {
    const boss = getQueue();
    const message = ctx.message;
    const text = message.text || message.caption;

    await boss.send(QUEUES.MESSAGE_PROCESSING, {
      chatId: message.chat.id,
      messageId: message.message_id,
      senderId: ctx.from.id,
      senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
      senderUsername: ctx.from.username,
      text,
      voice: message.voice ? {
        fileId: message.voice.file_id,
        duration: message.voice.duration,
      } : undefined,
      timestamp: new Date(message.date * 1000).toISOString(),
    });

    console.log(`📤 Queued message ${message.message_id} for processing`);
    return true;
  } catch (error) {
    const errMsg = String(error);
    if (errMsg.includes('not started') || errMsg.includes('not initialized')) {
      console.error('Failed to queue message: pg-boss is not initialized. Ensure the queue is started before processing messages.');
    } else {
      console.error('Failed to queue message:', error);
    }
    return false;
  }
}

// Middleware: Log all updates
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`📨 Update ${ctx.update.update_id} processed in ${ms}ms`);
});

// Middleware: Rate limiting
bot.use(rateLimiter);

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
    `**🤖 Chat**\n` +
    `/chat <message> - Ask me anything!\n\n` +
    `**🔍 Search**\n` +
    `/search <query> - Find memories\n` +
    `search: <query> - Inline search\n\n` +
    `**📋 Tasks**\n` +
    `/tasks - View pending tasks\n` +
    `/tasks urgent - Show urgent tasks\n` +
    `/tasks work - Filter by area\n` +
    `/tasks this week - Filter by time\n` +
    `/task <number> - View task details\n` +
    `/complete <number> - Mark task done\n` +
    `"Remind me to..." - Create task\n\n` +
    `**📚 Browse**\n` +
    `/recent - Show recent memories\n` +
    `/entity <name> - Look up an entity\n` +
    `/stats - Your stats\n\n` +
    `**🎤 Voice**\n` +
    `Send voice messages - I'll transcribe them!\n\n` +
    `**🔗 Links**\n` +
    `Send URLs - I'll summarize them!`,
    { parse_mode: 'Markdown' }
  );
});

// Command: /chat - Chat with AI assistant
bot.command('chat', async (ctx) => {
  const message = ctx.match;
  if (!message) {
    await ctx.reply(
      '💬 **Chat Mode**\n\n' +
      'Ask me anything! I can help you with:\n' +
      '• Answering questions\n' +
      '• Explaining concepts\n' +
      '• Brainstorming ideas\n' +
      '• Writing assistance\n' +
      '• General conversation\n\n' +
      'Usage: /chat <your message>\n\n' +
      'Example: /chat What are the benefits of microservices?',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  try {
    // Send typing indicator while generating response
    await safeSendTyping(ctx);

    // Import chat function
    const { chat } = await import('../services/ml.js');

    // Build context from knowledge base
    let contextBlock = '';
    try {
      const embedResult = await embed(message);
      const results = await searchMemories(embedResult.vector, { limit: 3 });
      if (results.length > 0) {
        const memories = results
          .map(r => ((r.payload as any).content || '') as string)
          .filter(Boolean)
          .map((m, i) => `${i + 1}. ${m.slice(0, 300)}`);
        if (memories.length > 0) {
          contextBlock = '\n\nRelevant context from user\'s knowledge base:\n' + memories.join('\n');
        }
      }
    } catch { /* non-fatal: proceed without context */ }

    const systemPrompt = 'You are a helpful AI assistant for a personal knowledge management system.' + contextBlock;
    const response = await chat(message, systemPrompt);

    // Send response back to user
    await ctx.reply(`💬 ${response.response}`);
  } catch (error) {
    console.error('Chat error:', error);
    await ctx.reply(
      `❌ Sorry, I encountered an error: ${(error as Error).message}\n\n` +
      `Note: Chat requires the Z.AI API to be configured with sufficient balance.`
    );
  }
});

// Command: /search
bot.command('search', async (ctx) => {
  const query = ctx.match;
  if (!query) {
    await ctx.reply('Usage: /search <query>\n\nExample: /search kubernetes');
    return;
  }

  // Send typing indicator while searching
  await safeSendTyping(ctx);

  // Perform actual semantic search
  const results = await performSearch(query);
  await ctx.reply(results, { parse_mode: 'Markdown' });
});

// Command: /tasks - List pending tasks with optional filters
bot.command('tasks', async (ctx) => {
  try {
    await safeSendTyping(ctx);

    const match = ctx.match;
    const filterText = match ? String(match).trim() : '';

    // If no filter, show basic list
    if (!filterText) {
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
        const emoji = priorityEmoji(task.priority);

        const dueStr = task.dueDate
          ? `📅 ${formatDueDate(task.dueDate)}`
          : '';

        return `${i + 1}. ${emoji} ${task.content}\n   ${dueStr}`;
      }).join('\n\n');

      await ctx.reply(
        `📋 **Your Tasks (${pendingTasks.length})**\n\n${taskList}\n\n💡 Use /complete <number> to mark a task done`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // With filter text, use the query service
    const { queryTasksNatural } = await import('../services/task-query.js');
    const result = await queryTasksNatural(filterText);

    if (result.total_matched === 0) {
      await ctx.reply(
        `📋 No tasks found matching "${filterText}"\n\n` +
        `💡 Try: /tasks, /tasks urgent, /tasks work, /tasks this week`
      );
      return;
    }

    // Show filtered results with numbering for completion
    const numberedTasks = result.tasks.slice(0, 10).map((task, i) => {
      const emoji = priorityEmoji(task.priority);

      let line = `${i + 1}. ${emoji} ${task.content}`;

      if (task.dueDate) {
        line += `\n   📅 ${formatDueDate(task.dueDate)}`;
      }

      if (task.relatedEntities && task.relatedEntities.length > 0) {
        line += `\n   👥 ${task.relatedEntities.map((e: any) => e.name).join(', ')}`;
      }

      return line;
    }).join('\n\n');

    await ctx.reply(
      `📋 **${result.total_matched} Task${result.total_matched > 1 ? 's' : ''} Found**\n\n${numberedTasks}\n\n💡 Use /complete <number> to mark a task done`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Tasks command error:', error);
    await ctx.reply('❌ Failed to fetch tasks. Please try again.');
  }
});

// Command: /complete - Mark a task as done
bot.command('complete', async (ctx) => {
  try {
    const match = ctx.match;
    if (!match) {
      await ctx.reply(
        'Usage: /complete <number>\n\n' +
        'Example: /complete 1\n\n' +
        '💡 Use /tasks to see the numbered task list',
      );
      return;
    }

    const taskNumber = parseInt(String(match));
    if (isNaN(taskNumber) || taskNumber < 1) {
      await ctx.reply('❌ Invalid task number. Use /complete <number> where number is 1 or greater.');
      return;
    }

    await safeSendTyping(ctx);

    // Get last 10 pending tasks
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

    if (taskNumber > pendingTasks.length) {
      await ctx.reply(
        `❌ Task ${taskNumber} not found. Only ${pendingTasks.length} tasks available.\n\n` +
        `💡 Use /tasks to see the numbered task list`,
      );
      return;
    }

    const task = pendingTasks[taskNumber - 1];

    // Update task status
    await db
      .update(tasks)
      .set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    await ctx.reply(
      `✅ Task completed:\n\n${priorityEmoji(task.priority)} ${task.content}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Complete command error:', error);
    await ctx.reply('❌ Failed to complete task. Please try again.');
  }
});

// Command: /task - Show details for a specific task
bot.command('task', async (ctx) => {
  try {
    const match = ctx.match;
    if (!match) {
      await ctx.reply(
        'Usage: /task <number>\n\n' +
        'Example: /task 1\n\n' +
        '💡 Use /tasks to see the numbered task list',
      );
      return;
    }

    const taskNumber = parseInt(String(match));
    if (isNaN(taskNumber) || taskNumber < 1) {
      await ctx.reply('❌ Invalid task number. Use /task <number> where number is 1 or greater.');
      return;
    }

    await safeSendTyping(ctx);

    // Get last 10 pending tasks
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

    if (taskNumber > pendingTasks.length) {
      await ctx.reply(
        `❌ Task ${taskNumber} not found. Only ${pendingTasks.length} tasks available.\n\n` +
        `💡 Use /tasks to see the numbered task list`,
      );
      return;
    }

    const task = pendingTasks[taskNumber - 1];

    let details = `📋 **Task ${taskNumber}**\n\n`;
    details += `${priorityEmoji(task.priority)} *${task.content}*\n\n`;
    details += `**Priority:** ${task.priority}\n`;
    details += `**Status:** ${task.status}\n`;

    if (task.dueDate) {
      details += `**Due:** ${formatDueDate(task.dueDate)}\n`;
    }

    details += `**Created:** ${task.createdAt.toLocaleDateString()}\n`;
    details += `\n💡 Use /complete ${taskNumber} to mark this task done`;

    await ctx.reply(details, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Task command error:', error);
    await ctx.reply('❌ Failed to fetch task details. Please try again.');
  }
});

// Command: /recent - Show recent memories
bot.command('recent', async (ctx) => {
  try {
    await safeSendTyping(ctx);

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

// Command: /entity - Browse knowledge graph entities
// In-memory cache for multi-result entity searches (TTL 60s)
const entitySearchCache = new Map<number, { results: Array<{ id: string; canonicalName: string; entityType: string }>; expires: number }>();

bot.command('entity', async (ctx) => {
  try {
    const name = ctx.match ? String(ctx.match).trim() : '';

    if (!name) {
      await ctx.reply(
        '🔹 **Entity Lookup**\n\n' +
        'Usage: /entity <name>\n\n' +
        'Example: /entity Bruce\n' +
        'Example: /entity Kubernetes',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await safeSendTyping(ctx);

    // Check if this is a numeric selection from a previous search
    const chatId = ctx.chat!.id;
    const cached = entitySearchCache.get(chatId);
    const asNumber = parseInt(name);
    if (cached && !isNaN(asNumber) && cached.expires > Date.now()) {
      if (asNumber >= 1 && asNumber <= cached.results.length) {
        const selected = cached.results[asNumber - 1]!;
        entitySearchCache.delete(chatId);

        const { getEntityProfile: getProfile, formatEntityProfile: formatProfile } = await import('../services/entity-profile.js');
        const profile = await getProfile(selected.id);
        if (!profile) {
          await ctx.reply('❌ Entity no longer exists.');
          return;
        }
        await ctx.reply(formatProfile(profile), { parse_mode: 'Markdown' });
        return;
      }
    }

    const { searchEntities: search, getEntityProfile: getProfile, formatEntityProfile: formatProfile } = await import('../services/entity-profile.js');
    const results = await search(name, { limit: 10 });

    if (results.length === 0) {
      await ctx.reply(`🔍 No entities found matching "${name}"`);
      return;
    }

    if (results.length === 1) {
      const profile = await getProfile(results[0]!.id);
      if (!profile) {
        await ctx.reply('❌ Failed to load entity profile.');
        return;
      }
      await ctx.reply(formatProfile(profile), { parse_mode: 'Markdown' });
      return;
    }

    // Multiple results — show list and cache for selection
    const list = results.slice(0, 10).map((e, i) =>
      `${i + 1}. **${e.canonicalName}** (${e.entityType})`
    ).join('\n');

    entitySearchCache.set(chatId, {
      results: results.slice(0, 10).map(e => ({ id: e.id, canonicalName: e.canonicalName, entityType: e.entityType })),
      expires: Date.now() + 60_000,
    });

    await ctx.reply(
      `🔍 **${results.length} entities found:**\n\n${list}\n\nReply with /entity <number> to see details`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Entity command error:', error);
    await ctx.reply('❌ Failed to look up entity. Please try again.');
  }
});

// Command: /stats - Show statistics
bot.command('stats', async (ctx) => {
  try {
    await safeSendTyping(ctx);

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
    await safeSendTyping(ctx);
    
    // Perform actual semantic search
    const results = await performSearch(query);
    await ctx.reply(results, { parse_mode: 'Markdown' });
    return;
  }
  
  // Queue for memory processing
  console.log(`💬 Text from ${ctx.from?.first_name}: ${text.slice(0, 50)}...`);
  const queued = await queueMessage(ctx);
  if (!queued) {
    await ctx.reply('⚠️ Couldn\'t process your message right now. Please try again.');
  }
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
  const queued = await queueMessage(ctx);
  if (!queued) {
    await ctx.reply('⚠️ Couldn\'t process your voice note right now. Please try again.');
  }
});

// Handle photos
bot.on('message:photo', async (ctx) => {
  console.log(`📷 Photo from ${ctx.from?.first_name}`);
  if (ctx.message.caption) {
    const queued = await queueMessage(ctx);
    if (queued) {
      await ctx.reply('📷 Photo received — I saved your caption as a memory. Full photo processing coming soon.');
      return;
    }
  }
  await ctx.reply('📷 Photo processing is coming soon.\n💡 Add a caption and I\'ll save it as a memory.');
});

// Handle documents
bot.on('message:document', async (ctx) => {
  console.log(`📄 Document from ${ctx.from?.first_name}: ${ctx.message.document.file_name}`);
  await ctx.reply('📄 Document processing is coming soon.\n💡 Send text or a voice note and I\'ll save it as a memory.');
});

// Handle forwarded messages (text forwards are already caught by message:text)
bot.on('message:forward_origin', async (ctx) => {
  console.log(`↪️ Forwarded message from ${ctx.from?.first_name}`);
  if (!ctx.message.text && ctx.message.caption) {
    const queued = await queueMessage(ctx);
    if (!queued) {
      await ctx.reply('⚠️ Couldn\'t process the forwarded message. Please try again.');
    }
  } else if (!ctx.message.text && !ctx.message.caption) {
    await ctx.reply('↪️ Got your forwarded message — I can only process text content for now.');
  }
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
 *
 * ⚠️ IMPORTANT: WEBHOOK SETUP CURRENTLY DISABLED DUE TO IPv6 ISSUE ⚠️
 *
 * Current Status: Bot is running in POLLING MODE (webhooks not configured)
 *
 * The Problem:
 * - Cloudflare proxied domains (like bot.fartdominance.uk) return BOTH IPv4 (A) and IPv6 (AAAA) records
 * - Telegram's setWebhook API rejects webhooks that resolve to IPv6-only addresses
 * - Error: "Bad Request: bad webhook: IPv6-only addresses are not allowed"
 *
 * Why This Happens:
 * - Cloudflare's "Proxied" (orange cloud) DNS records automatically enable IPv6 anycast
 * - Telegram checks DNS and sees AAAA (IPv6) records alongside A (IPv4) records
 * - Telegram attempts IPv6 first, fails or rejects it entirely
 *
 * Attempted Solutions (didn't work):
 * 1. Using custom domain (bot.fartdominance.uk) - Cloudflare adds IPv6 automatically
 * 2. Using trycloudflare.com temporary URLs - Also return IPv6 addresses
 * 3. Named tunnels with custom CNAMEs - Still get IPv6 from Cloudflare proxy
 *
 * Required Solutions (pick one):
 *
 * OPTION 1: Configure IPv4-only routing in Cloudflare (RECOMMENDED)
 * - Go to Cloudflare Dashboard → Network tab
 * - Find "IPv6 Compatibility" setting
 * - Either disable globally OR configure per-zone
 * - Alternative: Use DNS-only (gray cloud) CNAME pointing to tunnel URL
 *   - Create CNAME: bot → <tunnel-id>.cfargotunnel.com
 *   - Set Proxy status: "DNS only" (gray cloud, NOT orange)
 *   - This bypasses Cloudflare proxy, returns only tunnel's IPv4
 *
 * OPTION 2: Use non-Cloudflare tunnel/proxy
 * - Use ngrok (free tier, has IPv4-only option)
 * - Use localtunnel with IPv4-only flag
 * - Set up VPS with nginx reverse proxy (IPv4-only)
 *
 * OPTION 3: Get dedicated IPv4 address
 * - Purchase VPS with static IPv4
 * - Configure A record directly to VPS IP
 * - Set up TLS certificate (Let's Encrypt)
 *
 * Impact of Polling Mode:
 * - Slightly higher latency (2-3 second delay vs instant webhooks)
 * - More API calls to Telegram (ongoing polling vs event-driven)
 * - Rate limit considerations (Telegram allows 30 calls/sec normally)
 * - Battery usage on mobile devices (Telegram maintains connection)
 *
 * For Development: Polling mode is fine and actually more reliable
 * For Production: MUST switch to webhooks for scale and efficiency
 *
 * Tracking: See beads issue: TBD (create task to track this)
 *
 * Last Updated: 2025-01-26
 */
export async function setupWebhook(): Promise<void> {
  if (!config.WEBHOOK_URL) {
    console.log('⚠️ No WEBHOOK_URL set, skipping webhook setup');
    return;
  }

  // Initialize bot info (required for handleUpdate in webhook mode)
  await bot.init();

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
