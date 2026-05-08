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

// ---- Contradictions ----
export const getContradictions = (limit = 200) => getJson(`/api/contradictions?limit=${limit}`);
export const resolveContradiction = (id, body) =>
  postJson(`/api/contradictions/${encodeURIComponent(id)}/resolve`, body);

// ---- Patterns ----
export const getPatterns = (limit = 100) => getJson(`/api/patterns?limit=${limit}`);

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
