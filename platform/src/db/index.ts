import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { config } from '../config.js';

// Create postgres connection
// search_path: public first so unqualified table names (facts, entities)
// resolve to public.* not ag_catalog.* (AGE migration creates shadow tables).
// ag_catalog still included for cypher() and AGE triggers.
const client = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    search_path: 'public, ag_catalog, "$user"',
  },
});

// Create drizzle instance with schema
export const db = drizzle(client, { schema });

/**
 * Drizzle transaction handle. Mutating service primitives (expireFact,
 * invalidateFact, expireCausalEdge, reviseCausalEdge) accept an optional
 * `tx` of this type so a multi-step caller can wrap them in a single
 * outer transaction — primary use case: resolveContradiction needs to
 * SELECT FOR UPDATE on the contradiction row and dispatch side-effect
 * writes atomically. When `tx` is omitted, the primitive opens its
 * own transaction internally (existing behaviour).
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Export schema for convenience
export * from './schema.js';

// Health check
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
