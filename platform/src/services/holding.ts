/**
 * Holding service (iOS API v1 — ASK-HOLDING).
 *
 * Composes the home's "holding" section: a kept list of open commitments,
 * threads, and unresolved-things-on-mind in the user's OWN past words. Not a
 * to-do list. See design/03-home.md §"Section 4 — Holding".
 *
 * Three states, all BACKEND-AUTHORITATIVE (the iOS `HoldingItem` decoder
 * consumes an explicit `state` field; it does NOT derive it — two items with
 * no `validAt` land in different states, so state cannot be inferred from the
 * dates alone; see HoldingItem.swift's "backend-authoritative" note):
 *
 *   - `held`     — a promise/commitment fact being tracked, with no near deadline.
 *   - `ripening` — a promise/commitment fact whose `valid_at` is within 48h.
 *   - `open`     — a causal-ghost open question (a held question with no deadline).
 *
 * SOURCES (reuse, no schema change — GET-only):
 *   - held/ripening: `facts` where predicate ∈ PROMISE_PREDICATES, invalid_at
 *     IS NULL, expired_at IS NULL. `line` is `facts.source_text` — the user's
 *     own past words, passed through VERBATIM (NOT composed).
 *   - open: causal ghosts (services/causal-patterns.ts findCausalGhosts).
 *
 * ============================================================
 * v1 SUPPRESSION: open-state ghost items are NOT shipped.
 * ============================================================
 * `findCausalGhosts` returns Ghost objects whose `reasoning` is structural
 * graph-topology metadata ("Entity covers N of M edge positions in pattern
 * '<name>'; position P is missing.") — NOT the user's own words. The wire
 * contract demands `line` be the user's OWN past words (design/03-home.md
 * §"Section 4": "a kept list"; the examples are first-person commitments).
 * Causal ghosts carry no source_text / pulled_line: they describe a MISSING
 * structural slot, not an uttered commitment, so there is nothing verbatim to
 * lift. Shipping them would surface composed backend vocabulary as if it were
 * the user's voice — a Voice-C violation. open items stay suppressed until the
 * source_text join (the promises epic ASK-016, which owns the commitment-
 * predicate ontology + a real open-question compose) can lift the user's actual
 * words onto a ghost. Until then ONLY held/ripening items are served; the
 * suppression is logged once per process. This mirrors gap G3 in
 * BACKEND-INTEGRATION-SCOPING.md (walk's ghost→ids spike).
 *
 * ============================================================
 * DECISION: explicit-classification `state`, NOT the valid_at-threshold rule.
 * ============================================================
 * design/03-home.md §"Section 4" §Backend gives a state-derivation rule
 * (`held` if `valid_at > NOW() + 7 days`, `ripening` if within 48h, `open` if
 * no `valid_at` set). That rule CONTRADICTS the section's own held-sister
 * example (held, no `valid_at`) and conflates the held/open distinction (both
 * lack a deadline). We follow the explicit-classification interpretation the
 * iOS DTO already documents (HoldingItem.swift): classification is substrate
 * work. Here: a promise fact WITH a future `valid_at` is `ripening` when that
 * deadline is within 48h, else `held`; a promise fact with no `valid_at` is
 * `held`. `open` is reserved for causal-ghost questions (a different source).
 * The corpus's valid_at-threshold rule is treated as the internal heuristic,
 * not the wire classification — flagged for retro reconciliation.
 */

import { db, facts } from '../db/index.js';
import { eq, and, isNull, inArray, desc } from 'drizzle-orm';
import { getSelfEntity } from './entities.js';

// --- wire contract (camelCase; matches iOS HoldingItem.swift CodingKeys) ------

export type HoldingState = 'held' | 'ripening' | 'open';

export interface HoldingItemDTO {
  /** Stable wire id. Promise facts: `holding:fact:<factId>`. Ghosts: `holding:ghost:<patternId>:<pos>`. Non-empty. */
  holdingId: string;
  /** The user's OWN past words, passed through verbatim (NOT composed). Non-empty. */
  line: string;
  /** Backend-authoritative state. */
  state: HoldingState;
  /** ISO-8601. REQUIRED iff state === 'ripening'; else null. iOS throws on ripening-without-validAt. */
  validAt: string | null;
  /** ISO-8601. Always present (createdAt). */
  createdAt: string;
  /** Optional; iOS composes meta from state + dates when absent. */
  metaText: string | null;
  /** Optional UUID; tap → rise. */
  sourceMemoryId: string | null;
  /** Optional UUID; backs the eventual nudge / let-go. */
  factId: string | null;
}

export interface HoldingResponse {
  items: HoldingItemDTO[];
}

// --- classification constants ------------------------------------------------

/**
 * Promise-shaped predicates (design/03-home.md §"Section 4" §Backend line 247).
 * NOTE: these are NOT seeded in the canonical fact_predicates table yet (the
 * promises epic ASK-016 owns adding them to the ontology + extraction tagging).
 * The query uses inArray, so an empty real-DB result simply yields no
 * held/ripening items — correctly empty until extraction starts tagging them.
 */
const PROMISE_PREDICATES = ['plans_to', 'intends_to', 'committed_to'] as const;

/** A promise fact whose deadline is within this window is `ripening`
 *  (design/03-home.md: "ripening if within 48h"). In ms. */
const RIPENING_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Normalize an optional string to non-empty-trimmed-or-null. */
function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// --- promise facts → held / ripening -----------------------------------------

interface PromiseFactRow {
  id: string;
  predicate: string;
  sourceText: string | null;
  sourceMemoryId: string | null;
  validAt: Date | null;
  createdAt: Date;
}

// NOTE: the `open`-state ghost machinery (composeGhostLine / readOpenItems /
// OPEN_CAP) lived here. It was REMOVED for v1 — open items are suppressed
// pending the ASK-016 source_text join (see the SUPPRESSION note in the file
// header). The held/ripening path below is the only source shipped.

/**
 * Classify a promise fact into `held` or `ripening`. A fact with a future
 * `valid_at` within RIPENING_WINDOW_MS is ripening (and carries its deadline);
 * otherwise held. A fact with no `valid_at` is held (the held-sister case).
 */
function classifyPromise(
  validAt: Date | null,
  now: Date,
): { state: 'held' | 'ripening'; wireValidAt: string | null } {
  if (validAt && validAt.getTime() > now.getTime()) {
    const delta = validAt.getTime() - now.getTime();
    if (delta <= RIPENING_WINDOW_MS) {
      return { state: 'ripening', wireValidAt: validAt.toISOString() };
    }
  }
  return { state: 'held', wireValidAt: null };
}

/**
 * Read promise-shaped, non-expired, non-invalidated facts for the self entity
 * (the user is always the SUBJECT of their own commitments) and classify each
 * into held / ripening. `line` is `source_text` verbatim — the user's own past
 * words, not composed.
 */
async function readPromiseItems(selfEntityId: string, limit: number, now: Date): Promise<HoldingItemDTO[]> {
  const rows: PromiseFactRow[] = await db
    .select({
      id: facts.id,
      predicate: facts.predicate,
      sourceText: facts.sourceText,
      sourceMemoryId: facts.sourceMemoryId,
      validAt: facts.validAt,
      createdAt: facts.createdAt,
    })
    .from(facts)
    .where(
      and(
        eq(facts.subjectEntityId, selfEntityId),
        inArray(facts.predicate, [...PROMISE_PREDICATES]),
        isNull(facts.invalidAt),
        isNull(facts.expiredAt),
      ),
    )
    .orderBy(desc(facts.createdAt))
    .limit(limit);

  const items: HoldingItemDTO[] = [];
  for (const r of rows) {
    // FAIL-LOUD wire normalization: the iOS decoder rejects empty `line`.
    // A promise fact with no source_text cannot yield the user's own words —
    // drop it (warn) rather than serve a blank row that blanks the section.
    const line = trimOrNull(r.sourceText);
    if (!line) {
      console.warn(`[holding] dropping promise fact ${r.id}: blank source_text (line must be the user's own words)`);
      continue;
    }
    const { state, wireValidAt } = classifyPromise(r.validAt, now);
    items.push({
      holdingId: `holding:fact:${r.id}`,
      line,
      state,
      validAt: wireValidAt,
      createdAt: r.createdAt.toISOString(),
      metaText: null,
      sourceMemoryId: trimOrNull(r.sourceMemoryId),
      factId: r.id,
    });
  }
  return items;
}

// --- public entry point ------------------------------------------------------

// v1 SUPPRESSION: `open`-state items (causal-ghost-derived) are intentionally
// NOT shipped in v1. The ghost carries no user-worded prose — its `reasoning` is
// structural graph-topology vocabulary — so the only available `line` was a
// COMPOSED placeholder that surfaced backend vocabulary as if it were the
// user's voice. design/03-home.md §"Section 4 — Holding" is explicit that
// holding is "a kept list" of the user's OWN words; composed topology prose
// violates that contract. open items stay suppressed until the source_text join
// (the ASK-016 / promises-epic follow-up) can lift the user's actual words onto
// a ghost. Until then only held/ripening items are returned. Logged once per
// process so an operator knows the suppression is intentional, not a bug.
let openSuppressionLogged = false;

/**
 * Compose the holding section for the self entity (ASK-006). Promise facts →
 * held/ripening ONLY in v1 (open/ghost items are suppressed — see the
 * SUPPRESSION note above). Merged, newest-first by createdAt, capped at
 * `limit`. A fresh DB / no self entity / no promise predicates / no canonical
 * patterns yields the well-formed empty payload `{ items: [] }` (never null),
 * mirroring the hero's sparse-data posture.
 *
 * Callable directly (tests) or via the Hono handler.
 */
export async function getHolding(limit = 20): Promise<HoldingResponse> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 100));
  const now = new Date();

  const self = await getSelfEntity();
  if (!self) {
    // No self entity yet (capture-works-offline: bootstrap is implicit on
    // first ingest). Empty payload so iOS renders the empty state
    // ("nothing held this week."). Mirrors hero's active:null sparse case.
    return { items: [] };
  }

  // v1: only held/ripening. The open/ghost read is intentionally NOT called
  // (see the SUPPRESSION note above the function). Logged once per process.
  if (!openSuppressionLogged) {
    openSuppressionLogged = true;
    console.warn(
      '[holding] open-state ghost items are intentionally suppressed in v1 '
        + '(pending the source_text join from the promises epic ASK-016); '
        + 'only held/ripening items are served',
    );
  }

  const promiseItems = await readPromiseItems(self.id, safeLimit, now);

  // Dedupe on holdingId (defensive — the iOS decoder dedupes on identity and a
  // collision would silently collapse a row).
  const seen = new Set<string>();
  const merged: HoldingItemDTO[] = [];
  for (const item of promiseItems) {
    if (seen.has(item.holdingId)) continue;
    seen.add(item.holdingId);
    merged.push(item);
  }

  // Newest-first by createdAt, capped. Stable enough for v1 (display ordering
  // is finalized in the iOS view layer).
  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: merged.slice(0, safeLimit) };
}
