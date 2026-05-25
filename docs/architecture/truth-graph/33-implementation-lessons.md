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

### nmemo-2yv.60 — resolve_candidate enum / merge_candidates CHECK alignment (T7 naming mismatch)

- **Lesson:** When a CHECK constraint enumerates vocabulary that other layers (tool schemas, agent prompts, table names) also enumerate, a divergence is silent and total — every write of the new value hits the CHECK and fails on the close path, while the upstream side-effect (here: the same_as_links row) lands via a different write path. The bug only surfaces if you check the candidate row's *post-resolution* status rather than the link table. This is a generalisable test-design lesson: when a pipeline writes to two tables and an error in one is recoverable into the other, end-to-end tests must assert *both* terminal states, not just the visible one.
- **Surprise:** The bead's Scoped fix had three steps but the third ("integration test against the DB write path") was the one carrying the regression-guard value. Steps 1 + 2 (migration + grep-for-readers) could have been done blindly with low-confidence safety; step 3 is what locks down the contract. The instinct to land migrations without an exercising test would have allowed a future revert of the CHECK to slip through unnoticed.
- **Pattern noted:** Doc 27 §2.2 already discusses 'same_as' as a training-label vocabulary. The schema CHECK in 003 predates that discussion. Whenever a vocabulary discussion lands in a design doc, run `grep "CHECK.*IN (" platform/src/db/migrations/*.sql` against the new vocabulary to detect drift early. Future work: vocabulary-alignment pass before reasoning_reports (per the bead's "Future direction" note).

### nmemo-2yv.112 — Pi bridge port default 3001 → 3099

- **Lesson:** When a bead's Scoped fix lists multiple edits and one of them is incompatible with the project's actual dev environment, prefer the smallest faithful change that satisfies the bead's *acceptance* over a literal application that introduces a regression. Here the bead asked for `"bridge": "PI_BRIDGE_PORT=3099 tsx src/services/pi-agent-bridge.ts"` in `package.json`, but inline `KEY=value cmd` syntax doesn't work in Windows cmd/PowerShell (the user's primary shell per CLAUDE.md), so `npm run bridge` would have regressed. Skipping that step was the right call because the code-default change at `pi-agent-bridge.ts:38` already satisfies the actual acceptance bullet ("npm run bridge starts the bridge on 3099 with no extra env setup needed"). Always check the bead's *acceptance contract* vs the *implementation list* — the former is the binding spec.
- **Surprise:** Bullet 5 said "deleting ml-services/.env and running make bridge + make ml works (llm.py picks up the 3099 code default)" — but deleting `.env` also strips `LLM_PROVIDER=pi`, which makes `LLM_PROVIDER` default to `claude`, which means `PiBridgeProvider` is never instantiated and the bridge-URL default never gets exercised. The bullet as literally written passes vacuously. To honour the bullet's *intent* (verify the code default), unset `PI_BRIDGE_URL` while keeping `LLM_PROVIDER=pi` and instantiate `PiBridgeProvider` directly.
- **Pattern noted:** Bullet 6 ("Port table in doc 29") referenced a doc owned by a separate bead (`.110`). This is a recurring shape in this review cycle — beads sometimes carry forward dependencies that can't be satisfied at their own implementation time. The skill should treat such bullets as "deferred to the owning bead" rather than halting acceptance.

### nmemo-2yv.123 — /api/mcp-health probe retargeted to graph-mcp.ts

- **Lesson:** When two callers share a piece of resolved config (here: a filesystem path), extracting a single resolver that both routes through is the cheap way to make drift a compile-time error. The probe and the per-actor MCP config writer now both call `getGraphMcpScriptPath()`; future changes to where `graph-mcp.ts` lives must update one place. The pattern is worth applying any time a "production config writer" and an "observability probe" of that same production thing diverge.
- **Surprise:** The bead's `## Result` section claimed `src/index.ts` was the only consumer of `checkCausalMcpHealth`, but `grep` turned up two more active call sites — `scripts/smoke-mcp-tools.ts` and `src/test/harness/causal-integration.test.ts`. The bead's `## Acceptance` was stricter ("old name no longer exists in the codebase"), so all three had to be renamed. **Implication:** always grep the symbol myself before relying on the bead's narrative inventory. The Acceptance section is the contract; the Result section is a snapshot that may have aged.
- **Pattern noted:** Renaming a function name that embeds a stale concept (here: `Causal` when the production server is the unified `graph` server) sweeps cleaner if done in the same diff as the underlying retarget — leaving the rename for "later" entrenches the wrong identity at every call site. This pairs with the bead's `## Decision` rejection of shape (a) "one-line retarget only" for exactly the same reason.
