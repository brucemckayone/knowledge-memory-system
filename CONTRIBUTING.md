# Contributing to the Mnemo Knowledge Memory System

This repo uses **beads** (`bd` CLI) for all task tracking — issues, dependencies, decisions, lessons. Run `bd prime` at the start of every session to load workflow context; `bd ready` shows what's unblocked; `bd show <id>` reads the locked fix spec for an issue.

PR workflow:

- Feature branches are cut **per-feature** from `feat/cognitive-platform-v1` (the main feature branch). Use the shape `bead/<id>-<short-title>` when the work is driven by a single bead; use `feat/<topic>` for larger work that spans multiple beads.
- One bead per commit-pair where practical: a code commit and a beads-close commit, in that order.
- Service infrastructure runs on host (platform + ml-services); only Postgres and Qdrant are dockerised. Run `make up` first, then `cd platform && pnpm dev` and `cd ml-services && make ml`.
- Architecture docs live in `docs/architecture/truth-graph/` and are read-before-write. The review/hardening cycle's structural lessons are in `31-review-cycle-synthesis.md`; implementation lessons accumulate in `33-implementation-lessons.md`.

---

## Feature integration checklist

Every new feature PR must walk through this checklist in the PR description (or the bead's `## Acceptance` section, when bead-driven). Each item is answered explicitly with **done** or **N/A — because…**. Items pointing at beads that haven't landed yet are temporarily marked N/A; the checklist becomes load-bearing as each cross-cutting bead (C1/C2/C3) closes.

The structural rationale for this checklist is in `docs/architecture/truth-graph/31-review-cycle-synthesis.md` §2.8 (T13 — half-built pipelines), §3 (cross-feature compose gaps G1/G2/G4/G5/G6/G8), and §4 C4 (this finding).

### 1. Service layer is the only writer — G2 / T13

- [ ] Any new DB write goes through `entities.ts` / `facts.ts` / `predicates.ts` / `causal.ts` / `audit.ts` / etc. in `platform/src/services/`. Never direct SQL from `pipeline.ts` or `index.ts`.
- **Theme:** G2 (service-layer bypass) / T13 (half-built pipeline).
- **Bead evidence:** `nmemo-2yv.15`, `.19`, `.29`, `.30`.

### 2. Auto-trigger registered — G4 / T12

- [ ] Every new compute has a row in `docs/architecture/truth-graph/32-compute-trigger-registry.md` (forward reference — see `nmemo-2yv.131` C2). Manual-only triggers must say so explicitly.
- **Theme:** G4 (auto-trigger absence) / T12 (missing auto-triggers).
- **Bead evidence:** `nmemo-2yv.61`, `.71`, `.72`, `.84`, `.85`, `.131`.

### 3. Pipeline / viz / MCP wires — T13

- [ ] Post-ingest features are wired from `pipeline.ts`.
- [ ] User-facing features have a viz panel that reads the new data.
- [ ] Agent-facing features register an MCP tool in `GRAPH_TOOLS`.
- [ ] Each connection point is named in the PR description.
- **Theme:** T13 (half-built pipeline) — the headline pattern this checklist exists to catch.
- **Bead evidence:** `nmemo-2yv.86`, `.103`, `.104`, `.124`, `.127`, `.128`.

### 4. `*_runs` audit table — G5

- [ ] New compute writes a `*_runs` row from **every** trigger path (post-ingest hook, scheduled, manual). Sibling features all have one (`graph_stats_runs`, `entity_topology_runs`, `hdbscan_runs`, `drift_runs`, `reconciliation_runs`, `reasoning_reports`, `gardening_reports`, `audit_log`). Don't ship without it.
- **Theme:** G5 (telemetry siblings).
- **Bead evidence:** `nmemo-2yv.92` (cross-cluster gap), `.67` (gardener trigger bypass).

### 5. Enum values in the SSOT — G6 / T11

- [ ] Any new CHECK constraint vocabulary, tool enum, or HTTP body union lives in `platform/src/services/enums.ts` (forward reference — see `nmemo-2yv.130` C1). Schema CHECK comments point at the constant.
- **Theme:** G6 (multi-writer with divergent scoring / vocabulary) / T11 (silent drift on enum-shape values).
- **Bead evidence:** `nmemo-2yv.27`, `.28`, `.39`, `.60`, `.69`, `.130`.

### 6. Cross-language strings match — G8 / T11

- [ ] Server names, port defaults, env-var keys, model identifiers, and tool names appear identically in TS (`platform/src/`) and Python (`ml-services/`). Cross-check by grepping the literal in both trees until a script enforces it.
- **Theme:** G8 (MCP / Pi transport drift) / T11 (silent drift on cross-language constants).
- **Bead evidence:** `nmemo-2yv.112`, `.125`, `.127`.

### 7. Health probe composed — G1

- [ ] New boundary modules (anything that talks to an out-of-process dependency: DB, vector store, ML service, MCP server, transport bridge) add their health check to the platform `/health` aggregator and follow the fail-safe `try { ... } catch { return false }` shape so the composite endpoint can `Promise.all` them.
- **Theme:** G1 (health composition).
- **Bead evidence:** `nmemo-2yv.111`, `.12` (the original dead-export trio: `ml.health`, `checkQdrantHealth`, `ensureCollections`).

### 8. Startup validator added — T11

- [ ] New boundaries register a validator in `platform/src/services/startup-validation.ts` (forward reference — see `nmemo-2yv.132` C3). Drifted config (embedding dimension, port collision, transport-selection mismatch) fails startup, not silently.
- **Theme:** T11 (silent drift) — closes the gap at boot, before drifted config corrupts data.
- **Bead evidence:** `nmemo-2yv.121` (Qdrant dim canary), `.132`.

---

## How to use this checklist in a PR

1. Copy the eight items into the PR description (or bead's notes).
2. For each item, answer **done** with the line/file reference, or **N/A — because…** with the reason. Acceptable N/A reasons include:
   - The forward-reference bead (C1/C2/C3) hasn't landed yet — item is structurally satisfied by the absence of the referenced infrastructure.
   - The feature is purely a delete (pure-deletion beads carry no integration surface).
   - The feature has no DB write / no compute / no boundary module — the relevant item doesn't apply.
3. A reviewer who can't trace each "done" to a concrete line or each "N/A" to a defensible reason can request changes.

The checklist is a **process gate**, not a CI lint. No bot enforces it. The cost of a missed item is a half-built pipeline in production; the cure is reading the list before clicking Merge.

---

## Cross-references

- `docs/architecture/truth-graph/31-review-cycle-synthesis.md` §2.8 (T13 inventory), §3 G1-G6/G8 (compose gaps with bead-level cures), §4 C4 (the structural rationale for this checklist).
- `docs/architecture/truth-graph/32-compute-trigger-registry.md` (canonical compute → trigger mapping; lands under `nmemo-2yv.131`).
- `docs/architecture/truth-graph/33-implementation-lessons.md` (per-bead implementation wisdom; updated by the `epic-cycle-implementation` skill).
- `platform/src/services/enums.ts` (vocabulary SSOT; lands under `nmemo-2yv.130`).
- `platform/src/services/startup-validation.ts` (boundary validators at boot; lands under `nmemo-2yv.132`).
