/**
 * Entity-summary feature — end-to-end integration test (bead nmemo-2yv.56).
 *
 * Exercises the full surface of the agent-authored living summary feature:
 *
 *   1. Fixture load. baseline.sql seeds one entity + one entity_meta row with
 *      a healthy ~500-char summary and summary_updated_at 1 day ago.
 *   2. Write path. handleToolCall('update_entity_summary', ...) overwrites the
 *      seeded summary with a new one — exercises causal-agent.ts:1679 (the
 *      .53 write-side cap + sanitise) and the .52 timestamp write.
 *   3. Read path (bead .51). getEntityProfile is the canonical read assembler;
 *      it joins entity_meta and surfaces profile.summary + profile.summaryUpdatedAt.
 *      GET /api/entity/:id/profile is the HTTP entry point that wraps the
 *      assembler for external consumers (MCP, bot, future panels).
 *   4. Viz path. /api/viz/unified emits entity nodes with .summary — this
 *      test asserts the freshly-written summary surfaces on the unified
 *      payload so the .52 detail panel reads the same value the agent wrote.
 *
 * Fixture markers: every row carries [bead-56-fixture] in its canonical_name
 * or summary so the cleanup sweep at end-of-suite scopes to this file and
 * does not race other concurrent suites touching entity_meta.
 *
 * Pattern mirror: src/test/harness/reasoning-agent-surface.test.ts
 * (bead .79) — same loadFixture + cleanFixtureRows convention.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, loadFixture } from '../setup.js';
import { getEntityProfile } from '../../services/entity-profile.js';
import { handleToolCall } from '../../services/causal-agent.js';
import { app } from '../../index.js';

const BASELINE_ENTITY_ID = '56000000-0000-0000-0001-000000000001';
const FIXTURE_MARKER = '[bead-56-fixture]';

// All entity ids the .56 fixture set may have planted, across baseline +
// follow-up scenarios run inside this suite. Scoped sweep — does not touch
// rows planted by other suites.
const ALL_FIXTURE_ENTITY_IDS = [
  '56000000-0000-0000-0001-000000000001', // baseline
  '56000000-0000-0000-0002-000000000001', // null-summary
  '56000000-0000-0000-0003-000000000001', // oversize-summary
  '56000000-0000-0000-0004-000000000001', // injection-attempt
  '56000000-0000-0000-0005-000000000001', // stale-summary
  '56000000-0000-0000-0006-000000000001', // multi-entity-cluster: Alex
  '56000000-0000-0000-0006-000000000002', // multi-entity-cluster: Maya
  '56000000-0000-0000-0006-000000000003', // multi-entity-cluster: Sam
  '56000000-0000-0000-0006-000000000004', // multi-entity-cluster: Riya
  '56000000-0000-0000-0006-000000000005', // multi-entity-cluster: Orion
];

async function cleanFixtureRows(): Promise<void> {
  // Facts first (FK to entities). The fixture facts use the cluster prefix
  // 56000000-1000-… so a marker-based DELETE on the source memory or
  // reasoning column isn't viable; sweep by the id prefix.
  await testDb`
    DELETE FROM public.facts
    WHERE id::text LIKE '56000000-1000-0000-0006-%'
  `.catch(() => {});
  await testDb`
    DELETE FROM public.entity_meta
    WHERE entity_id::text = ANY(${ALL_FIXTURE_ENTITY_IDS})
  `.catch(() => {});
  await testDb`
    DELETE FROM public.entities
    WHERE id::text = ANY(${ALL_FIXTURE_ENTITY_IDS})
  `.catch(() => {});
  // Any stray summary updates the test itself made on non-fixture rows
  // (defensive — shouldn't happen if tests stay scoped).
  await testDb`
    DELETE FROM public.entity_meta
    WHERE summary LIKE ${`${FIXTURE_MARKER}%`}
  `.catch(() => {});
}

describe('Entity-summary feature — end-to-end (bead nmemo-2yv.56)', () => {
  beforeAll(async () => {
    await cleanFixtureRows();
    await loadFixture('entity-summary/fixtures/baseline.sql');
  });

  afterAll(async () => {
    await cleanFixtureRows();
  });

  it('loadFixture seeds baseline entity + entity_meta with summary + summary_updated_at', async () => {
    const rows = await testDb<{ summary: string; summaryUpdatedAt: Date }[]>`
      SELECT summary, summary_updated_at AS "summaryUpdatedAt"
      FROM public.entity_meta
      WHERE entity_id = ${BASELINE_ENTITY_ID}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toMatch(/Baseline Person/);
    expect(rows[0]!.summaryUpdatedAt).toBeInstanceOf(Date);
    // Roughly 1 day old (allow wide window — the fixture inserts with NOW()
    // - INTERVAL '1 day' and tests may run minutes later).
    const ageMs = Date.now() - rows[0]!.summaryUpdatedAt.getTime();
    expect(ageMs).toBeGreaterThan(23 * 3600 * 1000); // > 23h
    expect(ageMs).toBeLessThan(25 * 3600 * 1000); // < 25h
  });

  it('update_entity_summary overwrites the seeded summary and bumps summary_updated_at', async () => {
    // Capture the pre-write timestamp so we can assert it moved forward.
    const before = await testDb<{ summary: string; summaryUpdatedAt: Date }[]>`
      SELECT summary, summary_updated_at AS "summaryUpdatedAt"
      FROM public.entity_meta
      WHERE entity_id = ${BASELINE_ENTITY_ID}::uuid
    `;
    const preTimestamp = before[0]!.summaryUpdatedAt.getTime();
    const preSummary = before[0]!.summary;

    const newSummary =
      `${FIXTURE_MARKER} Baseline Person — rewritten by .56 e2e. ` +
      'Now described as the recently-promoted lead. Aliases unchanged.';

    const result = await handleToolCall('update_entity_summary', {
      entity_id: BASELINE_ENTITY_ID,
      summary: newSummary,
    });
    // The handler's success contract is `{ updated: true }` JSON.
    expect(JSON.parse(result)).toEqual({ updated: true });

    const after = await testDb<{ summary: string; summaryUpdatedAt: Date; updatedAt: Date }[]>`
      SELECT summary,
             summary_updated_at AS "summaryUpdatedAt",
             updated_at AS "updatedAt"
      FROM public.entity_meta
      WHERE entity_id = ${BASELINE_ENTITY_ID}::uuid
    `;
    expect(after).toHaveLength(1);
    expect(after[0]!.summary).toBe(newSummary);
    expect(after[0]!.summary).not.toBe(preSummary);
    // Both timestamps advanced past the pre-write moment.
    expect(after[0]!.summaryUpdatedAt.getTime()).toBeGreaterThan(preTimestamp);
    expect(after[0]!.updatedAt.getTime()).toBeGreaterThan(preTimestamp);
  });

  // Graduated by bead .51: getEntityProfile now joins entity_meta and surfaces
  // summary + summaryUpdatedAt on the assembled EntityProfile shape. Previously
  // (pre-.51) this test only verified the entity slice; the agent-authored
  // summary was only readable by querying entity_meta directly. Post-.51 the
  // assembler is the canonical read path.
  it('getEntityProfile returns the baseline entity with agent-authored summary (post-.51)', async () => {
    const profile = await getEntityProfile(BASELINE_ENTITY_ID);
    expect(profile).not.toBeNull();
    expect(profile!.entity.id).toBe(BASELINE_ENTITY_ID);
    expect(profile!.entity.canonicalName).toContain('Baseline Person');
    expect(profile!.summary).toMatch(/rewritten by \.56 e2e/);
    expect(profile!.summaryUpdatedAt).toBeInstanceOf(Date);
  });

  // bead .51 — GET /api/entity/:id/profile is the canonical read endpoint for
  // external consumers (MCP, bot, future panels). Mirrors the assembler shape
  // over HTTP; timestamps land as ISO strings.
  it('GET /api/entity/:id/profile returns the same payload over HTTP (bead .51)', async () => {
    const res = await app.request(`/api/entity/${BASELINE_ENTITY_ID}/profile`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      entity: { id: string; canonicalName: string };
      summary: string | null;
      summaryUpdatedAt: string | null;
      facts: unknown[];
      relatedEntities: unknown[];
      recentMemories: unknown[];
    };
    expect(body.entity.id).toBe(BASELINE_ENTITY_ID);
    expect(body.entity.canonicalName).toContain('Baseline Person');
    expect(body.summary).toMatch(/rewritten by \.56 e2e/);
    expect(typeof body.summaryUpdatedAt).toBe('string');
    expect(new Date(body.summaryUpdatedAt as string).getTime()).toBeGreaterThan(0);
  });

  // bead .51 — 404 on unknown entity. Distinguishes "no entity" from
  // "entity exists but has no summary yet" (the latter returns 200 with
  // summary:null per the assembler contract).
  it('GET /api/entity/:id/profile returns 404 for an unknown entity id (bead .51)', async () => {
    const res = await app.request('/api/entity/00000000-0000-0000-0000-000000000000/profile');
    expect(res.status).toBe(404);
  });

  // /api/viz/unified emits entity nodes with .summary and .summaryUpdatedAt
  // (bead .52). The freshly-written summary from the previous test should
  // surface on the unified payload — same row, same column, served by the
  // viz endpoint instead of the assembler.
  //
  // Payload shape: { nodes: [{ id, _nodeType: 'entity'|'event'|..., summary,
  // summaryUpdatedAt, ... }], links: [...] }. Entity nodes carry the summary
  // fields; non-entity nodes don't.
  it('/api/viz/unified surfaces the freshly-written summary on the entity node', async () => {
    const res = await app.request('/api/viz/unified');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      nodes: Array<{
        id: string;
        _nodeType: string;
        summary?: string | null;
        summaryUpdatedAt?: string | null;
      }>;
    };

    const baselineNode = body.nodes.find(
      (n) => n._nodeType === 'entity' && n.id === BASELINE_ENTITY_ID,
    );
    expect(baselineNode).toBeDefined();
    expect(baselineNode!.summary).toMatch(/rewritten by \.56 e2e/);
    // Timestamp is serialised as ISO string over HTTP.
    expect(typeof baselineNode!.summaryUpdatedAt).toBe('string');
    expect(new Date(baselineNode!.summaryUpdatedAt as string).getTime()).toBeGreaterThan(0);
  });

  // Smoke-test: every fixture in the .56 set loads cleanly. The five
  // follow-up scenarios (null-summary, oversize-summary, injection-attempt,
  // stale-summary, multi-entity-cluster) aren't read-asserted by tests today
  // — they exist for the test-harden skill to evolve against. This test
  // catches a fixture-syntax regression early without dragging the
  // assertion surface into "every fixture must have a downstream test".
  //
  // Idempotency: every fixture uses ON CONFLICT DO UPDATE / DO NOTHING, so
  // re-loading after the baseline + write tests above is safe.
  it('all six entity-summary fixtures load without SQL errors', async () => {
    const fixtures = [
      'entity-summary/fixtures/baseline.sql',
      'entity-summary/fixtures/null-summary.sql',
      'entity-summary/fixtures/oversize-summary.sql',
      'entity-summary/fixtures/injection-attempt.sql',
      'entity-summary/fixtures/stale-summary.sql',
      'entity-summary/fixtures/multi-entity-cluster.sql',
    ];
    for (const f of fixtures) {
      const { durationMs } = await loadFixture(f);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    }

    // Verify each fixture's anchor entity_meta row is present with the
    // expected summary-shape signal.
    const rows = await testDb<{
      entityId: string;
      summary: string | null;
      summaryUpdatedAt: Date | null;
    }[]>`
      SELECT entity_id AS "entityId",
             summary,
             summary_updated_at AS "summaryUpdatedAt"
      FROM public.entity_meta
      WHERE entity_id::text = ANY(${ALL_FIXTURE_ENTITY_IDS})
    `;
    const byId = new Map(rows.map((r) => [r.entityId, r]));

    // null-summary: summary IS NULL, summary_updated_at IS NULL
    const nullRow = byId.get('56000000-0000-0000-0002-000000000001');
    expect(nullRow).toBeDefined();
    expect(nullRow!.summary).toBeNull();
    expect(nullRow!.summaryUpdatedAt).toBeNull();

    // oversize-summary: length = 3500 (above .53 hard cap)
    const oversizeRow = byId.get('56000000-0000-0000-0003-000000000001');
    expect(oversizeRow).toBeDefined();
    expect(oversizeRow!.summary!.length).toBe(3500);

    // injection-attempt: payload contains the canonical probe
    const injectionRow = byId.get('56000000-0000-0000-0004-000000000001');
    expect(injectionRow).toBeDefined();
    expect(injectionRow!.summary).toContain('IGNORE PRIOR INSTRUCTIONS');

    // stale-summary: summary_updated_at > 30 days old
    const staleRow = byId.get('56000000-0000-0000-0005-000000000001');
    expect(staleRow).toBeDefined();
    const staleAgeDays =
      (Date.now() - staleRow!.summaryUpdatedAt!.getTime()) / (24 * 3600 * 1000);
    expect(staleAgeDays).toBeGreaterThan(30);

    // multi-entity-cluster: 5 rows with non-null summaries
    const clusterIds = [
      '56000000-0000-0000-0006-000000000001',
      '56000000-0000-0000-0006-000000000002',
      '56000000-0000-0000-0006-000000000003',
      '56000000-0000-0000-0006-000000000004',
      '56000000-0000-0000-0006-000000000005',
    ];
    for (const id of clusterIds) {
      const row = byId.get(id);
      expect(row).toBeDefined();
      expect(row!.summary).not.toBeNull();
    }
  });
});
