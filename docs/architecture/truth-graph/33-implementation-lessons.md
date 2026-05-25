# Implementation lessons learned

Per-bead and cross-bead wisdom accumulated during the implementation phase of the **May 2026 review/hardening cycle** (epic `nmemo-2yv`).

The review cycle (`docs/architecture/truth-graph/31-review-cycle-synthesis.md`) produced 120 findings across 13 feature reviews + 1 cross-feature synthesis. Each finding's `## Decision (locked YYYY-MM-DD)` section is the locked spec; the `epic-cycle-implementation` skill drives those decisions into the codebase one bead at a time. This file accumulates the lessons that emerge during implementation — patterns that hold across beads, surprises worth flagging, conventions that crystallise as the cycle progresses.

**Cross-references:**
- Doc 31 §2 — theme inventory (T1/T7/T8/T9/T10/T11/T12/T13 + transport divergence).
- Doc 31 §5 — prioritised landing roadmap.
- `~/.claude/skills/epic-cycle-implementation/SKILL.md` — the orchestrator skill that appends to this file.

**Entry format:**

```markdown
## YYYY-MM-DD

### nmemo-2yv.<N> — <one-line title>

- **Lesson:** <the durable insight, written so a future reader can apply it without context>.
- **Surprise:** (optional) <what tripped us up — usually a doc-vs-code drift, a tool quirk, a Windows-isms issue>.
- **Pattern noted:** (optional) <a pattern this bead is an instance of, with pointers to related beads / themes>.
```

One **Lesson** per entry is mandatory. **Surprise** and **Pattern noted** are surfaced only when they carry forward.

Cross-project gotchas (anything that isn't Mnemo-specific) also go to `bd remember "<one-liner>"` for `bd memories <keyword>` retrieval.

---

<!-- Entries below this line, newest at the bottom. -->

## 2026-05-25

### nmemo-2yv.123 — /api/mcp-health probe retargeted to graph-mcp.ts

- **Lesson:** When two callers share a piece of resolved config (here: a filesystem path), extracting a single resolver that both routes through is the cheap way to make drift a compile-time error. The probe and the per-actor MCP config writer now both call `getGraphMcpScriptPath()`; future changes to where `graph-mcp.ts` lives must update one place. The pattern is worth applying any time a "production config writer" and an "observability probe" of that same production thing diverge.
- **Surprise:** The bead's `## Result` section claimed `src/index.ts` was the only consumer of `checkCausalMcpHealth`, but `grep` turned up two more active call sites — `scripts/smoke-mcp-tools.ts` and `src/test/harness/causal-integration.test.ts`. The bead's `## Acceptance` was stricter ("old name no longer exists in the codebase"), so all three had to be renamed. **Implication:** always grep the symbol myself before relying on the bead's narrative inventory. The Acceptance section is the contract; the Result section is a snapshot that may have aged.
- **Pattern noted:** Renaming a function name that embeds a stale concept (here: `Causal` when the production server is the unified `graph` server) sweeps cleaner if done in the same diff as the underlying retarget — leaving the rename for "later" entrenches the wrong identity at every call site. This pairs with the bead's `## Decision` rejection of shape (a) "one-line retarget only" for exactly the same reason.
