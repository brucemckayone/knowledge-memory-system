/**
 * GET /api/hero route handler (iOS API v1 — ASK-017).
 *
 * Thin HTTP wrapper over the composeHero service (src/services/hero.ts). This
 * file owns ONLY the wire concerns the iOS HeroResponse contract pins:
 *
 *   - the route shape:    GET /api/hero?nodeId=<entityId>  (nodeId OPTIONAL)
 *   - status mapping:     sparse/fresh-DB => 200 { active: null, [] ... };
 *                         explicit-but-unresolved nodeId => 404;
 *                         any other failure => 500
 *   - FAIL-LOUD wire normalization the iOS JSONDecoder requires:
 *       * "active" key ALWAYS present (value object or null)
 *       * neighbors / edges / secondDegreeStubs ALWAYS arrays, never null
 *       * active.type and neighbor.type are CLAMPED to the iOS enum
 *         "entity" | "thread" | "entry" — any unknown backend entity_type
 *         maps to "entity" (an unknown literal makes iOS throw on decode)
 *       * edgeStrength / strength / directionHint clamped finite into [0,1]
 *
 * The composeHero service does the graph orchestration and Voice-C composition;
 * see its header for seed resolution (explicit nodeId wins, else getSelfEntity)
 * and the deterministic-summary rationale. This handler must NOT be where new
 * data logic lives — it only guarantees the bytes iOS can decode.
 *
 * Wiring: src/index.ts mounts this in a LATER phase via
 *   app.get('/api/hero', heroRoute)
 * Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import {
  composeHero,
  HeroNodeNotFoundError,
  type HeroComposition,
  type HeroActive,
} from '../services/hero.js';

/** The iOS HeroActiveNode.type enum. Unknown backend types map to 'entity'. */
type HeroNodeType = 'entity' | 'thread' | 'entry';

const VALID_NODE_TYPES: ReadonlySet<string> = new Set(['entity', 'thread', 'entry']);

/** Map any backend entity_type to the closed iOS enum. Unknown => 'entity'
 *  (an unknown literal makes the iOS decoder throw). */
function safeNodeType(raw: string): HeroNodeType {
  return VALID_NODE_TYPES.has(raw) ? (raw as HeroNodeType) : 'entity';
}

/** Clamp to a finite number in [0,1]. Non-finite (NaN/±Inf) => 0. An
 *  out-of-range weight makes the iOS decoder throw, so we never emit one. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Normalize a HeroComposition into the exact iOS wire shape. Idempotent for an
 * already-valid composition; load-bearing as the last line of defense before
 * the bytes reach the iOS JSONDecoder.
 */
export function toHeroResponse(hero: HeroComposition): HeroComposition {
  const active: HeroActive | null = hero.active
    ? {
        ...hero.active,
        type: safeNodeType(hero.active.type),
      }
    : null;

  return {
    // "active" key is ALWAYS present (object or explicit null).
    active,
    // Arrays are ALWAYS arrays — never null — with clamped strengths/hints.
    neighbors: (hero.neighbors ?? []).map((n) => ({
      ...n,
      type: safeNodeType(n.type),
      edgeStrength: clamp01(n.edgeStrength),
    })),
    edges: (hero.edges ?? []).map((e) => ({
      ...e,
      strength: clamp01(e.strength),
    })),
    secondDegreeStubs: (hero.secondDegreeStubs ?? []).map((s) => ({
      ...s,
      directionHint: clamp01(s.directionHint),
    })),
  };
}

/**
 * Hono handler for GET /api/hero.
 *
 * ?nodeId is optional; absent => the user's self entity. Sparse data / fresh DB
 * (no self entity, or seed has no profile) => 200 with { active: null, ... } so
 * iOS renders the pre-data hero stub. An explicit, malformed/unresolved nodeId
 * => 404. Any other failure => 500. iOS treats 404/500 as the "still listening"
 * fallback.
 */
export async function heroRoute(c: Context): Promise<Response> {
  const nodeId = c.req.query('nodeId');
  try {
    const hero = await composeHero(nodeId);
    return c.json(toHeroResponse(hero));
  } catch (err) {
    if (err instanceof HeroNodeNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default heroRoute;
