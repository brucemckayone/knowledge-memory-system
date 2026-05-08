// Shared deterministic palette for component / community / cluster coloring.
// Index 0 always lands on PALETTE[0]; isolates / noise → grey.

export const PALETTE = [
  '#4a90d9', '#27ae60', '#e67e22', '#9b59b6', '#1abc9c', '#e74c3c',
  '#f0883e', '#d29922', '#58a6ff', '#3fb950', '#bc8cff', '#ff7b72',
  '#79c0ff', '#56d364', '#d2a8ff', '#ffa657', '#a5d6ff', '#7ee787',
  '#ffab70', '#f97583', '#b392f0', '#85e89d', '#9ecbff', '#f1e05a',
];

export const ISOLATE_GREY = '#3d4047';

export function paletteFor(idx) {
  if (idx == null) return ISOLATE_GREY;
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}
