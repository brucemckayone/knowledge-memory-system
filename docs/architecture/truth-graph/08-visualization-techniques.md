# Visualization Techniques — Research Notes

**Status:** Research / future reference
**Date:** 2026-04-14

Notes from brainstorming session on visualization approaches for temporal knowledge graphs. Everything here is for reference — not implementation plans.

---

## Temporal

### Growth Rings
Entity nodes have concentric rings showing when facts were added — like tree rings. Well-established entities have thick rings, new entities have a single thin ring. Communicates entity maturity and temporal depth at a glance.

### Timeline Scrubber
Slider filtering the graph to "what was true at time T". Uses `created_at`/`expired_at` on facts and `occurred_at` on causal events to reconstruct historical graph state.

### Temporal Heatmap
Nodes/edges colored by age. Recent = bright, old = faded. Shows where activity is concentrated.

### Small Multiples
N snapshots side by side at key moments. Better for reports than interactive use.

---

## Structural

### Hierarchical/Tree Layout
Family trees (parent_of, child_of chains) rendered as trees rather than force-directed. Auto-detect tree-like subgraphs.

### Adaptive Structure by Relationship Type
Different relationship types could use different physical layouts: family → tree, geographic → spatial, communication → sequence, causal → DAG. Challenge is mixing layout algorithms on one canvas.

### Arc Diagram
Entities on a line, arcs showing relationships. Cleaner than force layout for dense graphs.

### Bipartite Layout
Entities on one side, source memories on the other. Shows extraction coverage.

---

## Analytical

### Entity Comparison
Select two entities, see facts/sources/causal histories side-by-side. Essential for merge candidate review.

### Provenance Waterfall
For a single fact, show the full chain: source text → extraction → fact → causal event → causal edge. Pipeline debug view.

### Confidence Distribution
Histogram of confidence scores across the graph.

### Cluster Map
Group entities by source culture (graph meta clusters). Cross-cluster edges show connections between domains.

---

## Causal-Specific

### DAG Layout
Causal events as a directed acyclic graph, top-to-bottom. Time flows downward. Much clearer than force-directed for causal chains. Could be a toggle: "Force" vs "DAG".

### Causal Cone
For a selected event, show everything it caused (forward) and everything that caused it (backward). Like a light cone in physics.

### Sankey/Flow Diagram
Causal chains as flows, width = strength. Shows how causes ripple through the graph.

---

## Interactive/Exploratory

### Semantic Zoom
Low zoom: entities only. Zoom in: causal events, sources, merge candidates appear progressively.

### Fisheye Distortion
Mouse magnifies nearby nodes, compresses distant ones. D3 has a plugin for this.

### Path Finder
Select two entities, show all paths between them through facts and causal edges.

### Query Builder
Natural language questions that highlight answer subgraphs. Could use the existing MCP agent tools via a chat interface.
