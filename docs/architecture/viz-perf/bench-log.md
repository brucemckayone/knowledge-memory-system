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
| 2026-08-25T09:18Z | SVG (24da355) | full (1500) warm | 12.0 | 7.5 | >15000 (no settle) | 34 | 1845 | 113 | **FAIL** — 1314/1314 value nodes undrawn |
| 2026-08-25T09:18Z | SVG (24da355) | default (600) warm | 29.9 | 15.0 | >15000 (no settle) | 22 | 1023 | 21 | **FAIL** — 663/663 value nodes undrawn |
| 2026-08-25T09:05Z | SVG (24da355) | full (1500) cold | 1 | 1 | >15000 (no settle) | 34 | 1845 | 10 | (first-load, pre-warm) |

### Baseline notes (SVG, commit 24da355)

- **Warm sustained: 12 FPS full / 30 FPS default. Cold first-load: ~1 FPS.**
  The metric is *sustained* FPS, so the warm number (2s warm-up discarded, then
  a 10s window with the sim held hot) is the fair figure to beat. The ~1 FPS
  cold reading is real too — it is the first-load freeze the user reported,
  where thousands of new SVG elements are laid out for the first time.
- Neither workload settles within 15s; both miss every FPS bar (need 30 full /
  50 default) and the 5s settle bar.

### Canvas 2D renderer (commit pending)

Moved the high-count bulk (entity/value/causalEvent nodes; fact/causal/anchor
edges; fact + entity labels; arrowheads) off SVG onto a `<canvas>` drawn in
immediate mode each tick (`canvas.js`). The low-count / off-by-default layers
(source, merge, sameAs) and the decorative overlays stay on the SVG that sits
above the canvas; both share one pan/zoom transform. Node interactions
(hover / click / drag / dblclick / focus) are ported to a d3.quadtree hit-test.

Measured under the **default** force config (sameAsFusion + causalRadial only;
the earlier localStorage had all six forces — incl. O(N^2) predicate affinity —
on, which is not the shipping default). Warm 10s window, sim held hot.

| workload | median FPS | p5 FPS | avg FPS | settle ms | long tasks | invariant |
|---|---|---|---|---|---|---|
| full (1500) | 59.9 | 29.9 | 47.6 | 5129 / 5087 | 0 | **PASS** — 3044 nodes / 3370 edges drawn == payload |
| default (600) | 59.9 | 59.5 | 60.0 | (well under) | 0 | **PASS** — 1763 nodes / 1725 edges drawn == payload |

- Primary metric (median FPS): full 12 -> 59.9, default 30 -> 60. Long tasks
  113 -> 0.
- **Invariant now holds** (canvas draw-count == payload): the 1314/663 value
  nodes the SVG renderer wiped are drawn, verified via `getDrawCounts()`.
- Bar status: #1 FPS full PASS, #3 FPS default PASS, #4 invariant PASS.
  **#2 settle just misses at ~5.1s** (the d3 cooling schedule is ~247 ticks;
  even at 60 FPS median the cold early frames push wall-clock past 5s). Next
  change: tune the settle threshold.

### alphaDecay 0.0228 -> 0.035 (settle fix)

Faster cooling schedule: ~247 ticks to rest -> ~160. Full workload, default
forces, reheat settle x3 + warm 10s FPS window:

| metric | before (0.0228) | after (0.035) |
|---|---|---|
| settle ms (full) | 5129 / 5087 | 3351 / 3354 / 3386 |
| median FPS (full) | 59.9 | 56.5 |
| p5 FPS (full) | 29.9 | 28.1 |
| invariant | PASS | PASS (3044 / 3370) |

Settle now comfortably under the 5s bar; FPS unchanged within noise (>>30). No
effect on drawn counts.

## Final verification — 3 consecutive runs (canvas + alphaDecay 0.035)

Each run: fresh navigate to the full workload (FPS + settle + invariant), then
fresh navigate to the default workload (FPS + invariant). Default force config
(sameAsFusion + causalRadial). Warm 10s FPS window, sim held hot; settle is a
reheat from alpha 0.3 to alphaMin. Drawn counts from `getDrawCounts()`.

| run | full median FPS (>=30) | full p5 | full settle ms (<=5000) | default median FPS (>=50) | default p5 | long tasks | invariant |
|---|---|---|---|---|---|---|---|
| 1 | 57.1 | 28.5 | 3229 | 56.8 | 54.9 | 0 | PASS |
| 2 | 56.8 | 28.2 | 3294 | 56.8 | 54.3 | 0 | PASS |
| 3 | 56.5 | 28.2 | 3246 | 59.9 | 59.5 | 0 | PASS |

Invariant every run: full drawn 3044 nodes / 3370 edges == payload; default
drawn 1763 / 1725 == payload. All four bar criteria hold on all 3 runs.

**Bar status: PASS on 3 consecutive runs.**
1. median FPS >= 30 full: 57.1 / 56.8 / 56.5 — PASS
2. time-to-settle <= 5000ms full: 3229 / 3294 / 3246 — PASS
3. default view >= 50 FPS: 56.8 / 56.8 / 59.9 — PASS
4. invariant (drawn == payload): PASS every run

Interactivity re-verified on the canvas hit-test: hover -> tooltip, click ->
select + detail panel open (entity "extrinsic hallucination", synthetic
pointer/click at its screen position).

### Notes / limitations

- FPS is measured in Playwright (Chromium) with the simulation held hot — the
  worst case, and the state that froze. A settled static graph idles at the
  display cap; the hot-sim number is the honest sustained figure.
- The decorative overlays (topology rings/halos, cluster hulls, ghosts,
  contradictions, bridges) still render on the SVG layer above the canvas. They
  are off/empty by default and not on the bar; when toggled on they draw on top
  of the canvas (correct for rings/ghosts/bridges; hulls read as translucent
  overlays rather than underlays). Not a perf regression — the default/bar view
  has no overlay elements, so the per-tick SVG sync is a no-op there.
- The `?limit=` cap is the server's existing entity cap (degree-ordered, so the
  connected core survives). It is a data-fetch bound, not a render cull: the
  canvas draws 100% of whatever the payload contains.
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
