/**
 * Audit Service — Phase 1 of Reasoning Layer Hardening (doc 12).
 *
 * Every mutation to a fact or causal edge MUST write exactly one audit row
 * here, in the same transaction as the mutation. If the audit write fails,
 * the mutation rolls back — never fire-and-forget.
 *
 * `actor` is required everywhere. TypeScript rejects missing values so every
 * callsite has to decide which of the seven actors is making the change.
 */

import { eq, desc, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  factHistory,
  causalEdgeHistory,
  edgeSourceRefs,
  type FactHistory,
  type CausalEdgeHistory,
} from '../db/schema.js';
import type { SeveritySummary } from './impact.js';

/**
 * Drizzle 0.29 + postgres.js 3.4 stringify jsonb array/object values when
 * passed through `.values({ … })` inside a tx callback — the row lands with
 * jsonb_typeof='string' instead of 'array'. Inline the value as a SQL string
 * literal cast to jsonb so postgres encodes it once and the backend parses
 * as JSONB natively. Safe — JSON.stringify output contains no single quotes
 * in key positions; the `.replace` guards against unlikely embedded quotes
 * in payload strings.
 */
export function jsonbLiteral(value: unknown): SQL {
  return sql.raw(`'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`);
}

/**
 * Normalise a Drizzle `client.execute(sql\`…\`)` result into a row array.
 * postgres.js returns the array directly; some adapter paths return
 * `{ rows: [...] }`. Either form lands as `T[]` here.
 */
export function unwrapRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: unknown[] })?.rows ?? []) as T[];
}

// ============================================
// Actor / event-type enums (DB CHECK mirrors)
// ============================================

export type FactEventType =
  | 'created'
  | 'confidence_raised'
  | 'confidence_lowered'
  | 'revised'
  | 'superseded'
  | 'expired'
  | 'invalidated'
  | 'restored';

export type EdgeEventType =
  | 'created'
  | 'corroborated'
  | 'strengthened'
  | 'weakened'
  | 'revised'
  | 'expired'
  | 'decayed';

export type Actor =
  | 'graph_agent'
  | 'reasoning_agent'
  | 'gardener_agent'
  | 'reconciliation_agent'
  | 'user'
  | 'system_trigger'
  | 'cascade';

export interface SourceReference {
  type: 'memory' | 'fact' | 'entity';
  id: string;
  relevance: string;
}

// ============================================
// Write helpers
// ============================================

export interface RecordFactChangeParams {
  factId: string;
  eventType: FactEventType;
  previousConfidence?: number | null;
  newConfidence?: number | null;
  previousValidAt?: Date | null;
  newValidAt?: Date | null;
  previousInvalidAt?: Date | null;
  newInvalidAt?: Date | null;
  reasoning: string;
  sourceReferences?: SourceReference[];
  reasoningReportId?: string | null;
  causalEventId?: string | null;
  actor: Actor;
  /** Optional Drizzle transaction — pass when audit must be atomic with the mutation. */
  tx?: typeof db;
  /**
   * Pre-mutation blast-radius severitySummary, captured at the policy
   * boundary by agent-initiated expire/invalidate paths. NULL for
   * cascade-internal mutations. See bead nmemo-2yv.102.
   */
  preExpireBlastRadius?: SeveritySummary | null;
}

/**
 * Insert a row into `fact_history`. Returns the new history row id.
 *
 * @throws if `reasoning` is empty / whitespace-only — the service layer guard
 *         that catches "agents didn't bother to justify" before we hit the DB.
 */
export async function recordFactChange(params: RecordFactChangeParams): Promise<string> {
  if (!params.reasoning || params.reasoning.trim().length === 0) {
    throw new Error('reasoning must be a non-empty string');
  }
  const client = params.tx ?? db;
  const preExpireBlastRadius = params.preExpireBlastRadius == null
    ? sql`NULL::jsonb`
    : jsonbLiteral(params.preExpireBlastRadius);
  // Raw-SQL INSERT so jsonb lands as array, not a stringified scalar (see
  // jsonbLiteral note above).
  const result = await client.execute(sql`
    INSERT INTO public.fact_history (
      fact_id, event_type,
      previous_confidence, new_confidence,
      previous_valid_at, new_valid_at,
      previous_invalid_at, new_invalid_at,
      reasoning, source_references,
      reasoning_report_id, causal_event_id,
      actor, pre_expire_blast_radius
    ) VALUES (
      ${params.factId}::uuid, ${params.eventType},
      ${params.previousConfidence ?? null}, ${params.newConfidence ?? null},
      ${params.previousValidAt ?? null}, ${params.newValidAt ?? null},
      ${params.previousInvalidAt ?? null}, ${params.newInvalidAt ?? null},
      ${params.reasoning}, ${jsonbLiteral(params.sourceReferences ?? [])},
      ${params.reasoningReportId ?? null}::uuid, ${params.causalEventId ?? null}::uuid,
      ${params.actor}, ${preExpireBlastRadius}
    ) RETURNING id
  `);
  const rows = unwrapRows(result);
  const id = (rows[0] as { id: string } | undefined)?.id;
  if (!id) throw new Error('recordFactChange: INSERT returned no row');
  return id;
}

export interface RecordEdgeChangeParams {
  edgeId: string;
  eventType: EdgeEventType;
  previousStrength?: number | null;
  newStrength?: number | null;
  previousReasoning?: string | null;
  newReasoning?: string | null;
  addedSourceRefs?: SourceReference[] | null;
  reasoning: string;
  reasoningReportId?: string | null;
  actor: Actor;
  /** Optional Drizzle transaction — pass when audit must be atomic with the mutation. */
  tx?: typeof db;
  /**
   * Pre-mutation blast-radius severitySummary, captured at the policy
   * boundary by agent-initiated edge expiry. NULL for cascade-internal
   * mutations. See bead nmemo-2yv.102.
   */
  preExpireBlastRadius?: SeveritySummary | null;
}

/**
 * Insert a row into `causal_edge_history`. Returns the new history row id.
 *
 * @throws if `reasoning` is empty / whitespace-only.
 */
export async function recordEdgeChange(params: RecordEdgeChangeParams): Promise<string> {
  if (!params.reasoning || params.reasoning.trim().length === 0) {
    throw new Error('reasoning must be a non-empty string');
  }
  const client = params.tx ?? db;
  const addedRefs = params.addedSourceRefs == null
    ? sql`NULL::jsonb`
    : jsonbLiteral(params.addedSourceRefs);
  const preExpireBlastRadius = params.preExpireBlastRadius == null
    ? sql`NULL::jsonb`
    : jsonbLiteral(params.preExpireBlastRadius);
  const result = await client.execute(sql`
    INSERT INTO public.causal_edge_history (
      edge_id, event_type,
      previous_strength, new_strength,
      previous_reasoning, new_reasoning,
      added_source_refs,
      reasoning, reasoning_report_id, actor,
      pre_expire_blast_radius
    ) VALUES (
      ${params.edgeId}::uuid, ${params.eventType},
      ${params.previousStrength ?? null}, ${params.newStrength ?? null},
      ${params.previousReasoning ?? null}, ${params.newReasoning ?? null},
      ${addedRefs},
      ${params.reasoning}, ${params.reasoningReportId ?? null}::uuid, ${params.actor},
      ${preExpireBlastRadius}
    ) RETURNING id
  `);
  const rows = unwrapRows(result);
  const id = (rows[0] as { id: string } | undefined)?.id;
  if (!id) throw new Error('recordEdgeChange: INSERT returned no row');
  return id;
}

/**
 * Sync `causal_edges.source_references` (JSONB authoritative format) to the
 * denormalised `edge_source_refs` reverse-lookup index. Idempotent — duplicate
 * (edge_id, ref_type, ref_id) triples are dropped via ON CONFLICT DO NOTHING.
 *
 * Call after every INSERT into `causal_edges` and after every corroboration
 * that adds new refs. The JSONB column remains the source of truth; this
 * helper keeps the index in step.
 *
 * No-op on empty input. Pass `tx` when sync must commit atomically with the
 * edge mutation that produced the refs.
 */
export async function syncEdgeSourceRefs(
  edgeId: string,
  refs: SourceReference[],
  tx?: typeof db,
): Promise<void> {
  if (!refs || refs.length === 0) return;
  const client = tx ?? db;
  await client
    .insert(edgeSourceRefs)
    .values(refs.map((r) => ({
      edgeId,
      refType: r.type,
      refId: r.id,
      relevance: r.relevance,
    })))
    .onConflictDoNothing();
}

// ============================================
// Read helpers
// ============================================

/** Structured row shape exposed to MCP tools and API handlers. */
export interface FactHistoryRow {
  id: string;
  factId: string;
  eventType: FactEventType;
  previousConfidence: number | null;
  newConfidence: number | null;
  previousValidAt: Date | null;
  newValidAt: Date | null;
  previousInvalidAt: Date | null;
  newInvalidAt: Date | null;
  reasoning: string;
  sourceReferences: SourceReference[];
  reasoningReportId: string | null;
  causalEventId: string | null;
  actor: Actor;
  occurredAt: Date;
}

export interface EdgeHistoryRow {
  id: string;
  edgeId: string;
  eventType: EdgeEventType;
  previousStrength: number | null;
  newStrength: number | null;
  previousReasoning: string | null;
  newReasoning: string | null;
  addedSourceRefs: SourceReference[] | null;
  reasoning: string;
  reasoningReportId: string | null;
  actor: Actor;
  occurredAt: Date;
}

/**
 * Return the mutation history for a fact in reverse-chronological order
 * (newest first), capped at `limit` rows (default 100, max 500).
 */
export async function getFactHistory(factId: string, limit = 100): Promise<FactHistoryRow[]> {
  const cap = clampLimit(limit);
  const rows = await db
    .select()
    .from(factHistory)
    .where(eq(factHistory.factId, factId))
    .orderBy(desc(factHistory.occurredAt))
    .limit(cap);
  return rows.map(toFactHistoryRow);
}

/**
 * Return the mutation history for a causal edge in reverse-chronological
 * order, capped at `limit` rows (default 100, max 500).
 */
export async function getEdgeHistory(edgeId: string, limit = 100): Promise<EdgeHistoryRow[]> {
  const cap = clampLimit(limit);
  const rows = await db
    .select()
    .from(causalEdgeHistory)
    .where(eq(causalEdgeHistory.edgeId, edgeId))
    .orderBy(desc(causalEdgeHistory.occurredAt))
    .limit(cap);
  return rows.map(toEdgeHistoryRow);
}

// ============================================
// Internals
// ============================================

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(Math.floor(limit), 500);
}

function toFactHistoryRow(row: FactHistory): FactHistoryRow {
  return {
    id: row.id,
    factId: row.factId,
    eventType: row.eventType as FactEventType,
    previousConfidence: row.previousConfidence ?? null,
    newConfidence: row.newConfidence ?? null,
    previousValidAt: row.previousValidAt ?? null,
    newValidAt: row.newValidAt ?? null,
    previousInvalidAt: row.previousInvalidAt ?? null,
    newInvalidAt: row.newInvalidAt ?? null,
    reasoning: row.reasoning,
    sourceReferences: (row.sourceReferences ?? []) as SourceReference[],
    reasoningReportId: row.reasoningReportId ?? null,
    causalEventId: row.causalEventId ?? null,
    actor: row.actor as Actor,
    occurredAt: row.occurredAt,
  };
}

function toEdgeHistoryRow(row: CausalEdgeHistory): EdgeHistoryRow {
  return {
    id: row.id,
    edgeId: row.edgeId,
    eventType: row.eventType as EdgeEventType,
    previousStrength: row.previousStrength ?? null,
    newStrength: row.newStrength ?? null,
    previousReasoning: row.previousReasoning ?? null,
    newReasoning: row.newReasoning ?? null,
    addedSourceRefs: (row.addedSourceRefs ?? null) as SourceReference[] | null,
    reasoning: row.reasoning,
    reasoningReportId: row.reasoningReportId ?? null,
    actor: row.actor as Actor,
    occurredAt: row.occurredAt,
  };
}

