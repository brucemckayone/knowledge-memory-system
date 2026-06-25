/**
 * GET /api/going-toward route handler (iOS API v1 — going-toward surface).
 *
 * Thin HTTP wrapper over the composeGoingToward service
 * (src/services/going.ts). This file owns ONLY the wire concerns the iOS
 * GoingTowardResponse / DirectionalCommitment contract pins:
 *
 *   - the route shape:    GET /api/going-toward  (NO params)
 *   - status mapping:     sparse/fresh-DB => 200 { directions: [] };
 *                         any failure => 500
 *   - FAIL-LOUD wire normalization the iOS JSONDecoder requires:
 *       * "directions" ALWAYS an array, never null (the iOS decoder REJECTS
 *         explicit null — use [] for empty)
 *       * every field the iOS DTO declares is present and correctly typed,
 *         or iOS throws (blank screen) — so we never emit a blank
 *         directionId / line / italicEntity.{entityId,name}
 *       * status is the closed enum "confirmed" | "still-inferring"
 *       * confirmedSince is an ISO-8601 string when status === 'confirmed',
 *         and null when 'still-inferring' (the iOS decoder REJECTS a
 *         'confirmed' payload missing confirmedSince)
 *       * supportingEntries is a non-negative integer (iOS rejects negatives)
 *       * italicEntity.name is a substring of line (iOS soft-validates; we
 *         guarantee it by construction in composeThroughline)
 *
 * The composeGoingToward service does the signal aggregation and the
 * deterministic Voice-C throughline composition; see its header for the
 * derivation rationale and the SPIKE flag. This handler must NOT be where new
 * data logic lives — it only guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts this in a LATER phase via
 *   app.get('/api/going-toward', goingHandler)
 * Do NOT edit index.ts from here (an integration agent mounts all routes).
 */

import type { Context } from 'hono';
import {
  composeGoingToward,
  type DirectionalCommitment,
  type DirectionStatus,
  type GoingTowardResponse,
} from '../services/going.js';

/** The iOS DirectionStatus closed enum. Anything else makes iOS throw. */
const VALID_STATUS: ReadonlySet<DirectionStatus> = new Set([
  'confirmed',
  'still-inferring',
]);

function nonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Normalize a composed direction into the exact iOS wire shape. Idempotent for
 * an already-valid direction; load-bearing as the last line of defense before
 * the bytes reach the iOS JSONDecoder. A direction that cannot satisfy the
 * contract is DROPPED (warn-logged) rather than served, so the client never
 * rejects the whole payload over one bad row — mirrors notifications.ts.
 */
function toWireDirection(d: DirectionalCommitment): DirectionalCommitment | null {
  if (!nonBlank(d.directionId)) {
    console.warn('[going-toward] dropping direction: blank directionId');
    return null;
  }
  if (!nonBlank(d.line)) {
    console.warn(`[going-toward] dropping direction ${d.directionId}: blank line`);
    return null;
  }
  if (!d.italicEntity || !nonBlank(d.italicEntity.entityId) || !nonBlank(d.italicEntity.name)) {
    console.warn(`[going-toward] dropping direction ${d.directionId}: blank italicEntity`);
    return null;
  }
  if (!VALID_STATUS.has(d.status)) {
    console.warn(
      `[going-toward] dropping direction ${d.directionId}: invalid status "${d.status}"`,
    );
    return null;
  }
  // supportingEntries is a cardinality — iOS rejects negatives.
  const supportingEntries = Math.trunc(d.supportingEntries);
  if (!Number.isFinite(supportingEntries) || supportingEntries < 0) {
    console.warn(
      `[going-toward] dropping direction ${d.directionId}: negative/non-finite supportingEntries`,
    );
    return null;
  }
  // confirmed REQUIRES a confirmedSince ISO string; still-inferring REQUIRES
  // null. The iOS decoder enforces both — enforce them here too.
  let confirmedSince: string | null;
  if (d.status === 'confirmed') {
    if (typeof d.confirmedSince !== 'string' || d.confirmedSince.length === 0) {
      console.warn(
        `[going-toward] dropping direction ${d.directionId}: status "confirmed" missing confirmedSince`,
      );
      return null;
    }
    // Fail-loud: a non-parseable date would surface as an iOS decode error
    // (it expects strict ISO-8601). Validate parseability here.
    const parsed = Date.parse(d.confirmedSince);
    if (Number.isNaN(parsed)) {
      console.warn(
        `[going-toward] dropping direction ${d.directionId}: confirmedSince is not ISO-8601 ("${d.confirmedSince}")`,
      );
      return null;
    }
    confirmedSince = new Date(parsed).toISOString();
  } else {
    confirmedSince = null;
  }

  // Substring guarantee: italicEntity.name must occur in line for the iOS
  // view to italicize it. composeThroughline guarantees this structurally;
  // assert it here as a belt-and-braces decode-boundary guard. A miss would
  // only degrade the render (non-italic), but we drop rather than ship a
  // row the view can't style as designed.
  if (!d.line.includes(d.italicEntity.name)) {
    console.warn(
      `[going-toward] dropping direction ${d.directionId}: italicEntity.name "${d.italicEntity.name}" not in line`,
    );
    return null;
  }

  return {
    directionId: d.directionId,
    line: d.line,
    italicEntity: {
      entityId: d.italicEntity.entityId,
      name: d.italicEntity.name,
    },
    status: d.status,
    confirmedSince,
    supportingEntries,
  };
}

/**
 * Normalize the composed response: drop any direction that would fail the iOS
 * decoder, de-dupe on directionId (defensive — composeGoingToward already
 * emits unique ids), and guarantee `directions` is always an array.
 */
export function toGoingTowardResponse(res: GoingTowardResponse): GoingTowardResponse {
  const seen = new Set<string>();
  const directions: DirectionalCommitment[] = [];
  for (const raw of res.directions ?? []) {
    const wire = toWireDirection(raw);
    if (!wire) continue;
    if (seen.has(wire.directionId)) {
      console.warn(`[going-toward] dropping duplicate directionId ${wire.directionId}`);
      continue;
    }
    seen.add(wire.directionId);
    directions.push(wire);
  }
  return { directions };
}

/**
 * Hono handler for GET /api/going-toward. No parameters. A fresh / not-yet-
 * computed graph yields the well-formed empty payload { directions: [] }
 * (never null); the iOS view layer then hides the section. Any aggregation
 * failure => 500 with an error body.
 */
export async function goingHandler(c: Context): Promise<Response> {
  try {
    const result = await composeGoingToward();
    return c.json(toGoingTowardResponse(result));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export default goingHandler;
