---
name: pickup
description: Resume work in a fresh session by reading the repo-root HANDOVER.md (written by /handover) and VERIFYING it against live reality before trusting it. Invoke when the user runs /pickup, says "pick up where we left off", "resume the session", "what were we doing", or at the start of a session continuing prior work. Reconciles the handover against git/beads/infra, flags every stale claim, re-surfaces open decisions and any background agents that must be re-run, and proposes the next action — without starting work unless told to.
version: 0.1.0
---

# pickup

Re-hydrate context from `HANDOVER.md` and the source-of-truth artifacts, then **verify before trusting**.
A handover records what was true when it was written; this session must confirm it still holds. This is
the project's core discipline applied to session state: disbelieve a clean claim until a concrete check
passes (`feedback_verify_empirical_gates`, `feedback_verify_tasks`).

## Invocation

| Command | Behaviour |
|---|---|
| `/pickup` | Read + verify + orient + propose next action; then STOP and await direction |
| `/pickup --go` | Same, then begin the proposed next action if verification is clean and it needs no decision |

Args parse from `$ARGUMENTS`.

## Protocol

### 1. Read the record (source of truth first)
- `HANDOVER.md` at repo root. If absent, say so and fall back to: the active ledger loop-state
  (`docs/architecture/single-graph/09-experiment-ledger.md`), CLAUDE.md CURRENT DIRECTION, `bd ready`.
- The pointers the handover names (ledger, epic, memory). Read the ledger's own loop-state — it, not the
  handover's paraphrase, is authoritative on experiment results.

### 2. VERIFY against live reality — this is the point of the skill
For each claim, run the check and label it `OK` / `STALE` / `UNKNOWN`. Do not proceed on an unverified
claim.
- **Branch + HEAD:** `git branch --show-current`, `git log --oneline -5 | cat`, `git status --short`.
  If HEAD moved past the handover's sha, commits landed since — read them; the handover is behind.
  If there are uncommitted/untracked files not in the handover's IN-FLIGHT list, flag them.
- **Infra:** `docker ps` (postgres :5433, qdrant :6335), `curl -s -m4 localhost:8000/health`,
  `curl -s -m4 localhost:11434/api/tags`. Anything the next step needs that is down → flag, offer to
  start it (Ollama via `Ollama.exe serve`, ML via uvicorn, docker via `make up`), do not silently assume.
- **Substrate:** if the next step measures retrieval, confirm the corpora row counts
  (entities/facts) match the handover; a drifted DB invalidates a plan built on it.
- **Beads:** `bd ready` and `bd show <epic>` — confirm the "next" bead is still ready and not already
  closed/claimed. `bd prime` if workflow context is wanted.
- **Named artifacts:** any file/flag/function/migration the handover's next-action cites — confirm it
  still exists (`grep -a` for `index.ts`; remember `rawQuery` camel-cases keys).
- **tsc baseline** if code work is next: `cd platform && npx tsc` errors == 69 (compare, don't "fix").

### 3. Reconcile IN-FLIGHT items
- A result marked **pre-adversary** → the adversary is still owed before it can be banked.
- A **background agent** the handover said was mid-flight → its output is **gone**; re-launch it, do not
  hunt for a result.
- A **prereg committed without a run** → the next step is to run it (after auditing the harness against
  the frozen text).
- An **open user-decision** → surface it to the user now; do not pick for them.

### 4. Orient (briefing to the user)
A short, honest briefing:
- One line: where we are (loop/epic state, verbatim from the ledger).
- **Verified vs STALE** table for the checks in step 2 — lead with anything stale.
- The proposed **next action** (from the handover, re-validated), or the corrected one if reality moved.
- Any **open decisions** the user must answer before proceeding.

### 5. Proceed only if told
- Default (`/pickup`): stop after the briefing and await direction.
- `/pickup --go`: if every verification is `OK` and the next action needs no user decision, begin it.
  If anything is `STALE` or a decision is open, do NOT start — report and wait.

## Notes
- Never present the handover's claims as current truth without the step-2 check beside them. "The
  handover said X; verified X still holds" — or "STALE: handover said X, reality is Y."
- If `HANDOVER.md` and the ledger disagree, the ledger + git win (the handover may predate later commits).
- Keep it read-mostly: pickup verifies and orients; it does not commit or mutate beyond re-launching a
  named background agent when that is the explicit next step.
