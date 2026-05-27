// Pure helpers for the unified merge-candidates panel (bead nmemo-2yv.47).
//
// Extracted so they're importable from Node test environments — no DOM
// (`document`/`window`/`fetch`) is referenced. The DOM-coupled rendering
// lives in merge-candidates.js; these helpers are the part that actually
// has correctness behaviour worth asserting.

// Nine-signal label / colour table. Keys mirror merge-scorer.ts:SignalSet
// (snake_case) so the parser can index the JSON directly. Colour palette
// matches the legacy cross-cluster panel for the overlap signals.
export const SIGNAL_LABELS = [
  ['centroid_similarity',         'centroid',       '#58a6ff'],
  ['memory_overlap',              'memory',         '#f0883e'],
  ['structural_similarity',       'structural',     '#27ae60'],
  ['cluster_match',               'cluster',        '#9b59b6'],
  ['predicate_signature_cosine',  'predicate',      '#d29922'],
  ['drift_recency_either',        'drift',          '#f85149'],
  ['centrality_match',            'centrality',     '#1abc9c'],
  ['articulation_bonus',          'articulation',   '#e67e22'],
  ['component_match',             'component',      '#8b949e'],
];

// Source filter chip vocab. 'all' is the default. The candidate_source values
// mirror src/services/enums.ts:CANDIDATE_SOURCE_VALUES.
export const SOURCE_FILTERS = [
  ['all',                     'All'],
  ['three_signal_scoring',    'Three-signal'],
  ['cross_cluster_generator', 'Cross-cluster'],
];

/** Parse the per-row signals map from the row's resolutionReasoning JSON +
 *  direct SQL columns. Returned object is keyed by SIGNAL_LABELS[i][0]; values
 *  are number | null. */
export function parseSignals(row) {
  const fromJson = parseJsonSignals(row.resolutionReasoning);
  // Direct-column fallback ensures the three core signals are always populated
  // even if resolution_reasoning is null or malformed (legacy rows).
  return {
    centroid_similarity:        firstNonNull(fromJson.centroid_similarity, row.centroidSimilarity),
    memory_overlap:             firstNonNull(fromJson.memory_overlap, row.memoryOverlap),
    structural_similarity:      firstNonNull(fromJson.structural_similarity, row.structuralSimilarity),
    cluster_match:              normaliseNullable(fromJson.cluster_match),
    predicate_signature_cosine: normaliseNullable(fromJson.predicate_signature_cosine),
    drift_recency_either:       normaliseNullable(fromJson.drift_recency_either),
    centrality_match:           normaliseNullable(fromJson.centrality_match),
    articulation_bonus:         normaliseNullable(fromJson.articulation_bonus),
    component_match:            normaliseNullable(fromJson.component_match),
  };
}

function firstNonNull(...vals) {
  for (const v of vals) if (v != null) return Number(v);
  return null;
}

function normaliseNullable(v) {
  return v == null ? null : Number(v);
}

function parseJsonSignals(reasoning) {
  if (!reasoning) return {};
  let parsed;
  try {
    parsed = typeof reasoning === 'string' ? JSON.parse(reasoning) : reasoning;
  } catch {
    return {};
  }
  // Post-F1a unified shape: { signals: {...} }.
  if (parsed && typeof parsed.signals === 'object' && parsed.signals) {
    return parsed.signals;
  }
  // Pre-F1a legacy cross-cluster shape:
  //   { contributions: { cluster, drift_a, drift_b, role, centrality, articulation } }.
  // Map the legacy keys onto the unified vocabulary best-effort. The legacy
  // blob never carried centroid/memory/structural — those came from the SQL
  // columns directly, so the unified caller falls back to row.*Similarity for
  // those three.
  if (parsed && typeof parsed.contributions === 'object' && parsed.contributions) {
    const c = parsed.contributions;
    const driftMax = (c.drift_a != null || c.drift_b != null)
      ? Math.max(Number(c.drift_a) || 0, Number(c.drift_b) || 0)
      : null;
    return {
      cluster_match:        c.cluster ?? null,
      drift_recency_either: driftMax,
      centrality_match:     c.role ?? c.centrality ?? null,
      articulation_bonus:   c.articulation ?? null,
    };
  }
  return {};
}

/** Source-filter helper. Returns a new array filtered by the chip key. */
export function filterBySource(rows, sourceKey) {
  if (sourceKey === 'all') return rows;
  return rows.filter((r) => r.candidateSource === sourceKey);
}

/** Status-filter helper. Drops resolved rows. */
export function filterUnresolved(rows) {
  return rows.filter((r) => r.status !== 'resolved');
}
