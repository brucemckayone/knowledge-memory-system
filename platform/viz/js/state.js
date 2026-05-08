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
  colorMode: 'type',         // 'type' | 'component' | 'community'
  centralityMetric: 'pagerank', // 'pagerank' | 'betweenness'
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
