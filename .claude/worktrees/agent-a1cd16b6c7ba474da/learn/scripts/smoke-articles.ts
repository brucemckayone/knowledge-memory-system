/**
 * Smoke test for /api/articles routes.
 * Inserts test rows tagged type='__test_articles_synth__' / '__test_articles_xc__',
 * exercises both routes via app.fetch(), cleans up at start AND end, prints
 * pass/fail with exit code.
 *
 * Uses raw libsql for setup/teardown (independent of any future Drizzle-schema
 * vs live-DB column drift). VITEST=1 prevents the server from binding a port —
 * must be set BEFORE invoking this script (ESM imports hoist above any
 * top-of-file assignment, so we cannot set it inline).
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { app } from '../src/index.js';
import { config } from '../src/config.js';
import { persistArticle } from '../src/services/article-store.js';

const raw = createClient({ url: 'file:' + config.DB_PATH });

const TEST_TYPE_SYNTH = '__test_articles_synth__';
const TEST_TYPE_XC = '__test_articles_xc__';

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
    sql: `DELETE FROM articles WHERE type IN (?, ?)`,
    args: [TEST_TYPE_SYNTH, TEST_TYPE_XC],
  });
}

async function insertFixture(row: {
  id: string; type: string; title: string;
  relatedEntityIds?: unknown[]; relatedCourseIds?: unknown[];
  generatedAt: string;
}) {
  await raw.execute({
    sql: `INSERT INTO articles (id, type, title, content_md,
      related_entity_ids, related_course_ids, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id, row.type, row.title, '# Body\n\nBody text for ' + row.title,
      JSON.stringify(row.relatedEntityIds ?? []),
      JSON.stringify(row.relatedCourseIds ?? []),
      row.generatedAt,
    ],
  });
}

async function rowFor(id: string) {
  const r = await raw.execute({
    sql: `SELECT viewed_at FROM articles WHERE id = ?`,
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

  await insertFixture({
    id: id1, type: TEST_TYPE_SYNTH, title: 'oldest synthesis',
    relatedEntityIds: ['ent-1'],
    generatedAt: '2026-05-06 09:00:00',
  });
  await insertFixture({
    id: id2, type: TEST_TYPE_SYNTH, title: 'newest synthesis',
    relatedEntityIds: ['ent-2', 'ent-3'],
    relatedCourseIds: ['course-1'],
    generatedAt: '2026-05-06 11:00:00',
  });
  await insertFixture({
    id: id3, type: TEST_TYPE_XC, title: 'cross-course summary',
    relatedCourseIds: ['course-1', 'course-2'],
    generatedAt: '2026-05-06 10:00:00',
  });
  log('inserted 3 fixture rows');

  // 1) GET filter by synth type
  {
    const r = await fetchJson(`/api/articles?type=${TEST_TYPE_SYNTH}&limit=10`);
    expect(r.status === 200, `GET 200 (got ${r.status})`);
    expect(Array.isArray(r.body.articles), 'GET articles is array');
    expect(r.body.total === 2, `GET synth total=2 (got ${r.body.total})`);
    expect(r.body.articles.length === 2, `GET synth count=2 (got ${r.body.articles.length})`);
    const ids = r.body.articles.map((a: any) => a.id);
    expect(ids[0] === id2 && ids[1] === id1,
      `order: generated_at DESC: got [${ids.join(',')}]`);
    expect(Array.isArray(r.body.articles[0].relatedEntityIds), 'relatedEntityIds parsed to array');
    expect(r.body.articles[0].relatedEntityIds.length === 2,
      `relatedEntityIds length 2 (got ${r.body.articles[0].relatedEntityIds.length})`);
    expect(Array.isArray(r.body.articles[0].relatedCourseIds), 'relatedCourseIds parsed to array');
  }

  // 2) GET with cross-course filter
  {
    const r = await fetchJson(`/api/articles?type=${TEST_TYPE_XC}`);
    expect(r.body.total === 1, `xc total=1 (got ${r.body.total})`);
    expect(r.body.articles[0]?.id === id3, 'xc returned id3');
    expect(r.body.articles[0]?.relatedCourseIds.length === 2,
      `xc relatedCourseIds length 2 (got ${r.body.articles[0]?.relatedCourseIds.length})`);
  }

  // 3) GET no filter — all 3 of our fixture rows present (real prod rows may also exist)
  {
    const r = await fetchJson(`/api/articles?limit=100`);
    const ids = r.body.articles.map((a: any) => a.id);
    expect(ids.includes(id1) && ids.includes(id2) && ids.includes(id3),
      'GET no-filter includes all 3 fixture rows');
  }

  // 4) limit/offset
  {
    const r = await fetchJson(`/api/articles?type=${TEST_TYPE_SYNTH}&limit=1&offset=1`);
    expect(r.body.limit === 1 && r.body.offset === 1, 'limit/offset echoed');
    expect(r.body.articles.length === 1, `pagination 1 row (got ${r.body.articles.length})`);
    expect(r.body.articles[0].id === id1, 'offset=1 of synth desc gives id1 (older)');
  }

  // 5) limit cap at 100
  {
    const r = await fetchJson(`/api/articles?type=${TEST_TYPE_SYNTH}&limit=99999`);
    expect(r.body.limit === 100, `limit capped to 100 (got ${r.body.limit})`);
  }

  // 6) GET /:id — sets viewed_at; idempotent on 2nd call
  {
    const r = await fetchJson(`/api/articles/${id1}`);
    expect(r.status === 200, `GET id1 200 (got ${r.status})`);
    expect(r.body.id === id1, 'GET id1 returns matching id');
    expect(typeof r.body.viewedAt === 'string', 'GET id1 sets viewedAt');
    expect(Array.isArray(r.body.relatedEntityIds), 'GET id1 relatedEntityIds is array');
    const firstViewedAt = r.body.viewedAt as string;

    await new Promise((res) => setTimeout(res, 20));
    const r2 = await fetchJson(`/api/articles/${id1}`);
    expect(r2.body.viewedAt === firstViewedAt,
      `idempotent: ${firstViewedAt} == ${r2.body.viewedAt}`);
    const row = await rowFor(id1);
    expect(row?.viewed_at === firstViewedAt, 'viewed_at unchanged in DB after 2nd call');
  }

  // 7) 404 on bogus id
  {
    const r = await fetchJson(`/api/articles/nonexistent-id-xxx`);
    expect(r.status === 404, `bogus id => 404 (got ${r.status})`);
  }

  // 8) persistArticle helper inserts and is fetchable
  {
    const result = await persistArticle({
      type: TEST_TYPE_SYNTH as any,
      title: 'helper-inserted',
      contentMd: '# Hello\n\nBody from persistArticle helper.',
      relatedEntityIds: ['e-helper-1', 'e-helper-2'],
      relatedCourseIds: ['c-helper-1'],
    });
    expect(typeof result.id === 'string' && result.id.length > 0,
      `persistArticle returned id (got ${JSON.stringify(result.id)})`);

    const r = await fetchJson(`/api/articles/${result.id}`);
    expect(r.status === 200, `helper-row GET 200 (got ${r.status})`);
    expect(r.body.title === 'helper-inserted', 'helper row title round-tripped');
    expect(r.body.relatedEntityIds.length === 2, 'helper relatedEntityIds round-tripped');
    expect(r.body.relatedCourseIds.length === 1, 'helper relatedCourseIds round-tripped');
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
