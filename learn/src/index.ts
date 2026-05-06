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

// ── Server ─────────────────────────────────────────────────────────────────
if (!process.env.VITEST) {
  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`Learning platform listening on :${info.port}`);
    console.log(`Nmemo platform: ${config.NMEMO_URL}`);
  });
}
