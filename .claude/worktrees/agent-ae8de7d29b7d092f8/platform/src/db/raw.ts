/**
 * Raw SQL query helper with automatic snake_case → camelCase transformation.
 *
 * Drizzle query builder handles column casing automatically, but db.execute()
 * returns raw postgres.js results with snake_case keys. This utility bridges
 * the gap for queries that must use raw SQL (pgvector, Apache AGE, trigram).
 */

import { db } from './index.js';
import type { SQL } from 'drizzle-orm';

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function transformRow<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value;
  }
  return result as T;
}

/**
 * Execute raw SQL and return results with camelCase column names.
 * Use this instead of db.execute() when results are consumed as typed objects.
 */
export async function rawQuery<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  const rows = result as unknown as Record<string, unknown>[];
  return rows.map(row => transformRow<T>(row));
}
