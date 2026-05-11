import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { checkDatabaseHealth } from './db/index.js';
import { initQueue, QUEUES, shutdownQueue } from './queue/index.js';
import { ensureCollections, checkQdrantHealth, qdrant, COLLECTIONS, searchMemories } from './services/qdrant.js';
import { checkMlHealth, embed } from './services/ml.js';
import { processMessage } from './workers/message-processor.js';
import { setupWebhook, startPolling, bot } from './bot/index.js';
import { registerCoreSkills } from './skills/index.js';
import { initController } from './gardener/controller.js';
import { registerAgents } from './gardener/agents/index.js';
import { ingestApi } from './routes/ingest.js';
import { rawQuery } from './db/raw.js';
import { sql } from 'drizzle-orm';

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

  // Let Grammy process the update (handles commands, responses, and queuing)
  try {
    await bot.handleUpdate(body);
  } catch (error) {
    console.error('❌ Bot update error:', error);
    // Don't fail the webhook - Telegram will retry on 5xx errors
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

// ==================
// API: Hybrid Search
// ==================
import { hybridSearch } from './services/hybrid-search.js';

app.get('/api/hybrid-search', async (c) => {
  const query = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '10');
  const includeGraph = c.req.query('graph') !== 'false';
  
  if (!query) {
    return c.json({ error: 'Query required' }, 400);
  }

  try {
    const results = await hybridSearch(query, {
      limit,
      includeGraph,
    });
    
    return c.json({
      query,
      count: results.length,
      results: results.map(r => ({
        id: r.memoryId,
        score: r.fusedScore,
        source: r.source,
        content: r.content,
        type: r.type,
      })),
    });
  } catch (error) {
    console.error('Hybrid search error:', error);
    return c.json({ error: 'Hybrid search failed' }, 500);
  }
});

// ===============
// API: Ingest (W35)
// ===============
app.route('/api/ingest', ingestApi);

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

// ====================
// API: Knowledge Graph
// ====================
import { getEntityProfile, getEntityMemories, searchEntities } from './services/entity-profile.js';
import { getEntityFacts, searchFacts, getFactById } from './services/facts.js';

app.get('/api/entities', async (c) => {
  const query = c.req.query('q');
  const type = c.req.query('type') as import('./services/entities.js').EntityType | undefined;
  const limit = parseInt(c.req.query('limit') || '10');

  if (!query) {
    return c.json({ error: 'Missing query parameter q' }, 400);
  }

  try {
    const results = await searchEntities(query, { limit, type });
    return c.json({ query, count: results.length, entities: results });
  } catch (error) {
    console.error('Entity search error:', error);
    return c.json({ error: 'Entity search failed' }, 500);
  }
});

app.get('/api/entities/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const profile = await getEntityProfile(id);
    if (!profile) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    return c.json(profile);
  } catch (error) {
    console.error('Entity profile error:', error);
    return c.json({ error: 'Failed to get entity profile' }, 500);
  }
});

app.get('/api/entities/:id/facts', async (c) => {
  const id = c.req.param('id');
  const asSubject = c.req.query('asSubject') !== 'false';
  const asObject = c.req.query('asObject') !== 'false';

  try {
    const facts = await getEntityFacts(id, { asSubject, asObject });
    return c.json({ entityId: id, count: facts.length, facts });
  } catch (error) {
    console.error('Entity facts error:', error);
    return c.json({ error: 'Failed to get entity facts' }, 500);
  }
});

app.get('/api/entities/:id/memories', async (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '10');

  try {
    const memories = await getEntityMemories(id, { limit });
    return c.json({ entityId: id, count: memories.length, memories });
  } catch (error) {
    console.error('Entity memories error:', error);
    return c.json({ error: 'Failed to get entity memories' }, 500);
  }
});

app.get('/api/facts', async (c) => {
  const query = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '10');

  if (!query) {
    return c.json({ error: 'Missing query parameter q' }, 400);
  }

  try {
    const results = await searchFacts(query, { limit });
    return c.json({ query, count: results.length, facts: results });
  } catch (error) {
    console.error('Fact search error:', error);
    return c.json({ error: 'Fact search failed' }, 500);
  }
});

app.get('/api/facts/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const fact = await getFactById(id);
    if (!fact) {
      return c.json({ error: 'Fact not found' }, 404);
    }
    return c.json(fact);
  } catch (error) {
    console.error('Fact lookup error:', error);
    return c.json({ error: 'Failed to get fact' }, 500);
  }
});

// ===============
// API: Task Query
// ===============
import { queryTasksNatural } from './services/task-query.js';

app.post('/api/query/tasks', async (c) => {
  try {
    const body = await c.req.json();
    const { query } = body;

    if (!query || typeof query !== 'string') {
      return c.json({ error: 'Query parameter required' }, 400);
    }

    const result = await queryTasksNatural(query);

    return c.json({
      response: result.response,
      filters_applied: result.filters_applied,
      total_matched: result.total_matched,
      tasks: result.tasks.map(t => ({
        id: t.id,
        content: t.content,
        priority: t.priority,
        status: t.status,
        due_date: t.dueDate?.toISOString() || null,
        created_at: t.createdAt.toISOString(),
        related_entities: t.relatedEntities,
      })),
    });
  } catch (error) {
    console.error('Task query error:', error);
    return c.json({ error: 'Task query failed' }, 500);
  }
});

// ===============
// API: Briefing (W32)
// ===============
import { getLatestBriefing, generateBriefing, persistBriefing } from './services/briefing.js';

app.get('/api/briefing', async (c) => {
  try {
    const briefing = await getLatestBriefing();
    if (!briefing) {
      return c.json({ error: 'No briefing available' }, 404);
    }
    return c.json(briefing);
  } catch (error) {
    console.error('Briefing error:', error);
    return c.json({ error: 'Failed to fetch briefing' }, 500);
  }
});

app.post('/api/briefing/generate', async (c) => {
  try {
    const briefing = await generateBriefing();
    const id = await persistBriefing(briefing);
    return c.json({ id, ...briefing });
  } catch (error) {
    console.error('Briefing generation error:', error);
    return c.json({ error: 'Failed to generate briefing' }, 500);
  }
});

// ===============
// API: Projects (W45)
// ===============
import { getActiveProjects, getProjectById } from './services/project-association.js';

app.get('/api/projects', async (c) => {
  try {
    const projects = await getActiveProjects();
    return c.json({ count: projects.length, projects });
  } catch (error) {
    console.error('Projects error:', error);
    return c.json({ error: 'Failed to fetch projects' }, 500);
  }
});

app.get('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const project = await getProjectById(id);
    if (!project) return c.json({ error: 'Project not found' }, 404);
    return c.json(project);
  } catch (error) {
    console.error('Project detail error:', error);
    return c.json({ error: 'Failed to fetch project' }, 500);
  }
});

// ===============
// API: Insights (W31)
// ===============
import { getActiveInsights, dismissInsight } from './services/insights.js';

app.get('/api/insights', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  try {
    const result = await getActiveInsights(limit);
    return c.json({ count: result.length, insights: result });
  } catch (error) {
    console.error('Insights error:', error);
    return c.json({ error: 'Failed to fetch insights' }, 500);
  }
});

app.post('/api/insights/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  try {
    await dismissInsight(id);
    return c.json({ ok: true });
  } catch (error) {
    console.error('Dismiss insight error:', error);
    return c.json({ error: 'Failed to dismiss insight' }, 500);
  }
});

// ============================
// API: Ontology Evolution Stats
// ============================
app.get('/api/ontology/stats', async (c) => {
  try {
    const stats = await rawQuery<{
      status: string;
      count: number;
    }>(sql`
      SELECT status, COUNT(*) as count
      FROM fact_predicates
      GROUP BY status
    `);

    const recentPromotions = await rawQuery<{
      predicate: string;
      promotedAt: Date;
      usageCount: number;
    }>(sql`
      SELECT predicate, promoted_at, usage_count
      FROM fact_predicates
      WHERE promoted_at IS NOT NULL
      ORDER BY promoted_at DESC
      LIMIT 10
    `);

    const recentRejections = await rawQuery<{
      predicate: string;
      rejectedAt: Date;
      rejectionReason: string;
    }>(sql`
      SELECT predicate, rejected_at, rejection_reason
      FROM fact_predicates
      WHERE rejected_at IS NOT NULL
      ORDER BY rejected_at DESC
      LIMIT 10
    `);

    const entityTypeStats = await rawQuery<{
      name: string;
      status: string;
    }>(sql`
      SELECT name, status FROM entity_types ORDER BY name
    `);

    return c.json({
      predicates: {
        byStatus: Object.fromEntries(stats.map(s => [s.status, s.count])),
        recentPromotions,
        recentRejections,
      },
      entityTypes: entityTypeStats,
    });
  } catch (error) {
    return c.json({ error: 'Failed to fetch ontology stats' }, 500);
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

  // Initialize Gardener (KARMA agents)
  console.log('🌱 Starting Gardener controller...');
  const gardener = initController(boss);
  registerAgents();
  await gardener.start();
  console.log('✅ Gardener ready');

  // Register workers
  await boss.work(
    QUEUES.MESSAGE_PROCESSING,
    { teamSize: config.QUEUE_CONCURRENCY, teamConcurrency: config.QUEUE_CONCURRENCY },
    processMessage
  );
  console.log('✅ Workers registered');

  // Start file watcher if enabled (W36)
  if (config.WATCH_ENABLED && config.WATCH_DIR) {
    const { startFileWatcher } = await import('./services/ingest/adapters/file-watcher.js');
    await startFileWatcher();
    console.log('✅ File watcher started');
  }

  // Set up Telegram bot (non-fatal — HTTP server starts regardless)
  try {
    if (config.WEBHOOK_URL) {
      try {
        await setupWebhook();
        console.log('✅ Bot running in webhook mode');
      } catch (error) {
        console.log('⚠️ Webhook setup failed:', (error as Error).message);
        console.log('   Falling back to polling mode...');
        await startPolling();
      }
    } else {
      await startPolling();
    }
  } catch (error) {
    console.warn('⚠️ Telegram bot failed to start:', (error as Error).message);
    console.warn('   Platform will continue without bot. Set a valid TELEGRAM_BOT_TOKEN to enable.');
  }

  // Start HTTP server
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`\n🌐 Cognitive Platform running on port ${info.port}`);
    console.log(`   Health: http://localhost:${info.port}/health`);
    console.log(`   Search: http://localhost:${info.port}/api/search?q=test`);
    console.log(`   Hybrid Search: http://localhost:${info.port}/api/hybrid-search?q=test`);
    console.log(`   Memories: http://localhost:${info.port}/api/memories`);
    console.log(`   Task Query: http://localhost:${info.port}/api/query/tasks`);
    console.log(`   Entities: http://localhost:${info.port}/api/entities?q=name`);
    console.log(`   Facts: http://localhost:${info.port}/api/facts?q=query`);
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
