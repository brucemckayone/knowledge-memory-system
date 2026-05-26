// Centralised fetch wrappers. Every network call the viz makes lives here so
// the API surface is auditable in one file.

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(url, body = null) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- Core graph data ----
export const getStats = () => getJson('/api/viz/stats');
export const getUnified = () => getJson('/api/viz/unified');

// ---- Graph stats singleton (mig 013) ----
export const getGraphStats = () => getJson('/api/graph-stats');
export const computeGraphStats = () => postJson('/api/graph-stats/compute');

// ---- Topology (Phase 2 — viz.2) ----
export const getTopology = () => getJson('/api/topology');
export const computeTopology = () => postJson('/api/topology/compute');

// ---- Clusters (Phase 3.1 — viz.3) ----
export const getClusters = () => getJson('/api/clusters');
export const computeClustering = () => postJson('/api/clustering/compute');

// ---- Cross-cluster candidates (Phase 4 — viz.4) ----
export const getCrossClusterCandidates = (limit = 200) =>
  getJson(`/api/cross-cluster/candidates?limit=${limit}`);
export const generateCrossCluster = () => postJson('/api/cross-cluster/generate');
// Cross-cluster generator runs (bead nmemo-2yv.92). Most recent first.
export const getCrossClusterRuns = (limit = 20) =>
  getJson(`/api/cross-cluster/runs?limit=${limit}`);

// ---- Contradictions ----
export const getContradictions = (limit = 200) => getJson(`/api/contradictions?limit=${limit}`);
export const resolveContradiction = (id, body) =>
  postJson(`/api/contradictions/${encodeURIComponent(id)}/resolve`, body);

// ---- Patterns ----
export const getPatterns = (limit = 100, statuses = null) => {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (statuses && statuses.length > 0) qs.set('status', statuses.join(','));
  return getJson(`/api/patterns?${qs.toString()}`);
};
export const getPatternInstances = (id, limit = 20) =>
  getJson(`/api/patterns/${encodeURIComponent(id)}/instances?limit=${limit}`);
export const detectPatterns = () => postJson('/api/patterns/detect');
export const promotePatterns = () => postJson('/api/patterns/promote');
export const getGhosts = (entityId) => getJson(`/api/ghosts/${encodeURIComponent(entityId)}`);

// ---- Audit history (mig 009 — viz.6) ----
export const getFactHistory = (id) =>
  getJson(`/api/facts/${encodeURIComponent(id)}/history`);
export const getCausalEdgeHistory = (id) =>
  getJson(`/api/causal-edges/${encodeURIComponent(id)}/history`);

// ---- Drift (Phase 3.2 — viz.7) ----
export const getDriftEvents = (limit = 200) =>
  getJson(`/api/drift/events?limit=${limit}`);
export const getDriftEventsForEntity = (entityId, limit = 20) =>
  getJson(`/api/drift/events?entity_id=${encodeURIComponent(entityId)}&limit=${limit}`);
export const getDriftState = (entityId) =>
  getJson(`/api/drift/state/${encodeURIComponent(entityId)}`);
export const computeDrift = () => postJson('/api/drift/compute');

// ---- Impact (Phase 4 blast radius) ----
export const getImpact = (nodeType, nodeId, opts = {}) => {
  const qs = opts.hypothetical
    ? `?hypothetical=${encodeURIComponent(opts.hypothetical)}&depth=${opts.depth ?? 3}`
    : `?depth=${opts.depth ?? 3}`;
  return getJson(`/api/impact/${encodeURIComponent(nodeType)}/${encodeURIComponent(nodeId)}${qs}`);
};

// ---- Ingest ----
export const enqueueIngest = (text, source) =>
  postJson('/ingest/queue', source ? { text, source } : { text });

// ---- Agents ----
export const triggerGarden = () => postJson('/api/garden');
export const triggerReconcile = () => postJson('/api/reconcile');
export const triggerReason = () => postJson('/api/reason');
export const triggerReasonQuery = (question) => postJson('/api/reason/query', { question });

// ---- Reset / clear ----
export const clearGraph = () => postJson('/api/viz/clear');
export const resetAll = () => postJson('/api/reset');
