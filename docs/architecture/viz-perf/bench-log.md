# Viz render-performance bench log

Benchmark for the Mnemo graph visualizer render loop. Goal: median sustained
FPS >= 30 at the full workload, time-to-settle <= 5000ms there, and the default
view >= 50 FPS, without ever drawing fewer nodes/edges than the API payload.

## Method

- **Server:** `http://127.0.0.1:3001/viz`, corpus `arxiv-nlp`.
- **Full workload:** `?corpus=arxiv-nlp&limit=1500` -> 3,052 payload nodes
  (1230 entity / 1314 value / 500 causalEvent / 8 sourceMemory) and 3,370 edges
  (2862 fact / 500 causalAnchor / 8 causal). Default layers hide `source` and
  `merge`, so the drawn target is 3,044 nodes + 3,370 edges.
- **Default workload:** `?corpus=arxiv-nlp&limit=600` -> 1,771 payload nodes
  (600 entity / 663 value / 500 causalEvent / 8 sourceMemory), 1,725 edges.
  Drawn target 1,763 nodes + 1,725 edges.
- **Probe:** `window.__vizPerf` (inline in `index.html`) — a rAF frame-timing
  probe + a `longtask` PerformanceObserver. Zero cost until `.start()`.
- **FPS metric:** the simulation is held hot (`alphaTarget(0.3).restart()`) so
  ticks — and therefore renders — run continuously for a 10s window. A *settled*
  static graph idles at 60fps and measures nothing; the freeze is under active
  simulation, so that is what we measure. Pollers are stopped first
  (`__mnemo.stopAll()`) to keep a 5s refetch from re-seeding mid-window.
- **time-to-settle:** wall-clock from `alpha(0.3).restart()` until
  `alpha() <= alphaMin` (d3 default 0.001, ~247 ticks). Capped at 15s in the
  harness; ">15000 (did not settle)" means the cap was hit.
- **Invariant check:** drawn DOM elements per group (via `__mnemo.state.refs.groups`)
  compared against the API **payload** counts, never against a post-cull set.
- **Env:** Playwright MCP (Chromium), Windows 11. API latency / payload KB from
  `curl` against the same URL.

## Results

| timestamp | render | workload | median FPS | p5 FPS | settle ms | API ms | payload KB | long tasks | invariant |
|---|---|---|---|---|---|---|---|---|---|
| 2026-08-25T09:05Z | SVG (24da355) | full (1500) | 1 | 1 | >15000 (no settle) | 34 | 1845 | 10/10 frames | **FAIL** — 1314/1314 value nodes undrawn |
| 2026-08-25T09:05Z | SVG (24da355) | default (600) | 1 | 1 | >15000 (no settle) | 22 | 1023 | 9/9 frames | **FAIL** — 663/663 value nodes undrawn |

### Baseline notes (SVG, commit 24da355)

- **~1 FPS at both workloads under active simulation.** Confirms the reported
  freeze. Each tick takes ~900ms.
- **The bottleneck is SVG paint, not JS.** Profiled in-page: the entire per-tick
  attribute write (edge x1/y1/x2/y2 + label x/y + node transform over
  1725+1280+1100 elements) is **6.3ms**. The remaining ~890ms/frame is the
  browser's style-recalc + layout + paint of thousands of SVG elements
  (per-edge `marker-end` arrows and per-edge text are the worst offenders).
  This is inherent to SVG; no JS micro-optimization closes a 900ms -> 16ms gap.
  A 30 FPS bar needs a **canvas 2D renderer**.
- **Settle is gated by tick cost.** ~247 ticks to cool from alpha 0.3 to 0.001;
  at ~1 FPS that is ~200s. The 5s settle bar therefore needs ~50 FPS during
  active simulation — a harder constraint than the 30 FPS sustained bar.
- **Pre-existing invariant violation (not introduced here).** `render.js` calls
  `renderNodes(groups.entityNodes, values)` then `renderNodes(groups.entityNodes, entities)`.
  The second call's `selectAll('g.node').data(entities)` sends every value node
  to `exit().remove()`, so **all value nodes are wiped** and their fact edges
  dangle to invisible points. Drawn nodes < payload. The replacement renderer
  must draw the full payload (values included).
