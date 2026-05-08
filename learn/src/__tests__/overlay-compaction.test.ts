/**
 * Pure unit tests for the overlay compaction planner (nmemo-15o).
 * No DB; planOverlayCompactionForPair is a pure function over row metadata.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planOverlayCompactionForPair,
  OVERLAY_KEEP_RECENT,
  OVERLAY_KEEP_WEEKS,
} from '../services/lesson-overlay.js';

const day = 24 * 60 * 60 * 1000;

function row(id: string, version: number, isoCreatedAt: string) {
  return { id, version, createdAt: isoCreatedAt };
}

function isoMinusDays(base: Date, n: number): string {
  return new Date(base.getTime() - n * day).toISOString();
}

test('compaction: under recent-keep threshold deletes nothing', () => {
  const base = new Date('2026-05-08T00:00:00Z');
  const rows = [
    row('a', 1, isoMinusDays(base, 4)),
    row('b', 2, isoMinusDays(base, 3)),
    row('c', 3, isoMinusDays(base, 2)),
  ];
  const { keepIds, deleteIds } = planOverlayCompactionForPair(rows);
  assert.equal(deleteIds.length, 0);
  assert.equal(keepIds.size, 3);
});

test('compaction: keeps newest N rolling versions, drops the rest beyond weekly window', () => {
  // 12 rows on consecutive days within the SAME ISO week → only the newest
  // OVERLAY_KEEP_RECENT survive (no older weeks to bucket).
  const base = new Date('2026-05-08T00:00:00Z'); // Friday
  const rows: Array<ReturnType<typeof row>> = [];
  for (let i = 0; i < 12; i++) {
    // All inside one week relative to base by stepping hours, not days.
    const ts = new Date(base.getTime() - i * 60 * 60 * 1000).toISOString();
    rows.push(row(`r${i}`, 12 - i, ts));
  }
  const { keepIds, deleteIds } = planOverlayCompactionForPair(rows);
  assert.equal(keepIds.size, OVERLAY_KEEP_RECENT);
  assert.equal(deleteIds.length, 12 - OVERLAY_KEEP_RECENT);
  // The newest rolling versions must be preserved (versions 12..8).
  for (let v = 12; v > 12 - OVERLAY_KEEP_RECENT; v--) {
    const id = rows.find(r => r.version === v)!.id;
    assert.ok(keepIds.has(id), `version ${v} should be kept`);
  }
});

test('compaction: across many weeks, recent N + N weekly survivors are kept', () => {
  // 10 rows, each one week apart, monotonically increasing version.
  const base = new Date('2026-05-08T00:00:00Z');
  const rows: Array<ReturnType<typeof row>> = [];
  for (let i = 0; i < 10; i++) {
    rows.push(row(`r${i}`, 10 - i, isoMinusDays(base, i * 7)));
  }
  const { keepIds, deleteIds } = planOverlayCompactionForPair(rows);
  // KEEP = newest OVERLAY_KEEP_RECENT + up to OVERLAY_KEEP_WEEKS distinct weekly rows
  // among the older tail. Since every row is in a unique week, total kept =
  // OVERLAY_KEEP_RECENT + OVERLAY_KEEP_WEEKS (capped at row count).
  const expectedKeep = Math.min(rows.length, OVERLAY_KEEP_RECENT + OVERLAY_KEEP_WEEKS);
  assert.equal(keepIds.size, expectedKeep);
  assert.equal(deleteIds.length, rows.length - expectedKeep);
});

test('compaction: empty input is a no-op', () => {
  const { keepIds, deleteIds } = planOverlayCompactionForPair([]);
  assert.equal(keepIds.size, 0);
  assert.equal(deleteIds.length, 0);
});

test('compaction: deletion preserves newest version IDs (oldest dies first)', () => {
  // Five rows in same week → keep newest 5; if 6th added, version 1 must die.
  const base = new Date('2026-05-08T00:00:00Z');
  const rows = [
    row('v1', 1, new Date(base.getTime() - 5 * 60 * 60 * 1000).toISOString()),
    row('v2', 2, new Date(base.getTime() - 4 * 60 * 60 * 1000).toISOString()),
    row('v3', 3, new Date(base.getTime() - 3 * 60 * 60 * 1000).toISOString()),
    row('v4', 4, new Date(base.getTime() - 2 * 60 * 60 * 1000).toISOString()),
    row('v5', 5, new Date(base.getTime() - 1 * 60 * 60 * 1000).toISOString()),
    row('v6', 6, base.toISOString()),
  ];
  const { keepIds, deleteIds } = planOverlayCompactionForPair(rows);
  assert.equal(deleteIds.length, 1);
  assert.equal(deleteIds[0], 'v1', 'oldest version must be the one deleted');
  assert.ok(keepIds.has('v6'), 'newest version must survive');
});
