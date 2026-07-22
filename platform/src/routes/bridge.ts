/**
 * Bridge / explore route handlers (iOS API v1 — ASK-014 degraded v1).
 *
 * Thin HTTP wrappers over services/bridge.ts. They own ONLY the wire concerns
 * the iOS decoders (BridgeData.swift) pin:
 *
 *   GET /api/bridge/current
 *     -> 200 { bridgeNarrative: <BridgeNarrative> | null }
 *        `null` is the "no bridge identifiable yet" success-shape iOS unwraps to
 *        BridgeNarrative? (NOT a 404). 500 reserved for real failures.
 *
 *   GET /api/explore/node/:entityId
 *     -> 200 <bare ExploreNodeResponse> for a known entity.
 *     -> 404 for a malformed / unknown entity id. The iOS ExploreNodeRequest has
 *        NO documented let-go success-shape (unlike rise), so an unknown node is
 *        a transport 404, not an empty frame.
 *     -> 500 reserved for real failures.
 *
 * DEFERRED (iOS keeps 501 stubs): POST confirm / reject / rename + bridgeShift.
 *
 * Wiring: src/index.ts mounts both via
 *   app.get('/api/bridge/current', bridgeCurrentHandler)
 *   app.get('/api/explore/node/:entityId', exploreNodeHandler)
 * Do NOT edit index.ts from here.
 */

import type { Context } from 'hono';
import {
  composeBridgeCurrent,
  composeExploreCommunities,
  composeExploreNode,
  ExploreNodeNotFoundError,
} from '../services/bridge.js';

/**
 * GET /api/bridge/current. Returns the { bridgeNarrative } envelope. A
 * no-bridge graph yields { bridgeNarrative: null } (200, the success-shape iOS
 * unwraps), never 404. 500 only on a real failure.
 */
export async function bridgeCurrentHandler(c: Context): Promise<Response> {
  try {
    const result = await composeBridgeCurrent();
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * GET /api/explore/node/:entityId. Returns a BARE ExploreNodeResponse. A
 * malformed / unknown id is a 404 (iOS has no let-go shape for explore). 500
 * only on a real failure.
 */
export async function exploreNodeHandler(c: Context): Promise<Response> {
  const entityId = c.req.param('entityId');
  if (!entityId) return c.json({ error: 'entityId is required' }, 400);
  try {
    const data = await composeExploreNode(entityId);
    return c.json(data);
  } catch (err) {
    if (err instanceof ExploreNodeNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/**
 * GET /api/explore/communities. Returns a BARE ARRAY of { communityId, label }
 * — the graph-wide community-label snapshot the iOS CommunityLabelProvider
 * decodes into [CommunityCluster] (bare array; mirrors the explore-node bare
 * shape, and fetchCommunities() returns a bare array). An empty graph / no
 * named communities is [] (200), never 404. 500 only on a real failure.
 */
export async function exploreCommunitiesHandler(c: Context): Promise<Response> {
  try {
    const communities = await composeExploreCommunities();
    return c.json(communities);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export default bridgeCurrentHandler;
