// Shared mutable state for the viz. Modules read/write through this singleton
// so cross-module updates remain visible without ES-module live-binding quirks.
export const state = {
  data: { nodes: [], edges: [] },
  layers: {
    fact: true,
    causal: true,
    source: false,
    merge: false,
    sameAs: true,
    contradictions: true,
  },
  selectedId: null,
  focusedEntityId: null,
  layoutMode: 'force',
  scrubberTime: null,
  timeRange: { min: null, max: null },
  tooltipPinned: false,
  tooltipPinnedNode: null,
  refreshTimer: null,
  contradictions: [],
  // viz.2 — topology (Phase 2)
  topology: {
    entities: {},   // entityId → { componentId, kCore, isArticulationPoint, communityId, pagerank, betweennessSampled, predicateSignature, ... }
    bridges: [],    // [{ sourceEntityId, targetEntityId, factId, sameAsLinkId }]
    loaded: false,
  },
  colorMode: 'type',         // 'type' | 'component' | 'community' | 'cluster'
  centralityMetric: 'pagerank', // 'pagerank' | 'betweenness'
  // viz.3 — clusters (Phase 3.1)
  clusters: {
    entities: {},   // entityId → { clusterId, clusterProbability, clusterSize }
    summary: {},    // clusterId (string) → size
    noiseCount: 0,
    clusterCount: 0,
    loaded: false,
  },
  showClusterHulls: false,
  // Staging overlay (live pre-promote view). When on, fetchData merges the
  // current epoch's staged proposals (from /api/viz/staging) into state.data,
  // flagged `_staged` so render.js styles them amber/dashed. stagingMeta holds
  // the latest counts for the toggle label.
  showStaging: false,
  stagingMeta: null,
  // viz.4 — unified merge candidates (bead nmemo-2yv.47 — subsumes legacy
  // cross-cluster panel). mergeCandidatesSourceFilter is one of the keys in
  // panels/merge-candidates.js:SOURCE_FILTERS ('all' default).
  mergeCandidates: [],
  mergeCandidatesSourceFilter: 'all',
  // viz.5 — pattern lifecycle filter + per-entity ghosts
  patternStatusFilter: ['staging', 'candidate', 'provisional', 'canonical'], // 'rejected' off by default
  ghostsByEntity: {}, // entityId → Ghost[]   (lazy-loaded on detail open)
  // Reasoning reports debug panel (bead nmemo-2yv.81). Mode filter chip ID,
  // and a toggle for the per-entity filter that activates when the canvas
  // has a focused entity.
  reasoningReportsModeFilter: 'all',
  reasoningReportsEntityFilterEnabled: false,
  // Force-layout experimentation flags (epic nmemo-pd5). Each flag toggles a
  // single force module in canvas/forces.js. Defaults: clear visual wins ON
  // (sameAsFusion fuses unresolved identity pairs; causalRadial replaces the
  // porcupine layout with geometric placement); experimental ones OFF until
  // confirmed visually. Subsequent beads in the epic plug their force into
  // applyForces() keyed on the matching flag.
  forces: {
    sameAsFusion: true,
    clusterCentroid: false,
    articulationPins: false,
    centralityRadial: false,
    predicateAffinity: false,
    causalRadial: true,
  },
  // Precomputed predicate-affinity pseudo-links (bead nmemo-pd5.6). Rebuilt
  // once per fetchData() (O(N²) Jaccard over fact-predicate signatures — too
  // expensive per tick), cached here, and merged into the link force by
  // applyForces() when state.forces.predicateAffinity is ON. Entries are
  // { source, target, similarity, _edgeType:'predicateAffinity', id } with
  // string-id endpoints — never handed to d3 directly (applyForces clones
  // them first, since d3.forceLink rewrites source/target to node objects).
  predicateAffinityLinks: [],
  refs: {
    svg: null,
    g: null,
    simulation: null,
    groups: {},
  },
};

export const COLOR_ENTITY = {
  person: '#4a90d9', company: '#27ae60', project: '#e67e22',
  concept: '#9b59b6', place: '#1abc9c', event: '#e74c3c',
  other: '#95a5a6',
};

export const COLOR_TRANSITION = {
  created: '#27ae60', strengthened: '#4a90d9', weakened: '#e67e22',
  expired: '#95a5a6', invalidated: '#e74c3c',
};

export const COLOR_MERGE = '#d29922';
