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
 *   - open: `findCausalGhosts(selfEntityId)` from services/causal-patterns.ts.
 *
 * ============================================================
 * SPIKE (flagged): the ghost → user-worded-prose join is unresolved.
 * ============================================================
 * `findCausalGhosts` returns Ghost objects whose `reasoning` is structural
 * metadata ("Entity covers N of M edge positions in pattern '<name>'; position
 * P is missing.") — NOT the user's own words. The wire contract demands `line`
 * be the user's OWN past words (design/03-home.md §"Section 4": "a kept list";
 * the examples are first-person commitments). Causal ghosts do not carry a
 * source_text / pulled_line: they describe a MISSING structural slot, not an
 * uttered commitment, so there is nothing verbatim to lift. This mirrors gap
 * G3 in BACKEND-INTEGRATION-SCOPING.md (walk's ghost→ids spike).
 *
 * Resolution options (out of scope for GET-only v1 — flagged for the promises
 * epic, ASK-016, which owns the commitment-predicate ontology + a real
 * open-question compose):
 *   (a) join a ghost back to the nearest supporting memory's pulled_line
 *       (needs the memory_index / pulled_line work — ASK-002, recent epic); OR
 *   (b) a deterministic Voice-C compose over the pattern context (the composer
 *       exists; voice-c-composer.ts) — but that yields composed prose, not the
 *       user's verbatim words, and the surface contract is "the user's own
 *       past words."
 *
 * v1 DECISION (documented): until the join lands, an `open` item's `line` is a
 * deterministic, Voice-C-safe placeholder composed from the ghost's pattern
 * context — it names the open thread the ghost points at, lowercase, no
 * forbidden verbs — and `metaText` is omitted (iOS recomposes it). This keeps
 * the endpoint decodable and the surface non-blank without inventing a fake
 * user quote. When ASK-016 lands the real source_text join, swap the line.
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
import { findCausalGhosts, type Ghost } from './causal-patterns.js';
import { assertVoiceC } from './voice-c-composer.js';

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

/** Caps how many ghosts we turn into `open` items (findCausalGhosts already
 *  caps at 10; we further bound the section). */
const OPEN_CAP = 5;

function nonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

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

/**
 * Build a deterministic, Voice-C-safe placeholder `line` for an `open` ghost
 * item. The ghost's `reasoning` is structural metadata, not user words (see the
 * SPIKE note in the file header) — so we name the open thread the ghost points
 * at, lowercase, with no forbidden verbs. assertVoiceC guards the result.
 *
 * The pattern name is often already lowercase prose ("approach → commit →
 * ship"); we lower-case + collapse whitespace defensively and strip a trailing
 * period. When the pattern is anonymous we fall back to a generic, never-blank
 * phrasing so the row is always decodable (iOS rejects empty `line`).
 */
function composeGhostLine(ghost: Ghost): string {
  const name = nonBlank(ghost.patternName) ? ghost.patternName : null;
  const expected = nonBlank(ghost.expectedPredicateCategory) ? ghost.expectedPredicateCategory : null;
  let line: string;
  if (name && expected) {
    line = `an open thread in ${name.toLowerCase()} — the ${expected.toLowerCase()} step is still missing`;
  } else if (name) {
    line = `an open thread in ${name.toLowerCase()} — one step is still missing`;
  } else {
    line = 'an open thread — one step is still missing';
  }
  assertVoiceC(line);
  return line;
}

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

/**
 * Turn the self entity's causal ghosts into `open` items. See the SPIKE note in
 * the file header: the ghost carries no user-worded prose, so `line` is a
 * deterministic placeholder until the ASK-016 join lands. `validAt` is always
 * null for `open` (a held question has no deadline).
 */
async function readOpenItems(selfEntityId: string, limit: number): Promise<HoldingItemDTO[]> {
  let ghosts: Ghost[];
  try {
    ghosts = await findCausalGhosts(selfEntityId);
  } catch (err) {
    // Ghost detection failure must NOT blank the whole section — the promise
    // items are independent. Log and serve zero open items.
    console.warn(
      `[holding] ghost detection failed for entity ${selfEntityId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const items: HoldingItemDTO[] = [];
  for (const g of ghosts.slice(0, Math.min(limit, OPEN_CAP))) {
    const line = composeGhostLine(g);
    items.push({
      holdingId: `holding:ghost:${g.patternId}:${g.positionInPattern}`,
      line,
      state: 'open',
      validAt: null,
      // Ghosts have no createdAt of their own; the pattern's last_seen_at is
      // the closest timestamp, but we don't fetch it here to avoid a second
      // join. Use NOW() so the row has a valid, ordered createdAt. The display
      // ordering lives in the iOS view layer regardless.
      createdAt: new Date().toISOString(),
      metaText: null,
      sourceMemoryId: null,
      factId: null,
    });
  }
  return items;
}

// --- public entry point ------------------------------------------------------

/**
 * Compose the holding section for the self entity (ASK-006). Promise facts →
 * held/ripening; causal ghosts → open. Merged, newest-first by createdAt, capped
 * at `limit`. A fresh DB / no self entity / no promise predicates / no canonical
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

  const [promiseItems, openItems] = await Promise.all([
    readPromiseItems(self.id, safeLimit, now),
    readOpenItems(self.id, safeLimit),
  ]);

  // Dedupe on holdingId (a promise fact and a ghost could not collide by id
  // construction, but guard defensively — the iOS decoder dedupes on identity
  // and a collision would silently collapse a row).
  const seen = new Set<string>();
  const merged: HoldingItemDTO[] = [];
  for (const item of [...promiseItems, ...openItems]) {
    if (seen.has(item.holdingId)) continue;
    seen.add(item.holdingId);
    merged.push(item);
  }

  // Newest-first by createdAt, capped. Stable enough for v1 (display ordering
  // is finalized in the iOS view layer).
  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: merged.slice(0, safeLimit) };
}
