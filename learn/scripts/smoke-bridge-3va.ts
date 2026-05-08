/**
 * Smoke tests for the cross-course intelligence routes added under nmemo-3va:
 *
 *   - GET  /api/articles/by-section/:sectionId       — overlap intersection
 *   - POST /api/articles/generate                    — body validation only (the
 *     full agent invocation is gated behind a live LLM and isn't exercised
 *     here — see the "validation-only" assertion).
 *   - POST /api/explain/bridge                       — body validation only
 *     (real agent calls hit live LLM; we cover the input-error paths and
 *     verify the route is wired into the app router).
 *
 * The tests touch the SQLite DB directly to seed minimal fixtures (one
 * course + one section + two articles), exercise the routes via app.fetch,
 * and clean up at start AND end. Independent of any live Nmemo platform.
 *
 * Run with:  VITEST=1 tsx scripts/smoke-bridge-3va.ts
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { app } from '../src/index.js';
import { config } from '../src/config.js';

const raw = createClient({ url: 'file:' + config.DB_PATH });

// Tag fixtures with sentinel ids so we can clean up without affecting prod rows.
const TEST_COURSE_ID = '__test_3va_course__';
const TEST_SECTION_ID = '__test_3va_section__';
const TEST_ARTICLE_TYPE = '__test_3va_synth__';

const log = (...a: unknown[]) => console.log('[smoke-3va]', ...a);
let failures = 0;
function expect(cond: boolean, msg: string) {
  if (cond) {
    log('OK  ', msg);
  } else {
    failures += 1;
    log('FAIL', msg);
  }
}

async function cleanup() {
  // Articles first (no FK), then section, then course.
  await raw.execute({
    sql: `DELETE FROM articles WHERE type = ?`,
    args: [TEST_ARTICLE_TYPE],
  });
  await raw.execute({
    sql: `DELETE FROM sections WHERE id = ?`,
    args: [TEST_SECTION_ID],
  });
  await raw.execute({
    sql: `DELETE FROM courses WHERE id = ?`,
    args: [TEST_COURSE_ID],
  });
}

async function fetchJson(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://test${path}`, init));
  let body: any = {};
  try { body = await res.json(); } catch { /* tolerate empty */ }
  return { status: res.status, body };
}

async function main() {
  log('cleanup pre-test...');
  await cleanup();

  // Insert a course + a section with two concept entity ids.
  const conceptA = 'ent-3va-a';
  const conceptB = 'ent-3va-b';
  const conceptC = 'ent-3va-c'; // referenced by no article — for the "miss" assertion

  await raw.execute({
    sql: `INSERT INTO courses (id, title) VALUES (?, ?)`,
    args: [TEST_COURSE_ID, 'Test Course 3VA'],
  });
  await raw.execute({
    sql: `INSERT INTO sections (id, course_id, title, learning_objectives, concept_entity_ids, order_index)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      TEST_SECTION_ID, TEST_COURSE_ID, 'Test Section 3VA',
      '[]',
      JSON.stringify([conceptA, conceptB, conceptC]),
      0,
    ],
  });

  // Insert three articles. art1 overlaps on conceptA. art2 overlaps on conceptB.
  // art3 has zero overlap with the section's concepts and should be filtered out.
  const art1 = randomUUID();
  const art2 = randomUUID();
  const art3 = randomUUID();
  for (const [id, title, related, generatedAt] of [
    [art1, 'Synthesis A', [conceptA], '2026-05-06 09:00:00'],
    [art2, 'Synthesis B', [conceptB, 'unrelated-1'], '2026-05-06 10:00:00'],
    [art3, 'Unrelated synthesis', ['unrelated-x', 'unrelated-y'], '2026-05-06 11:00:00'],
  ] as const) {
    await raw.execute({
      sql: `INSERT INTO articles (id, type, title, content_md,
        related_entity_ids, related_course_ids, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, TEST_ARTICLE_TYPE, title, '# Body',
        JSON.stringify(related),
        JSON.stringify([]),
        generatedAt,
      ],
    });
  }
  log('seed done — 1 course, 1 section, 3 articles');

  // ── GET /api/articles/by-section/:sectionId ──────────────────────────────
  {
    const r = await fetchJson(`/api/articles/by-section/${TEST_SECTION_ID}`);
    expect(r.status === 200, `by-section 200 (got ${r.status})`);
    expect(Array.isArray(r.body.articles), 'by-section returns articles array');
    const ids = (r.body.articles as Array<{ id: string }>).map(a => a.id);
    expect(ids.includes(art1), `by-section includes art1 (overlaps on ${conceptA})`);
    expect(ids.includes(art2), `by-section includes art2 (overlaps on ${conceptB})`);
    expect(!ids.includes(art3), 'by-section excludes art3 (no overlap)');
    expect(typeof r.body.sectionId === 'string', 'by-section echoes sectionId');
    expect(typeof r.body.conceptCount === 'number' && r.body.conceptCount === 3,
      `by-section conceptCount=3 (got ${r.body.conceptCount})`);
  }

  // ── GET /api/articles/by-section unknown section → empty array ──────────
  {
    const r = await fetchJson(`/api/articles/by-section/__nonexistent_3va__`);
    expect(r.status === 200, `unknown section 200 (got ${r.status})`);
    expect(Array.isArray(r.body.articles) && r.body.articles.length === 0,
      'unknown section returns empty articles array');
  }

  // ── GET /api/articles/:id MUST still work for a real article id ────────
  // (regression check: confirms the new /by-section/:id route doesn't shadow
  // the existing /:id route via Hono's matcher.)
  {
    const r = await fetchJson(`/api/articles/${art1}`);
    expect(r.status === 200, `GET /api/articles/${art1} 200 (got ${r.status})`);
    expect(r.body.id === art1, 'GET /:id returns the matching article');
  }

  // ── POST /api/articles/generate — input validation ───────────────────────
  {
    // Missing body
    const r = await fetchJson(`/api/articles/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status === 400, `generate without conceptEntityIds → 400 (got ${r.status})`);
    expect(typeof r.body.error === 'string',
      'generate error message present on 400');
  }
  {
    // Empty array
    const r = await fetchJson(`/api/articles/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conceptEntityIds: [] }),
    });
    expect(r.status === 400, `generate with empty array → 400 (got ${r.status})`);
  }
  {
    // Invalid JSON
    const r = await fetchJson(`/api/articles/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(r.status === 400, `generate with invalid JSON → 400 (got ${r.status})`);
  }

  // ── POST /api/explain/bridge — input validation ─────────────────────────
  {
    // Missing aEntityId / bEntityId
    const r = await fetchJson(`/api/explain/bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aName: 'closures', bName: 'lexical scoping' }),
    });
    expect(r.status === 400, `bridge missing entity ids → 400 (got ${r.status})`);
    expect(r.body.ok === false, 'bridge 400 body.ok === false');
    expect(typeof r.body.errorText === 'string', 'bridge 400 carries errorText');
  }
  {
    // Missing aName / bName
    const r = await fetchJson(`/api/explain/bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aEntityId: 'a', bEntityId: 'b' }),
    });
    expect(r.status === 400, `bridge missing names → 400 (got ${r.status})`);
  }
  {
    // Invalid JSON
    const r = await fetchJson(`/api/explain/bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(r.status === 400, `bridge invalid JSON → 400 (got ${r.status})`);
  }

  // ── GET /api/sections/:id/bridge — empty when section has no concepts ───
  // The route also issues a same-as fetch against the platform; we tolerate
  // either the success path (overlaps array, possibly empty) or a graceful
  // degraded path (overlaps array empty when same-as is unreachable).
  {
    const r = await fetchJson(`/api/sections/${TEST_SECTION_ID}/bridge`);
    expect(r.status === 200, `section bridge 200 (got ${r.status})`);
    expect(Array.isArray(r.body.overlaps), 'section bridge returns overlaps array');
    expect(typeof r.body.conceptCount === 'number' && r.body.conceptCount === 3,
      `section bridge conceptCount=3 (got ${r.body.conceptCount})`);
  }
  {
    const r = await fetchJson(`/api/sections/__nonexistent_3va__/bridge`);
    expect(r.status === 404, `unknown section bridge → 404 (got ${r.status})`);
  }

  log('cleanup post-test...');
  await cleanup();
  await raw.close();

  if (failures > 0) {
    log(`FAILED: ${failures} assertion(s)`);
    process.exit(1);
  }
  log('ALL CHECKS PASSED');
  process.exit(0);
}

main().catch(async (err) => {
  log('THREW:', err);
  await cleanup().catch(() => {});
  await raw.close().catch(() => {});
  process.exit(2);
});
