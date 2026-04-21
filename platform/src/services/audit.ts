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

import { eq, desc, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  factHistory,
  causalEdgeHistory,
  type FactHistory,
  type CausalEdgeHistory,
} from '../db/schema.js';

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
  const [row] = await client
    .insert(factHistory)
    .values({
      factId: params.factId,
      eventType: params.eventType,
      previousConfidence: params.previousConfidence ?? null,
      newConfidence: params.newConfidence ?? null,
      previousValidAt: params.previousValidAt ?? null,
      newValidAt: params.newValidAt ?? null,
      previousInvalidAt: params.previousInvalidAt ?? null,
      newInvalidAt: params.newInvalidAt ?? null,
      reasoning: params.reasoning,
      sourceReferences: params.sourceReferences ?? [],
      reasoningReportId: params.reasoningReportId ?? null,
      causalEventId: params.causalEventId ?? null,
      actor: params.actor,
    })
    .returning({ id: factHistory.id });
  if (!row) throw new Error('recordFactChange: INSERT returned no row');
  return row.id;
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
  const [row] = await client
    .insert(causalEdgeHistory)
    .values({
      edgeId: params.edgeId,
      eventType: params.eventType,
      previousStrength: params.previousStrength ?? null,
      newStrength: params.newStrength ?? null,
      previousReasoning: params.previousReasoning ?? null,
      newReasoning: params.newReasoning ?? null,
      addedSourceRefs: params.addedSourceRefs ?? null,
      reasoning: params.reasoning,
      reasoningReportId: params.reasoningReportId ?? null,
      actor: params.actor,
    })
    .returning({ id: causalEdgeHistory.id });
  if (!row) throw new Error('recordEdgeChange: INSERT returned no row');
  return row.id;
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

// Re-export the SQL type so callers building custom queries can reference it
// without reaching into drizzle-orm directly.
export type { SQL };
