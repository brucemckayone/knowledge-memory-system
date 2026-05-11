/**
 * Phase-5 minimal assertion runner.
 *
 * Consumes the `*.expected.json` schema introduced for `phase5-contradictions/`
 * and dispatches the four assertion types currently in use:
 *
 *   - `row_count`              count(*) under a filter equals N
 *   - `column_values`          row matching filter has expected/in/not_null
 *                              values across one or more columns
 *   - `duplicate_rejection`    re-running a service call leaves the row count
 *                              unchanged (idempotent detection)
 *   - `side_effect_assertion`  every row matching a filter has the expected
 *                              value (or all-null) for a specific column
 *
 * Later phases extend this with new assertion types as fixtures introduce them.
 * The runner intentionally exposes per-assertion helpers (rather than a "run
 * the whole scenario" entry point) so test code stays in control of when each
 * service is invoked — the scenarios mix detection and resolution stages,
 * and resolution stages reference IDs from earlier stages.
 *
 * The dispatch is keyed by `assertion.type` so adding new types is purely
 * additive.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'vitest';
import type postgres from 'postgres';

// ============================================
// Types
// ============================================

/** Filter values: literals match `=`, `null` matches `IS NULL`. */
export type FilterValue = string | number | boolean | null;
export type Filter = Record<string, FilterValue | { in: FilterValue[] }>;

export interface RowCountAssertion {
  type: 'row_count';
  table: string;
  filter: Filter;
  expected: number;
  because?: string;
}

export interface ColumnValueClause {
  column: string;
  expected?: FilterValue;
  in?: FilterValue[];
  not_null?: boolean;
}

export interface ColumnValuesAssertion {
  type: 'column_values';
  table: string;
  filter: Filter;
  assertions: ColumnValueClause[];
}

export interface DuplicateRejectionAssertion {
  type: 'duplicate_rejection';
  assertion: 'row_count_stable_across_runs';
  table?: string;
  filter?: Filter;
  description?: string;
}

export interface SideEffectAssertion {
  type: 'side_effect_assertion';
  table: string;
  filter: Record<string, FilterValue | { in: FilterValue[] }>;
  column: string;
  /** `'all_null'` means every matching row's column IS NULL; `'all_not_null'`
   *  means every matching row's column IS NOT NULL; anything else is compared
   *  via `=` against every matching row. */
  expected: 'all_null' | 'all_not_null' | FilterValue;
  description?: string;
}

export type Assertion =
  | RowCountAssertion
  | ColumnValuesAssertion
  | DuplicateRejectionAssertion
  | SideEffectAssertion;

export interface ExpectedScenario {
  scenario: string;
  description?: string;
  data_set_level?: number;
  fixture?: string;
  phases_exercised?: string[];
  stages: ExpectedStage[];
  benchmark_targets?: Record<string, unknown>;
  graduation_notes?: string;
}

export interface ExpectedStage {
  stage: string;
  driver: 'service_call' | 'manual';
  service_call?: string;
  args?: Record<string, unknown>;
  assertions: Assertion[];
}

export interface AssertionContext {
  /** Required when running a `duplicate_rejection` assertion — the runner
   *  invokes this to re-execute the stage's detection step. */
  rerun?: () => Promise<unknown>;
}

// ============================================
// Loader
// ============================================

/**
 * Read an `*.expected.json` file under `src/test/data/`. The path is given
 * relative to that directory (e.g. `phase5-contradictions/expected/foo.json`).
 */
export function loadExpected(relativePath: string): ExpectedScenario {
  const absolute = join(__dirname, '..', 'data', relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`Expected file not found: ${relativePath} (resolved to ${absolute})`);
  }
  const raw = readFileSync(absolute, 'utf-8');
  return JSON.parse(raw) as ExpectedScenario;
}

// ============================================
// SQL helpers
// ============================================

/** Render a filter as a parameterised WHERE clause + values. Each entry maps
 *  to `col = $N` (literals, including `null` short-circuited to `IS NULL`) or
 *  `col = ANY($N::uuid[])` for `{in: [...]}` clauses. */
function buildWhere(filter: Filter | undefined): { sql: string; values: FilterValue[] } {
  if (!filter || Object.keys(filter).length === 0) {
    return { sql: '', values: [] };
  }
  const fragments: string[] = [];
  const values: FilterValue[] = [];
  for (const [col, value] of Object.entries(filter)) {
    if (value === null) {
      fragments.push(`${col} IS NULL`);
    } else if (typeof value === 'object' && value !== null && 'in' in value) {
      const placeholders: string[] = [];
      for (const v of value.in) {
        values.push(v);
        placeholders.push(`$${values.length}`);
      }
      fragments.push(`${col} IN (${placeholders.join(', ')})`);
    } else {
      values.push(value as FilterValue);
      fragments.push(`${col} = $${values.length}`);
    }
  }
  return { sql: `WHERE ${fragments.join(' AND ')}`, values };
}

async function selectRows(
  testDb: postgres.Sql,
  table: string,
  filter: Filter,
): Promise<Record<string, unknown>[]> {
  const { sql, values } = buildWhere(filter);
  const queryText = `SELECT * FROM ${table} ${sql}`;
  const result = await testDb.unsafe(queryText, values as unknown[]);
  return [...result];
}

async function countRows(
  testDb: postgres.Sql,
  table: string,
  filter: Filter,
): Promise<number> {
  const { sql, values } = buildWhere(filter);
  const queryText = `SELECT count(*)::int AS c FROM ${table} ${sql}`;
  const result = await testDb.unsafe(queryText, values as unknown[]);
  return Number((result as unknown as Array<{ c: number }>)[0]?.c ?? 0);
}

// ============================================
// Per-assertion handlers
// ============================================

async function runRowCount(testDb: postgres.Sql, a: RowCountAssertion): Promise<void> {
  const actual = await countRows(testDb, a.table, a.filter);
  expect(actual, a.because ?? `row_count(${a.table})`).toBe(a.expected);
}

async function runColumnValues(testDb: postgres.Sql, a: ColumnValuesAssertion): Promise<void> {
  const rows = await selectRows(testDb, a.table, a.filter);
  expect(rows.length, `column_values(${a.table}) — expected exactly one matching row`).toBe(1);
  const row = rows[0]!;
  for (const clause of a.assertions) {
    const actual = row[clause.column];
    if (clause.not_null) {
      expect(actual, `column_values(${a.table}.${clause.column}) — not_null`).not.toBeNull();
    } else if (clause.in !== undefined) {
      expect(clause.in, `column_values(${a.table}.${clause.column}) — in [${clause.in.join(', ')}]`).toContain(actual);
    } else if (clause.expected !== undefined) {
      expect(actual, `column_values(${a.table}.${clause.column})`).toBe(clause.expected);
    }
  }
}

async function runDuplicateRejection(
  testDb: postgres.Sql,
  a: DuplicateRejectionAssertion,
  ctx: AssertionContext,
): Promise<void> {
  if (!ctx.rerun) {
    throw new Error('duplicate_rejection requires a rerun() callback in the assertion context');
  }
  const table = a.table ?? 'contradictions';
  const before = await countRows(testDb, table, a.filter ?? {});
  await ctx.rerun();
  const after = await countRows(testDb, table, a.filter ?? {});
  expect(after, a.description ?? `duplicate_rejection(${table})`).toBe(before);
}

async function runSideEffect(testDb: postgres.Sql, a: SideEffectAssertion): Promise<void> {
  const rows = await selectRows(testDb, a.table, a.filter as Filter);
  expect(rows.length, `side_effect_assertion(${a.table}) — at least one matching row required`).toBeGreaterThan(0);
  for (const row of rows) {
    const value = row[a.column];
    if (a.expected === 'all_null') {
      expect(value, a.description ?? `side_effect_assertion(${a.table}.${a.column}) — IS NULL`).toBeNull();
    } else if (a.expected === 'all_not_null') {
      expect(value, a.description ?? `side_effect_assertion(${a.table}.${a.column}) — IS NOT NULL`).not.toBeNull();
    } else {
      expect(value, a.description ?? `side_effect_assertion(${a.table}.${a.column})`).toBe(a.expected);
    }
  }
}

// ============================================
// Public dispatch
// ============================================

export async function runAssertion(
  testDb: postgres.Sql,
  assertion: Assertion,
  ctx: AssertionContext = {},
): Promise<void> {
  switch (assertion.type) {
    case 'row_count':
      return runRowCount(testDb, assertion);
    case 'column_values':
      return runColumnValues(testDb, assertion);
    case 'duplicate_rejection':
      return runDuplicateRejection(testDb, assertion, ctx);
    case 'side_effect_assertion':
      return runSideEffect(testDb, assertion);
    default: {
      const _exhaustive: never = assertion;
      throw new Error(`Unsupported assertion type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
