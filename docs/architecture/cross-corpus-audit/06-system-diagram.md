# System Diagram — Cross-Corpus Architecture (high level)

Reflects the **hardened** design (`04-hardened-spec.md` + `05-preconditions.md`). Legend: **indigo** = fixed core (exists) · **orange** = built in v1 · **grey dashed** = deferred (Phase B/C) · **green** = store · **red** = non-authoritative / risk.

## 1. Layered system

```d2
direction: down
classes: {
  core:     { style: { fill: "#eef2ff"; stroke: "#4f46e5"; stroke-width: 2 } }
  v1:       { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
  deferred: { style: { fill: "#f4f4f5"; stroke: "#a1a1aa"; stroke-dash: 4 } }
  store:    { style: { fill: "#ecfdf5"; stroke: "#059669" } }
  risk:     { style: { fill: "#fee2e2"; stroke: "#dc2626" } }
}

usecases: {
  label: Use cases (declared as plugins)
  class: deferred
  cc:  { label: Cross-corpus compliance (v1); class: v1 }
  fic: { label: Fiction (later); class: deferred }
  res: { label: Research (later); class: deferred }
}

integration: {
  label: Integration / control layer
  mcp:    { label: MCP surface, ~8 tools (Phase B); class: deferred }
  preset: { label: Corpus policy preset (assimilating | comparative); class: v1 }
}

boundaries: {
  label: Composition boundaries (the primitive layer)
  reg: { label: Pass registry (Phase B); class: deferred }
  voc: { label: Edge-rule vocabulary (Phase B); class: deferred }
}

core: {
  label: Fixed neutral core (unchanged)
  class: core
  ing: { label: Ingest — store, extract, promote }
  wr:  { label: Single-writer promote + actor allowlist (staging only) }
}

feature: {
  label: Cross-corpus additions (v1)
  class: v1
  scope:  { label: Corpus scoping — corpus_id + 4 fusion guards }
  bridge: { label: bridge_edges family (reuses causal-edge pattern) }
  elem:   { label: Element catalogs code/rule + element_ref uuidV5 (NOT entities) }
  emb:    { label: Dedicated embedding table (E1 recall substrate) }
}

stores: {
  label: Stores
  pg:  { label: Postgres — SOURCE OF TRUTH; class: store; shape: cylinder }
  qd:  { label: Qdrant — source text; class: store; shape: cylinder }
  age: { label: AGE — hint-index only, non-authoritative; class: risk; shape: cylinder }
}

usecases   -> integration: configure
integration -> boundaries: select passes / rules
boundaries -> core: compose at the edges
core       -> feature: v1 extends (never reshapes)
feature    -> stores: writes
core       -> stores: reads / writes
```

## 2. Build phases

```d2
direction: right
classes: {
  gate:     { style: { fill: "#fef9c3"; stroke: "#ca8a04"; stroke-width: 2 } }
  v1:       { style: { fill: "#fff7ed"; stroke: "#ea580c"; stroke-width: 2 } }
  deferred: { style: { fill: "#f4f4f5"; stroke: "#a1a1aa"; stroke-dash: 4 } }
}

p0: { label: Phase 0 — substrate readiness (1 fix + 2 verifies + audit) }
e1: { label: E1 recall gate (schema-less, parallel); class: gate }
pa: { label: Phase A — corpus_id + guards + bridge_edges, hand-seeded; class: v1 }
pb: { label: Phase B — registry + edge-rule vocab + MCP + coverage; class: deferred }
pc: { label: Phase C — external code graph + consistency model; class: deferred }

p0 -> pa: exit criteria met
e1 -> pa: recall >= 0.65
pa -> pb
pb -> pc
```

## 3. How to read it

- **The core never changes per use case.** Composition happens at the two boundaries (passes, edge-rules) — both deferred to Phase B and extracted from two real instances, not guessed from one.
- **v1 (orange) is deliberately thin:** corpus scoping + the `bridge_edges` family + bare element catalogs + an embedding table for the E1 recall bet. Everything else is deferred.
- **Postgres is the source of truth; AGE is a non-authoritative hint-index** (red) — no fusion or verdict decision is ever taken from an AGE traversal.
- **Two gates guard v1:** Phase 0 exit criteria (substrate ready) and the E1 recall bar (≥0.65@5), which runs in parallel because it needs no schema.
