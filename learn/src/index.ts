import './config.js'; // load + validate env first
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { courseRoutes } from './routes/courses.js';
import { chatRoutes } from './routes/chat.js';
import { quizRoutes } from './routes/quiz.js';
import { learnerRoutes } from './routes/learner.js';
import { sectionRoutes } from './routes/sections.js';
import { insightRoutes } from './routes/insights.js';
import { flashcardRoutes } from './routes/flashcards.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { articleRoutes } from './routes/articles.js';
import { lessonPinRoutes } from './routes/lesson-pin.js';
import {
  startPatrolCron,
  startPatrolRun,
  isPatrolInFlight,
  getRecentPatrolRuns,
} from './services/patrol-cron.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const app = new Hono();

// ── Static frontend ────────────────────────────────────────────────────────
const vizPath = join(__dirname, '../viz/index.html');
// In development, read on every request so HTML edits show up without a server restart.
// In production (`NODE_ENV=production`) cache once at startup for speed.
const cachedHtml = config.NODE_ENV === 'production' ? readFileSync(vizPath, 'utf-8') : null;
function loadHtml(): string {
  return cachedHtml ?? readFileSync(vizPath, 'utf-8');
}
app.get('/', (c) => c.html(loadHtml()));
app.get('/learn', (c) => c.html(loadHtml()));

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', async (c) => {
  let nmemoOk = false;
  try {
    const r = await fetch(`${config.NMEMO_URL}/health`);
    nmemoOk = r.ok;
  } catch { /* offline */ }
  return c.json({ status: nmemoOk ? 'ok' : 'degraded', nmemo: nmemoOk });
});

// ── API routes ─────────────────────────────────────────────────────────────
app.route('/api/courses', courseRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/quiz', quizRoutes);
app.route('/api/learner', learnerRoutes);
app.route('/api/sections', sectionRoutes);
app.route('/api/insights', insightRoutes);
app.route('/api/flashcards', flashcardRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/articles', articleRoutes);
app.route('/api/lesson-pin', lessonPinRoutes);

// ── Patrol endpoints ───────────────────────────────────────────────────────
// POST /api/patrol/run-now  → 202 + runId, or 409 if already in flight
app.post('/api/patrol/run-now', async (c) => {
  if (isPatrolInFlight()) {
    return c.json({ error: 'patrol already in flight' }, 409);
  }
  try {
    const runId = await startPatrolRun();
    if (!runId) {
      // Race: mutex flipped between check and start. Treat as 409.
      return c.json({ error: 'patrol already in flight' }, 409);
    }
    return c.json({ ok: true, runId, status: 'running' }, 202);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'failed to start patrol', detail: msg }, 500);
  }
});

// GET /api/patrol/runs?limit=N  → { runs, total }
app.get('/api/patrol/runs', async (c) => {
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
  const { runs, total } = await getRecentPatrolRuns(limit);
  return c.json({ runs, total });
});

// Serve viz/components/*.js statically. Whitelist regex prevents directory traversal.
const componentsDir = join(__dirname, '../viz/components');
const componentFileRe = /^[A-Za-z][A-Za-z0-9_-]*\.js$/;
const cachedComponents: Record<string, string> = {};
app.get('/components/:file', (c) => {
  const file = c.req.param('file');
  if (!componentFileRe.test(file)) return c.text('Not found', 404);
  try {
    const body = config.NODE_ENV === 'production'
      ? (cachedComponents[file] ??= readFileSync(join(componentsDir, file), 'utf-8'))
      : readFileSync(join(componentsDir, file), 'utf-8');
    return c.body(body, 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
  } catch {
    return c.text('Not found', 404);
  }
});

// ── Server ─────────────────────────────────────────────────────────────────
if (!process.env.VITEST) {
  startPatrolCron();
  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`Learning platform listening on :${info.port}`);
    console.log(`Nmemo platform: ${config.NMEMO_URL}`);
  });
}
