---
name: handover
description: Capture the current session's state into a durable repo-root HANDOVER.md so the next session (via /pickup) can resume cleanly. Invoke when the user runs /handover, says "hand off", "wrap up the session", "write a handover", or when a session is ending with work in flight. Records what changed, the loop/epic state, IN-FLIGHT and not-yet-verified work, the single next action, active traps, and a verification checklist. Points to the ledger + beads + git as the source of truth rather than duplicating them. Commits the result.
version: 0.1.0
---

# handover

Write `HANDOVER.md` at the repo root so a fresh session can pick up with `/pickup`. This is the
session-transient **glue** — the authoritative record lives in the experiment ledger, beads, and git
history; the handover points to them and adds only what those do not capture: in-flight work,
uncommitted state, pre-adversary results, background agents that must be re-run, and open decisions.

**Core rule: never overstate.** A result is only "banked" if it has passed a blind adversary and been
committed as such. Anything run-but-not-reviewed is IN-FLIGHT, not done. If a fact is unknown, mark it
`UNKNOWN`; never invent state. This mirrors the project's discipline (`00-consolidated-keep-list.md` §2.6,
`feedback_verify_empirical_gates`).

## Invocation

| Command | Behaviour |
|---|---|
| `/handover` | Gather state, write + commit `HANDOVER.md` |
| `/handover --no-commit` | Write `HANDOVER.md` but do not commit (leave staged for review) |

Args parse from `$ARGUMENTS`.

## Protocol

### 1. Gather state (read-only first)
Run these and read the output — do not trust memory of them:
- `git branch --show-current`; `git log --oneline -20 | cat`; `git status --short`.
- `git merge-base` note only if the branch's base is in question (CLAUDE.md has been wrong before).
- Active epic + work items: `bd ready` and `bd list --parent <active-epic-id>` (the current epic is named
  in the ledger / CLAUDE.md CURRENT DIRECTION — currently `nmemo-u8j`). Note in-progress vs open.
- Read the **loop-state** section at the top of the active ledger
  (`docs/architecture/single-graph/09-experiment-ledger.md`) — copy its current numbers, don't paraphrase
  from memory.
- Infra snapshot (quick, record up/down, do not fix here): `docker ps` (postgres :5433, qdrant :6335),
  `curl -s -m4 http://localhost:8000/health`, `curl -s -m4 http://localhost:11434/api/tags`.
- Substrate sanity if relevant: entity/fact counts for the active corpora
  (`docker exec nmemo-postgres-1 psql -U cognitive -d cognitive_test -tAc "..."`).

### 2. Determine IN-FLIGHT items honestly
Classify anything not cleanly banked:
- A **prereg committed but the experiment not yet run**.
- An **experiment run but no blind adversary yet**, or results committed with a "pre-adversary" message.
- **Uncommitted / untracked files** (from `git status`) — list them and say whether they matter.
- **Background agents / subagents** that were mid-flight: their output does NOT survive the session —
  record their purpose and that they must be **re-launched**, never assume a result.
- **Open user-decisions** the session surfaced and the user has not answered.
- Any **regenerable-but-gitignored** artifact the next run depends on (e.g. embed caches).

### 3. Write `HANDOVER.md` (repo root), overwriting, with exactly these sections
```
# HANDOVER — <ISO date/time> · branch <branch> · HEAD <short-sha>

## Source of truth (read these, in order)
- Ledger: docs/architecture/single-graph/09-experiment-ledger.md  (loop state + per-experiment rows)
- Epic: <bd epic id> — `bd show <id>`, `bd ready`
- Direction: CLAUDE.md "CURRENT DIRECTION"
- Memory: <memory files of note>

## What changed this session
- <1-line bullets, each citing a commit sha or bead id>

## Loop / epic state (verbatim from the ledger)
- <consecutive-tie count, stop-condition status, ready beads, blocked-by edges>

## IN-FLIGHT — not yet verified/banked  (THE section /pickup must reconcile)
- <pre-adversary results / prereg-without-run / interrupted work>
- <background agents that must be RE-RUN (result is gone)>
- <uncommitted or untracked files: paths + whether they matter>
- <open user-decisions awaiting an answer>

## Next action
- THE one obvious next step, as a concrete command or bead id.
- Alternatives (ranked), if the user may want to redirect.

## Active traps (right now)
- Infra: <postgres/ollama/ml up|down>, branch, substrate row counts.
- Standing repo traps still live: tsc baseline (69 errors — compare, don't "fix"); `index.ts` NUL-byte
  (use `grep -a`); `rawQuery` snake→camel rewrite; absolute R@10 tie-break sensitivity (measure deltas);
  never run an integration suite against cognitive_test during an ingest.

## Verification checklist for /pickup
- [ ] branch == <branch>, HEAD == <sha> (else commits landed since — reconcile)
- [ ] infra up (postgres/ollama/ml) as recorded
- [ ] substrate row counts match
- [ ] each IN-FLIGHT item still true; re-launch any named background agent
- [ ] any file/flag/function named above still exists
```

### 4. Commit
Unless `--no-commit`: `git add HANDOVER.md && git commit` with a plain message
(`docs(handover): session state <date>`). **No AI attribution** (`feedback_no_coauthor`). If other work
is uncommitted, do NOT sweep it into this commit — commit only `HANDOVER.md`, and list the rest under
IN-FLIGHT so the next session decides.

### 5. Report
One short paragraph to the user: where things stand and the single next action. Do not restate the whole
file.

## Notes
- Keep `HANDOVER.md` a single current-state file; its git history is the trail (do not append dated
  sections).
- If a loaded skill or the ledger names a different active tree/epic than the defaults above, use those —
  read the ledger's own pointers rather than hard-coding.
