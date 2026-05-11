/**
 * Smoke test for /api/insights routes (nmemo-umy.5).
 * Inserts test rows tagged type='__test_umy5__', exercises every route via app.fetch(),
 * cleans up at start AND end, and prints pass/fail with exit code.
 *
 * Uses raw libsql for setup/teardown so the test is independent of any
 * Drizzle-schema vs live-DB column drift (umy.2 added a column to schema.ts
 * that has not yet been ALTER-applied to the live DB).
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { app } from '../src/index.js';
import { config } from '../src/config.js';

const raw = createClient({ url: 'file:' + config.DB_PATH });

const TEST_TYPE = '__test_umy5__';
const TEST_TYPE_ALT = '__test_umy5_alt__';

const log = (...a: unknown[]) => console.log('[smoke]', ...a);
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
  await raw.execute({
    sql: `DELETE FROM insights WHERE type IN (?, ?)`,
    args: [TEST_TYPE, TEST_TYPE_ALT],
  });
}

async function insertFixture(row: {
  id: string; type: string; title: string; importance: number;
  relatedEntityIds?: unknown[]; relatedCourseIds?: unknown[]; createdAt: string;
}) {
  await raw.execute({
    sql: `INSERT INTO insights (id, type, title, content_md, importance,
      related_entity_ids, related_course_ids, related_fact_ids, related_section_ids,
      created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?)`,
    args: [
      row.id, row.type, row.title, 'content', row.importance,
      JSON.stringify(row.relatedEntityIds ?? []),
      JSON.stringify(row.relatedCourseIds ?? []),
      row.createdAt,
    ],
  });
}

async function rowFor(id: string) {
  const r = await raw.execute({
    sql: `SELECT dismissed_at, viewed_at FROM insights WHERE id = ?`,
    args: [id],
  });
  return r.rows[0];
}

async function fetchJson(path: string, init?: RequestInit) {
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as any };
}

async function main() {
  log('cleanup pre-test...');
  await cleanup();

  const id1 = randomUUID();
  const id2 = randomUUID();
  const id3 = randomUUID();
  const id4 = randomUUID();

  await insertFixture({
    id: id1, type: TEST_TYPE, title: 'low importance',
    importance: 0.2, relatedEntityIds: ['ent-1'],
    createdAt: '2026-05-06 10:00:00',
  });
  await insertFixture({
    id: id2, type: TEST_TYPE, title: 'high importance newest',
    importance: 0.9, relatedEntityIds: ['ent-2', 'ent-3'],
    relatedCourseIds: ['course-1'],
    createdAt: '2026-05-06 11:00:00',
  });
  await insertFixture({
    id: id3, type: TEST_TYPE, title: 'high importance older',
    importance: 0.9, createdAt: '2026-05-06 09:00:00',
  });
  await insertFixture({
    id: id4, type: TEST_TYPE_ALT, title: 'different type',
    importance: 0.5, createdAt: '2026-05-06 10:00:00',
  });
  log('inserted 4 fixture rows');

  // 1) GET default (filter by type so we don't see real prod insights)
  {
    const r = await fetchJson(`/api/insights?type=${TEST_TYPE}&limit=10`);
    expect(r.status === 200, 'GET 200');
    expect(Array.isArray(r.body.insights), 'GET response.insights is array');
    expect(r.body.total === 3, `GET total=3 (got ${r.body.total})`);
    expect(r.body.insights.length === 3, `GET returned 3 (got ${r.body.insights.length})`);
    const ids = r.body.insights.map((i: any) => i.id);
    expect(ids[0] === id2 && ids[1] === id3 && ids[2] === id1,
      `order: importance DESC then created_at DESC: got [${ids.join(',')}]`);
    expect(Array.isArray(r.body.insights[0].relatedEntityIds),
      'relatedEntityIds parsed to array');
    expect(r.body.insights[0].relatedEntityIds.length === 2,
      `relatedEntityIds length 2 (got ${r.body.insights[0].relatedEntityIds.length})`);
    expect(Array.isArray(r.body.insights[0].relatedCourseIds),
      'relatedCourseIds parsed to array');
  }

  // 2) GET with ?type=alt filter
  {
    const r = await fetchJson(`/api/insights?type=${TEST_TYPE_ALT}`);
    expect(r.body.total === 1, `type=alt total=1 (got ${r.body.total})`);
    expect(r.body.insights[0]?.id === id4, 'type=alt returned id4');
  }

  // 3) POST /:id/dismiss
  {
    const r = await fetchJson(`/api/insights/${id3}/dismiss`, { method: 'POST' });
    expect(r.status === 200, `dismiss 200 (got ${r.status})`);
    expect(r.body.ok === true, 'dismiss ok=true');
    expect(typeof r.body.dismissedAt === 'string', 'dismiss returns dismissedAt');
    const row = await rowFor(id3);
    expect(row?.dismissed_at != null, 'dismissed_at persisted in DB');
  }

  // 4) GET (default) excludes dismissed
  {
    const r = await fetchJson(`/api/insights?type=${TEST_TYPE}`);
    expect(r.body.total === 2, `after dismiss total=2 (got ${r.body.total})`);
    const ids = r.body.insights.map((i: any) => i.id);
    expect(!ids.includes(id3), 'dismissed id3 excluded by default');
  }

  // 5) GET include_dismissed=true brings it back
  {
    const r = await fetchJson(`/api/insights?type=${TEST_TYPE}&include_dismissed=true`);
    expect(r.body.total === 3, `include_dismissed total=3 (got ${r.body.total})`);
  }

  // 6) POST /:id/viewed sets viewed_at; idempotent on 2nd call
  {
    const r = await fetchJson(`/api/insights/${id1}/viewed`, { method: 'POST' });
    expect(r.status === 200, `viewed 200 (got ${r.status})`);
    expect(typeof r.body.viewedAt === 'string', 'viewed returns viewedAt');
    const firstViewedAt = r.body.viewedAt as string;

    await new Promise((res) => setTimeout(res, 20));
    const r2 = await fetchJson(`/api/insights/${id1}/viewed`, { method: 'POST' });
    expect(r2.body.viewedAt === firstViewedAt,
      `idempotent: ${firstViewedAt} == ${r2.body.viewedAt}`);
    const row = await rowFor(id1);
    expect(row?.viewed_at === firstViewedAt, 'viewed_at unchanged in DB after 2nd call');
  }

  // 7) 404s
  {
    const r1 = await fetchJson(`/api/insights/nonexistent-id-xxx/dismiss`, { method: 'POST' });
    expect(r1.status === 404, `dismiss missing id => 404 (got ${r1.status})`);
    const r2 = await fetchJson(`/api/insights/nonexistent-id-xxx/viewed`, { method: 'POST' });
    expect(r2.status === 404, `viewed missing id => 404 (got ${r2.status})`);
  }

  // 8) include_viewed=false hides id1
  {
    const r = await fetchJson(`/api/insights?type=${TEST_TYPE}&include_viewed=false`);
    const ids = r.body.insights.map((i: any) => i.id);
    expect(!ids.includes(id1), 'include_viewed=false excludes viewed id1');
  }

  // 9) limit/offset
  {
    const r = await fetchJson(`/api/insights?type=${TEST_TYPE}&limit=1&offset=1`);
    expect(r.body.limit === 1 && r.body.offset === 1, 'limit/offset echoed');
    expect(r.body.insights.length === 1, `pagination: 1 row (got ${r.body.insights.length})`);
  }

  // 10) limit cap at 100
  {
    const r = await fetchJson(`/api/insights?type=${TEST_TYPE}&limit=99999`);
    expect(r.body.limit === 100, `limit capped to 100 (got ${r.body.limit})`);
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
