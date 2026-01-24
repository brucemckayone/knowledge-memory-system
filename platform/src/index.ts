import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { checkDatabaseHealth } from './db/index.js';
import { initQueue, getQueue, QUEUES, shutdownQueue } from './queue/index.js';
import { ensureCollections, checkQdrantHealth, qdrant, COLLECTIONS, searchMemories } from './services/qdrant.js';
import { checkMlHealth, embed } from './services/ml.js';
import { processMessage } from './workers/message-processor.js';
import { setupWebhook, startPolling } from './bot/index.js';
import { registerCoreSkills } from './skills/index.js';

const app = new Hono();

// ============
// Health Check
// ============
app.get('/health', async (c) => {
  const [dbOk, qdrantOk, mlOk] = await Promise.all([
    checkDatabaseHealth(),
    checkQdrantHealth(),
    checkMlHealth(),
  ]);

  const healthy = dbOk && qdrantOk;
  
  return c.json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    services: {
      database: dbOk ? 'ok' : 'error',
      qdrant: qdrantOk ? 'ok' : 'error',
      ml: mlOk ? 'ok' : 'error',
    },
  }, healthy ? 200 : 503);
});

// ================
// Telegram Webhook
// ================
// Note: In polling mode, the bot handles updates directly.
// This endpoint is only used when WEBHOOK_URL is configured.
app.post('/webhook/telegram', async (c) => {
  const body = await c.req.json().catch(() => null);
  
  if (!body) {
    return c.json({ ok: false, error: 'Invalid body' }, 400);
  }
  
  // Queue message for memory processing
  if (body.message?.text || body.message?.voice) {
    const message = body.message;
    const boss = getQueue();
    
    await boss.send(QUEUES.MESSAGE_PROCESSING, {
      chatId: message.chat.id,
      messageId: message.message_id,
      senderId: message.from.id,
      senderName: message.from.first_name + (message.from.last_name ? ` ${message.from.last_name}` : ''),
      senderUsername: message.from.username,
      text: message.text,
      voice: message.voice ? {
        fileId: message.voice.file_id,
        duration: message.voice.duration,
      } : undefined,
      timestamp: new Date(message.date * 1000).toISOString(),
    });
  }
  
  return c.json({ ok: true });
});

// ============
// API: Search
// ============
app.get('/api/search', async (c) => {
  const query = c.req.query('q');
  
  if (!query) {
    return c.json({ error: 'Missing query parameter' }, 400);
  }

  try {
    const queryEmbedding = await embed(query);
    const results = await searchMemories(queryEmbedding.vector, { limit: 10 });
    
    return c.json({
      query,
      count: results.length,
      results: results.map(r => ({
        id: r.id,
        score: r.score,
        payload: r.payload,
      })),
    });
  } catch (error) {
    console.error('Search error:', error);
    return c.json({ error: 'Search failed' }, 500);
  }
});

// ===============
// API: Memories
// ===============
app.get('/api/memories', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  
  try {
    // Get recent memories by scrolling
    const results = await qdrant.scroll(COLLECTIONS.MEMORIES, {
      limit,
      with_payload: true,
      with_vector: false,
    });
    
    return c.json({
      count: results.points.length,
      memories: results.points.map(p => ({
        id: p.id,
        payload: p.payload,
      })),
    });
  } catch (error) {
    console.error('Memories list error:', error);
    return c.json({ error: 'Failed to list memories' }, 500);
  }
});

// =========
// Startup
// =========
async function start() {
  console.log('🚀 Starting Cognitive Platform...');

  // Initialize database (verify connection)
  console.log('📦 Connecting to database...');
  const dbOk = await checkDatabaseHealth();
  if (!dbOk) {
    console.error('❌ Database connection failed');
    process.exit(1);
  }
  console.log('✅ Database connected');

  // Initialize Qdrant collections
  console.log('🔍 Setting up Qdrant...');
  await ensureCollections();
  console.log('✅ Qdrant ready');

  // Initialize queue
  console.log('📋 Starting queue...');
  const boss = await initQueue();

  // Register skills
  console.log('🧠 Registering skills...');
  registerCoreSkills();

  // Register workers
  await boss.work(
    QUEUES.MESSAGE_PROCESSING,
    { teamConcurrency: config.QUEUE_CONCURRENCY },
    processMessage
  );
  console.log('✅ Workers registered');

  // Set up Telegram bot
  if (config.WEBHOOK_URL) {
    // Try webhook mode, fallback to polling if it fails
    try {
      await setupWebhook();
      console.log('✅ Bot running in webhook mode');
    } catch (error) {
      console.log('⚠️ Webhook setup failed:', (error as Error).message);
      console.log('   Falling back to polling mode...');
      await startPolling();
    }
  } else {
    // Use polling mode (no webhook URL configured)
    await startPolling();
  }

  // Start HTTP server
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`\n🌐 Cognitive Platform running on port ${info.port}`);
    console.log(`   Health: http://localhost:${info.port}/health`);
    console.log(`   Search: http://localhost:${info.port}/api/search?q=test`);
    console.log(`   Memories: http://localhost:${info.port}/api/memories`);
    console.log(`   Webhook: http://localhost:${info.port}/webhook/telegram\n`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n📴 Received ${signal}, shutting down...`);
    await shutdownQueue();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('❌ Failed to start:', error);
  process.exit(1);
});
