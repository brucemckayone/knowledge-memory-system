/**
 * B5 (nmemo-6do.5): llm_usage table (migration 050) + Drizzle drift guard.
 *
 * 050_llm_usage.sql and the Drizzle `llmUsage` table are a dual source of truth
 * kept in sync BY HAND (per the AGE search_path rule — see CLAUDE.md). This test
 * introspects the live columns/indexes and asserts they match the Drizzle table,
 * so the hand-sync cannot silently rot (decoupling-review addition).
 *
 * Needs Postgres up (port 5433) with migration 050 applied (npm run db:migrate).
 */

import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { testDb } from '../setup.js';
import { llmUsage } from '../../db/schema.js';

describe('B5: llm_usage schema (migration 050) + Drizzle drift guard', () => {
  it('Drizzle llmUsage column set matches the live llm_usage table exactly', async () => {
    const drizzleCols = Object.values(getTableColumns(llmUsage))
      .map((c: any) => c.name)
      .sort();
    const live = await testDb`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'llm_usage'
    `;
    const liveCols = live.map((r: any) => r.column_name).sort();

    // Set-equality both ways: no drift in either direction.
    expect(liveCols).toEqual(drizzleCols);
    // Design §4.3 has 32 columns (incl. the optional non-content `source`).
    expect(drizzleCols.length).toBe(32);
  });

  it('NOT NULL constraints and defaults match the migration', async () => {
    const cols = await testDb`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_name = 'llm_usage'
    `;
    const by = Object.fromEntries(cols.map((c: any) => [c.column_name, c]));

    for (const c of ['operation', 'requested_model', 'resolved_model', 'provider', 'input_tokens']) {
      expect(by[c].is_nullable).toBe('NO');
    }
    expect(by['provider'].column_default).toContain('unknown');
    expect(by['cost_source'].column_default).toContain('local');
    expect(by['cost_status'].column_default).toContain('priced');
    expect(by['token_source'].column_default).toContain('provider');
    expect(by['pricing_version'].column_default).toContain('unknown');

    // Cost columns and the routing alias are nullable (auditable NULLs, not 0).
    for (const c of ['estimated_usd', 'gateway_reported_usd', 'model_group', 'reasoning_output_tokens']) {
      expect(by[c].is_nullable).toBe('YES');
    }
  });

  it('all 7 indexes exist (5 plain + 2 partial)', async () => {
    const idx = await testDb`
      SELECT indexname FROM pg_indexes WHERE tablename = 'llm_usage'
    `;
    const names = idx.map((r: any) => r.indexname);
    for (const n of [
      'idx_llm_usage_created', 'idx_llm_usage_resolved', 'idx_llm_usage_operation',
      'idx_llm_usage_provider', 'idx_llm_usage_coststatus',
      'idx_llm_usage_trace', 'idx_llm_usage_gwreq',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('Drizzle exports llmUsage bound to the llm_usage table', () => {
    expect(llmUsage).toBeDefined();
    expect((llmUsage as any)[Symbol.for('drizzle:Name')]).toBe('llm_usage');
  });
});
