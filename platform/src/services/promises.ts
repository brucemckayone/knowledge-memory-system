/**
 * Promises service (iOS API v1 — ASK-016 slice 2, READ routes).
 *
 * Composes the promise module's two read surfaces from the `facts` table:
 *
 *   - GET /api/promises/open    — active promises (states {open, held,
 *                                 ripening, nudged}), ordered valid_at ASC
 *                                 (NULL/undated last), optional ?limit=N.
 *   - GET /api/promises/:factId — one Promise by fact id (BARE object, no
 *                                 wrapper); 404 if missing / not a commitment.
 *
 * STATE is BACKEND-AUTHORITATIVE: the iOS `Promise` decoder trusts the wire
 * `state` verbatim and does NOT re-derive it (see Promise.swift's type-doc
 * "backend-authoritative"). So this service derives the 6-state enum server-
 * side and ships it; iOS never computes it. The derivation matches the iOS
 * `PromiseState` enum EXACTLY (raw values: open | held | ripening | nudged |
 * done | let-go — note `let-go` is the one hyphenated mapping).
 *
 * ============================================================
 * STATE DERIVATION (per the task contract; substrate = migration 011).
 * ============================================================
 * completionResolution drives the terminal states:
 *   - 'done'    → done
 *   - 'let_go'  → let-go
 * Otherwise (completionResolution NULL — still active):
 *   - valid_at IS NULL                          → open        (undated)
 *   - valid_at > NOW() + 48h AND nudge_count>0  → nudged
 *   - valid_at > NOW() + 48h (nudge_count = 0)  → held
 *   - valid_at <= NOW() + 48h                   → ripening
 *     (regardless of nudge_count — a nudged promise that re-approaches its
 *      shifted deadline ripens again; a past-deadline promise stays ripening
 *      per design/07-modules/promise.md §"Past-deadline promises".)
 *
 * GET /api/promises/open returns ONLY {open, held, ripening, nudged} — the
 * done/let-go terminals are excluded (they left the active set).
 *
 * ============================================================
 * WIRE CONTRACT (camelCase — verbatim per Promise.swift CodingKeys).
 * ============================================================
 *   Promise = {
 *     factId:                  <uuid>,
 *     promiseProse:            "to " + object_value,   // composed prefix
 *     state:                   "open"|"held"|"ripening"|"nudged"|"done"|"let-go",
 *     validAt:                 <iso8601> | null,
 *     createdAt:               <iso8601>,
 *     sourceMemoryId:          <uuid> | null,
 *     sourceQuoteText:         <string, non-blank>,    // the source memory's Qdrant content
 *     sourceQuoteAnnotations:  [],                     // v1: always [] (leaf — no spans)
 *     nudgeCount:              <int>,
 *     completionSuggestion:    null                    // v1: always null (slice 4)
 *   }
 *
 * `promiseProse` = "to " + object_value. The user's own words behind the
 * promise live in `sourceQuoteText` (the source memory's Qdrant content,
 * VERBATIM). Extraction stores object_value as the bare action ("send the
 * studio reply by friday"); the promise framing re-prefixes "to ".
 *
 * `sourceQuoteText` is lifted from Qdrant via services/qdrant.ts getMemory,
 * reading `.payload.content` (same field services/recent.ts reads). When a
 * fact has no source_memory_id, or that memory is unreadable in Qdrant, the
 * row is DROP-with-warn — the iOS decoder REJECTS a blank sourceQuoteText
 * (Promise.swift `decodeNonBlankProse`), so a degenerate row would blank the
 * surface rather than render a quoteless promise.
 *
 * PATTERNS: mirrors services/holding.ts (the commitment-predicate query) +
 * services/ask.ts (the iOS wire-shape discipline). holding.ts is NOT
 * refactored — this is a new service alongside it. holding's held/ripening
 * derivation is a 2-state subset; this is the full 6-state arc owning the
 * promise module's surface.
 */

import { db, facts } from '../db/index.js';
import { and, eq, inArray, isNull, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { getSelfEntity } from './entities.js';
import { getMemory } from './qdrant.js';

// --- classification constants (mirror holding.ts) ----------------------------

/**
 * Commitment predicates (design/07-modules/promise.md; seeded by the graph
 * agent's commitment-fact prompt, commit c0b538c). The user is always the
 * SUBJECT of their own commitments.
 */
const PROMISE_PREDICATES = ['plans_to', 'intends_to', 'committed_to'] as const;

/** A promise whose deadline is within this window is `ripening`. In ms. */
const RIPENING_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The iOS PromiseState closed enum raw values. `let-go` is the hyphenated one. */
export type PromiseState = 'open' | 'held' | 'ripening' | 'nudged' | 'done' | 'let-go';

/** States that belong to the ACTIVE set (GET /api/promises/open). */
const ACTIVE_STATES: ReadonlySet<PromiseState> = new Set([
  'open',
  'held',
  'ripening',
  'nudged',
]);

// --- wire DTOs (camelCase — matches iOS Promise.swift CodingKeys) ------------

export interface PromiseDTO {
  factId: string;
  promiseProse: string;
  state: PromiseState;
  validAt: string | null;
  createdAt: string;
  sourceMemoryId: string | null;
  sourceQuoteText: string;
  /** v1: always []. Leaf — no span computation yet. */
  sourceQuoteAnnotations: unknown[];
  nudgeCount: number;
  /** v1: always null. Slice 4 (done-by-recording) lands the suggestion. */
  completionSuggestion: null;
}

export interface OpenPromisesResponse {
  /** BARE array — never null. `[]` for empty (iOS rejects explicit null). */
  promises: PromiseDTO[];
}

// --- fact row shape ----------------------------------------------------------

interface PromiseFactRow {
  id: string;
  objectValue: string | null;
  sourceMemoryId: string | null;
  validAt: Date | null;
  createdAt: Date;
  nudgeCount: number | null;
  completionResolution: string | null;
}

// =============================================================================
// STATE DERIVATION (backend-authoritative; iOS trusts verbatim)
// =============================================================================

/**
 * Derive the 6-state PromiseState from a fact's substrate fields. Pure +
 * exported for direct unit testing. See the file header for the full rule.
 *
 *   completionResolution = 'done'    → done
 *   completionResolution = 'let_go'  → let-go
 *   else:
 *     valid_at IS NULL                            → open
 *     valid_at > NOW()+48h AND nudge_count > 0    → nudged
 *     valid_at > NOW()+48h (nudge_count = 0)      → held
 *     valid_at <= NOW()+48h                       → ripening
 */
export function derivePromiseState(args: {
  completionResolution: string | null;
  validAt: Date | null;
  nudgeCount: number;
  now: Date;
}): PromiseState {
  const { completionResolution, validAt, nudgeCount, now } = args;

  // Terminal states are set explicitly by the done/let-go mutations (slice 3).
  if (completionResolution === 'done') return 'done';
  if (completionResolution === 'let_go') return 'let-go';

  // Active set — derive from valid_at + nudge_count.
  if (validAt === null) return 'open';

  const delta = validAt.getTime() - now.getTime();
  const withinWindow = delta <= RIPENING_WINDOW_MS;
  if (withinWindow) {
    // Within 48h (or past-due): ripening regardless of nudge_count. A nudged
    // promise whose shifted deadline re-approaches ripens again.
    return 'ripening';
  }
  // Beyond 48h: held, unless it has been nudged (still cooling past its shift).
  return nudgeCount > 0 ? 'nudged' : 'held';
}

// =============================================================================
// source-quote resolution (Qdrant content)
// =============================================================================

/**
 * Lift the source memory's content from Qdrant for `sourceQuoteText`. Reads
 * `.payload.content` (the same field services/recent.ts reads). Returns null
 * when there's no source_memory_id, the memory is absent, or the content is
 * unreadable — the caller drops such rows (the iOS decoder rejects blank
 * sourceQuoteText).
 */
async function resolveSourceQuote(sourceMemoryId: string | null): Promise<string | null> {
  if (!sourceMemoryId) return null;
  let point: Awaited<ReturnType<typeof getMemory>>;
  try {
    point = await getMemory(sourceMemoryId);
  } catch (err) {
    console.warn(
      `[promises] Qdrant read failed for sourceMemoryId=${sourceMemoryId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const content = point?.payload?.content;
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  return content;
}

// =============================================================================
// row → wire shaping
// =============================================================================

/** Normalize an optional string to non-empty-trimmed-or-null. */
function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Shape a promise fact row into the iOS wire Promise. `now` is injected so
 * tests can pin the derivation instant. Returns null when the row cannot
 * satisfy the wire contract (blank object_value → blank promiseProse, or
 * unreadable sourceQuoteText) — the caller drops it warn-logged rather than
 * serving a degenerate row the iOS decoder would reject.
 *
 * `state` is always derived here even though GET /:factId serves terminal
 * states too — the derivation is total over the 6-state space.
 */
async function toPromiseDTO(row: PromiseFactRow, now: Date): Promise<PromiseDTO | null> {
  // promiseProse = "to " + object_value. iOS rejects blank promiseProse.
  const objectValue = trimOrNull(row.objectValue);
  if (!objectValue) {
    console.warn(
      `[promises] dropping fact ${row.id}: blank object_value (promiseProse would be blank)`,
    );
    return null;
  }

  // sourceQuoteText: the user's own words behind the promise (the source
  // memory's Qdrant content). iOS rejects blank — drop if unreadable.
  const sourceQuoteText = await resolveSourceQuote(row.sourceMemoryId);
  if (!sourceQuoteText) {
    console.warn(
      `[promises] dropping fact ${row.id}: no readable sourceQuoteText ` +
        `(sourceMemoryId=${row.sourceMemoryId ?? 'null'})`,
    );
    return null;
  }

  const state = derivePromiseState({
    completionResolution: row.completionResolution,
    validAt: row.validAt,
    nudgeCount: row.nudgeCount ?? 0,
    now,
  });

  return {
    factId: row.id,
    promiseProse: `to ${objectValue}`,
    state,
    validAt: row.validAt ? row.validAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    sourceMemoryId: trimOrNull(row.sourceMemoryId),
    sourceQuoteText,
    sourceQuoteAnnotations: [], // v1: leaf — no spans.
    nudgeCount: row.nudgeCount ?? 0,
    completionSuggestion: null, // v1: deferred to slice 4.
  };
}

// =============================================================================
// query helpers
// =============================================================================

/** The non-expired, non-invalidated commitment-fact predicate for the self. */
function activePromisePredicate(selfEntityId: string): SQL {
  return and(
    eq(facts.subjectEntityId, selfEntityId),
    inArray(facts.predicate, [...PROMISE_PREDICATES]),
    isNull(facts.invalidAt),
    isNull(facts.expiredAt),
  ) as unknown as SQL;
}

/** Select the columns a PromiseDTO needs, in the row shape toPromiseDTO reads. */
const PROMISE_FACT_COLUMNS = {
  id: facts.id,
  objectValue: facts.objectValue,
  sourceMemoryId: facts.sourceMemoryId,
  validAt: facts.validAt,
  createdAt: facts.createdAt,
  nudgeCount: facts.nudgeCount,
  completionResolution: facts.completionResolution,
} as const;

// =============================================================================
// public entry points
// =============================================================================

/**
 * Read the active promises for the self entity (ASK-016 slice 2). Returns
 * only the {open, held, ripening, nudged} states — done/let-go terminals are
 * excluded. Ordered valid_at ASC with NULL/undated last (so the soonest-deadline
 * promise surfaces first for the lock-screen widget). Optional `limit` caps the
 * count (widget sizes); default = all active.
 *
 * A fresh DB / no self entity / no commitment predicates yields the
 * well-formed empty payload `{ promises: [] }` (never null). Degenerate rows
 * (blank object_value, unreadable sourceQuoteText) are dropped warn-logged so
 * the client never rejects the whole payload over one bad row.
 */
export async function getOpenPromises(limit?: number): Promise<OpenPromisesResponse> {
  const now = new Date();

  const self = await getSelfEntity();
  if (!self) {
    // No self entity yet — capture-works-offline means bootstrap is implicit
    // on first ingest. Empty payload so iOS renders the empty state.
    return { promises: [] };
  }

  const rows: PromiseFactRow[] = await db
    .select(PROMISE_FACT_COLUMNS)
    .from(facts)
    .where(activePromisePredicate(self.id))
    // valid_at ASC NULLS LAST — soonest deadline first, undated after. Both
    // order terms expressed as raw SQL so drizzle doesn't append its own
    // direction (mixing a raw fragment with asc() double-emits the direction).
    .orderBy(sql`${facts.validAt} ASC NULLS LAST`, sql`${facts.createdAt} ASC`);

  // Shape + filter to the active set. Drop terminal (done/let-go) rows here —
  // they passed the predicate (no invalidAt/expiredAt filter on resolution)
  // but don't belong in the active overview.
  const shaped: PromiseDTO[] = [];
  for (const row of rows) {
    const dto = await toPromiseDTO(row, now);
    if (!dto) continue;
    if (!ACTIVE_STATES.has(dto.state)) continue; // exclude done/let-go
    shaped.push(dto);
  }

  const capped = typeof limit === 'number' && limit > 0 ? shaped.slice(0, limit) : shaped;
  return { promises: capped };
}

/**
 * Read one Promise by fact id (ASK-016 slice 2). Returns a BARE PromiseDTO
 * (no wrapper) or null when:
 *   - the fact id does not exist,
 *   - the fact's predicate is not a commitment predicate,
 *   - the fact is invalidated/expired.
 *
 * Unlike getOpenPromises this DOES serve terminal states (done/let-go) — the
 * detail view resolves a known promise by id regardless of its lifecycle
 * state. 404 mapping is the route's concern; this returns null.
 */
export async function getPromiseByFactId(factId: string): Promise<PromiseDTO | null> {
  const now = new Date();

  // The detail route serves ALL lifecycle states including the terminals
  // (done/let-go). A resolved promise sets BOTH completion_resolution AND
  // invalid_at (the done/let-go mutations write them together), so a filter
  // on isNull(invalid_at) alone would 404 the very terminals this route is
  // meant to serve. Instead: exclude only facts that are expired/hard-
  // invalidated WITHOUT a completion resolution (a genuine invalidation),
  // and keep those whose invalid_at is the completion release.
  const rows: PromiseFactRow[] = await db
    .select(PROMISE_FACT_COLUMNS)
    .from(facts)
    .where(
      and(
        eq(facts.id, factId),
        inArray(facts.predicate, [...PROMISE_PREDICATES]),
        isNull(facts.expiredAt),
        // Active (no invalid_at) OR completed (invalid_at set by a resolution).
        or(isNull(facts.invalidAt), isNotNull(facts.completionResolution)),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return toPromiseDTO(row, now);
}

// =============================================================================
// MUTATIONS (ASK-016 slice 3)
// =============================================================================
//
// Five write surfaces that change a promise's substrate. The route file
// (routes/promises.ts) owns the 404/409→HTTP mapping; these functions return
// the data or a typed sentinel for the caller to interpret:
//
//   - nudgePromise        → PromiseDTO (shifted) | 'NOT_FOUND' | 'NO_DEADLINE' | 'NUDGE_LIMIT'
//   - markPromiseDone     → true | false  (false = not a commitment / missing)
//   - releasePromise      → true | false  (let-go — never a hard delete; rule 9)
//   - recategorizePromise → true | false  (predicate → 'mentioned', drops the
//                                          row from the promise set)
//   - dismissCompletionSuggestion → no-op stub (slice 4 owns suggestions; v1
//                                    has none, so the call is acknowledged and
//                                    ignored — never errors)
//
// NUDGE LIMIT: a promise can be nudged at most NUDGE_LIMIT (3) times. Each
// nudge shifts valid_at +24h and bumps nudge_count + last_nudged_at. Nudge is
// ONLY meaningful for ripening/held/nudged promises — a promise with NO
// valid_at (state `open`) has no deadline to shift, so it is refused (409).
//
// RELEASE/DONE set completion_resolution + invalid_at (the fact stays in the
// table; never hard-deleted). completion_metadata records provenance
// (resolved_at + actor). Recategorize rewrites predicate → 'mentioned' so the
// ontology (which passes unknown predicates through) drops it from the
// commitment set entirely.

/** Cap on how many times a single promise may be nudged. */
export const NUDGE_LIMIT = 3;

/** Nudge result sentinels (the route maps these to HTTP). */
export type NudgeResult =
  | { kind: 'ok'; promise: PromiseDTO }
  | { kind: 'not_found' }
  | { kind: 'no_deadline' } // valid_at IS NULL — nudge only shifts a deadline
  | { kind: 'nudge_limit' }; // nudge_count >= NUDGE_LIMIT

/**
 * Shift a promise's deadline +24h and bump nudge_count/last_nudged_at (ASK-016
 * slice 3). Refused (no mutation) when the fact isn't an active commitment, has
 * no deadline to shift, or has already hit NUDGE_LIMIT. Returns the shifted
 * Promise shaped via toPromiseDTO (backend-authoritative state recomputed).
 */
export async function nudgePromise(factId: string): Promise<NudgeResult> {
  const now = new Date();

  // Fetch under the commitment predicate so a non-commitment fact 404s (not a
  // silent predicate rewrite). Single read before write — the UPDATE ... RETURNING
  // path below would otherwise let a non-commitment row slip through.
  const existing: PromiseFactRow[] = await db
    .select(PROMISE_FACT_COLUMNS)
    .from(facts)
    .where(
      and(
        eq(facts.id, factId),
        inArray(facts.predicate, [...PROMISE_PREDICATES]),
        isNull(facts.invalidAt),
        isNull(facts.expiredAt),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (!row) return { kind: 'not_found' };

  // No deadline to shift — nudge only applies to ripening/held/nudged (a
  // promise with state `open` has no valid_at).
  if (row.validAt === null) return { kind: 'no_deadline' };

  const nudgeCount = row.nudgeCount ?? 0;
  if (nudgeCount >= NUDGE_LIMIT) return { kind: 'nudge_limit' };

  // NOTE: drizzle's returning() selects the alias keys directly, but the
  // shape is keyed by our column aliases (objectValue, sourceMemoryId, …).
  // We map the row defensively — drizzle returns the camelCase keys when the
  // column is aliased in the schema, which matches PromiseFactRow.
  const updated = await db
    .update(facts)
    .set({
      validAt: sql`${facts.validAt} + INTERVAL '24 hours'`,
      nudgeCount: sql`${facts.nudgeCount} + 1`,
      lastNudgedAt: now,
    })
    .where(eq(facts.id, factId))
    .returning(PROMISE_FACT_COLUMNS);

  const next = updated[0] as PromiseFactRow | undefined;
  if (!next) return { kind: 'not_found' }; // raced away — treat as not found
  const promise = await toPromiseDTO(next, now);
  if (!promise) return { kind: 'not_found' }; // degenerate row (blank quote/prose)
  return { kind: 'ok', promise };
}

/**
 * Mark a promise done (ASK-016 slice 3). Sets completion_resolution='done',
 * invalid_at=NOW(), completion_metadata provenance. Returns true on success,
 * false if the fact isn't an active commitment (→ 404). The fact is preserved
 * (never hard-deleted — CLAUDE.md rule 9).
 */
export async function markPromiseDone(factId: string): Promise<boolean> {
  const result = await db
    .update(facts)
    .set({
      completionResolution: 'done',
      invalidAt: new Date(),
      completionMetadata: sql`jsonb_build_object('resolved_at', NOW(), 'actor', 'user')`,
    })
    .where(
      and(
        eq(facts.id, factId),
        inArray(facts.predicate, [...PROMISE_PREDICATES]),
        isNull(facts.invalidAt),
        isNull(facts.expiredAt),
      ),
    )
    .returning({ id: facts.id });
  return result.length > 0;
}

/**
 * Release a promise (let-go — ASK-016 slice 3). Same shape as done but
 * completion_resolution='let_go'. NEVER a hard delete (CLAUDE.md rule 9).
 */
export async function releasePromise(factId: string): Promise<boolean> {
  const result = await db
    .update(facts)
    .set({
      completionResolution: 'let_go',
      invalidAt: new Date(),
      completionMetadata: sql`jsonb_build_object('resolved_at', NOW(), 'actor', 'user')`,
    })
    .where(
      and(
        eq(facts.id, factId),
        inArray(facts.predicate, [...PROMISE_PREDICATES]),
        isNull(facts.invalidAt),
        isNull(facts.expiredAt),
      ),
    )
    .returning({ id: facts.id });
  return result.length > 0;
}

/**
 * Recategorize a promise as "not a promise" (ASK-016 slice 3). Rewrites
 * predicate → 'mentioned' so the ontology (which passes unknown predicates
 * through) drops the row from the commitment set. 'mentioned' is NOT a
 * commitment predicate, so GET /api/promises/open and /:factId both stop
 * surfacing it. Returns true on success, false if not an active commitment.
 */
export async function recategorizePromise(factId: string): Promise<boolean> {
  const result = await db
    .update(facts)
    .set({ predicate: 'mentioned' })
    .where(
      and(
        eq(facts.id, factId),
        inArray(facts.predicate, [...PROMISE_PREDICATES]),
        isNull(facts.invalidAt),
        isNull(facts.expiredAt),
      ),
    )
    .returning({ id: facts.id });
  return result.length > 0;
}

/**
 * Dismiss a completion suggestion (ASK-016 slice 3). v1 has NO suggestion
 * surface (slice 4 lands done-by-recording detection), so this is a documented
 * no-op: acknowledge the call and do nothing. Never errors. The signature is
 * stable so iOS can wire it now and slice 4 fills in the persistence.
 */
export async function dismissCompletionSuggestion(_factId: string): Promise<void> {
  // Intentionally empty in v1. Slice 4 will record the dismissal against the
  // suggestion row once suggestions exist.
  return;
}

