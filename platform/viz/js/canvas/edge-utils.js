// Shared helpers for working with edge/link endpoints in the viz canvas.

// Normalise a d3 link endpoint to its node id. A link's source/target is a
// string id when the data is freshly fetched, but d3.forceLink rewrites it to
// the resolved node object once the simulation runs — so call sites that read
// an endpoint id must handle both. The `v &&` guard keeps this null-safe
// (a null/undefined endpoint returns as-is instead of throwing on `.id`).
// Single definition for forces.js, render.js, and focus.js (bead nmemo-pd5.10).
export function edgeEndpoint(v) {
  return (v && typeof v === 'object') ? v.id : v;
}
