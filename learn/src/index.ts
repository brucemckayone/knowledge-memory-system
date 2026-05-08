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
import { lessonOverlayRoutes, overlayAdminRoutes } from './routes/lesson-overlays.js';
import { insightRoutes } from './routes/insights.js';
import { flashcardRoutes } from './routes/flashcards.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { articleRoutes } from './routes/articles.js';
import { lessonPinRoutes } from './routes/lesson-pin.js';
import { explainRoutes } from './routes/explain.js';
import { noteRoutes } from './routes/notes.js';
import { artifactRoutes } from './routes/artifacts.js';
import {
  startPatrolCron,
  startPatrolRun,
  isPatrolInFlight,
  getRecentPatrolRuns,
} from './services/patrol-cron.js';
import { db, courses, sections } from './db/index.js';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { compactAllOverlays } from './services/lesson-overlay.js';

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
// Mount overlay routes BEFORE sectionRoutes so /:id/overlay paths take precedence
// over /:id (which would otherwise be matched as a 404 section lookup).
app.route('/api/sections', lessonOverlayRoutes);
app.route('/api/sections', sectionRoutes);
app.route('/api/insights', insightRoutes);
app.route('/api/flashcards', flashcardRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/articles', articleRoutes);
app.route('/api/lesson-pin', lessonPinRoutes);
app.route('/api/explain', explainRoutes);
app.route('/api/notes', noteRoutes);
app.route('/api/artifacts', artifactRoutes);
app.route('/api/admin', overlayAdminRoutes);

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

// ── Startup recovery ───────────────────────────────────────────────────────
// Course generation and lesson generation are both fire-and-forget. If the
// server dies mid-job, the row stays in its in-flight status forever because
// the success/failure handler never runs. On boot, mark any rows that have
// been "in flight" for >20 minutes as failed so the UI can recover.
const ORPHAN_THRESHOLD = '-20 minutes';

async function sweepOrphans(): Promise<void> {
  try {
    const courseRows = await db.update(courses)
      .set({ status: 'error', updatedAt: new Date().toISOString() })
      .where(and(
        eq(courses.status, 'building'),
        dsql`datetime(${courses.createdAt}) < datetime('now', ${ORPHAN_THRESHOLD})`,
      ))
      .returning({ id: courses.id });
    if (courseRows.length > 0) {
      console.log(`[startup] swept ${courseRows.length} orphan course(s) from 'building' → 'error': ${courseRows.map(r => r.id).join(', ')}`);
    }
  } catch (err) {
    console.error('[startup] orphan course sweep failed:', err);
  }

  try {
    const sectionRows = await db.update(sections)
      .set({
        lessonStatus: 'error',
        lessonStage: null,
        lessonError: 'Server restarted mid-generation',
      })
      .where(and(
        eq(sections.lessonStatus, 'building'),
        dsql`datetime(${sections.lessonStartedAt}) < datetime('now', ${ORPHAN_THRESHOLD})`,
      ))
      .returning({ id: sections.id });
    if (sectionRows.length > 0) {
      console.log(`[startup] swept ${sectionRows.length} orphan lesson(s) from 'building' → 'error': ${sectionRows.map(r => r.id).join(', ')}`);
    }
  } catch (err) {
    console.error('[startup] orphan lesson sweep failed:', err);
  }

  // nmemo-15o: bound lesson_overlays growth on each boot. Idempotent — only
  // deletes rows beyond the retention policy. Failure is non-fatal: the
  // admin endpoint /api/admin/compact-overlays can be invoked manually.
  try {
    const stats = await compactAllOverlays();
    if (stats.rowsDeleted > 0) {
      console.log(`[startup] overlay compaction: scanned ${stats.pairsScanned} pair(s), kept ${stats.rowsKept}, deleted ${stats.rowsDeleted}`);
    }
  } catch (err) {
    console.error('[startup] overlay compaction failed:', err);
  }
}

// ── Server ─────────────────────────────────────────────────────────────────
if (!process.env.VITEST) {
  void sweepOrphans();
  startPatrolCron();
  serve({
    fetch: app.fetch,
    port: config.PORT,
    // Node's http.Server defaults to a 5-minute requestTimeout, which kills
    // long-running agent calls (artifact-generator with Opus 4.7 high can
    // run >5min). Disable the per-request timeout entirely; individual
    // agent calls enforce their own ceilings.
    serverOptions: { requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0 },
  }, (info) => {
    console.log(`Learning platform listening on :${info.port}`);
    console.log(`Nmemo platform: ${config.NMEMO_URL}`);
  });
}
