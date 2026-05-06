# v0.1 — MVP Scaffold (shipped)

**Status:** Working end-to-end as of 2026-05-06.

This documents what's already built. v0.2 builds on top of this — read it for context if planning new features.

---

## What's running

- **Standalone server** at `nmemo/learn/` on port 3002 (Hono + TypeScript).
- **SQLite via LibSQL** for course/section/question/quiz data.
- **Vanilla JS frontend** at `viz/index.html` (dark theme, no framework).
- **HTTP-only** communication with the Nmemo platform on :3001.
- **Three platform endpoints** added (`/api/learn/record`, `/api/learn/concept/:name`, `/api/learn/learner-facts`) as thin write/read wrappers.

## Five agents (all via `claude -p` + MCP)

| Agent | Model | Trigger | Purpose |
|-------|-------|---------|---------|
| Course Generator | Sonnet | `POST /api/courses` | Builds curriculum graph + course structure (paste book OR generate from topic) |
| Lesson Generator | Haiku | `POST /api/sections/:id/lesson` | Produces markdown lesson content per section |
| Chat Tutor | Haiku | `POST /api/chat/sessions/:id/messages` | Conversational tutor with silent MCP writes |
| Quiz Generator | Haiku | `POST /api/quiz/generate` | Static + generative questions per concept |
| Answer Evaluator | Haiku | `POST /api/quiz/questions/:id/attempt` | Web search + graph context + rich feedback + MCP updates |
| Gap Analyzer | Sonnet | `POST /api/learner/gap-analysis` | Reads graph state, finds highest-impact gap, generates targeted lesson |

## MCP tools (`learn/src/mcp/learning-mcp.ts`)

**Read tools** (agents check before acting):
- `get_learner_understanding(concept)`
- `get_learning_gaps(course_topic?)`
- `get_struggle_areas()`
- `get_causal_learning_history(concept)`
- `get_prerequisite_chain(concept)`
- `search_curriculum(query)`

**Write tools** (agents call deliberately):
- `record_understanding(concept, confidence, evidence)`
- `record_confusion(concept, misconception, evidence)`
- `record_quiz_result(concept, score, answer_summary)`
- `flag_prerequisite_gap(concept, missing_prerequisite, evidence)`
- `update_learning_trajectory(next_concept, reasoning)`

## Data model

| Table | Purpose |
|-------|---------|
| `courses` | Course metadata + source (paste vs generated) |
| `sections` | Ordered chunks of a course; lesson content stored here |
| `questions` | Static + generated questions; linked to a Nmemo concept entity |
| `quiz_attempts` | Each answer attempt with score + feedback + agent notes |
| `chat_sessions` | Chat session metadata |
| `chat_messages` | Per-message storage with optional MCP-update logs |

## Frontend tabs

- **Courses** — list + create course
- **Course Detail** — sections list with lesson status badges (added in v0.1.1)
- **Section view** — lesson markdown + inline questions (added in v0.1.1)
- **Learn (chat)** — sessions sidebar + message stream
- **Quiz** — fast-path question flow
- **My Gaps** — gap analyzer + targeted content
- **Progress** — stats + recent activity + understanding state

## Verified working flows

1. Course generation (both modes) — produces 5 sections with 3-5 questions each.
2. Lesson generation — produces 7-min markdown lessons with key takeaways.
3. Strong answer to a question → 0.95 score, rich feedback that extends the answer.
4. Weak answer → 0.25 score, complete walkthrough + specific next-step instruction.
5. Gap analysis → identifies root-cause concept, generates targeted mini-lesson + 3 follow-up questions.
6. Chat tutor → Socratic responses with concrete trade-offs, silent MCP writes.

## Known constraints

- Single learner only.
- Vanilla JS — no framework, limits component composition. (Addressed in v0.2 via Preact + htm.)
- No background processing. Everything runs synchronously on user action. (Addressed in v0.2 via patrol cron.)
- Lessons are static once generated. No personalisation per learner. (Addressed in v0.2 via lesson overlays.)
- No cross-course intelligence. (Addressed in v0.2 via connection-finder.)

## How to run

See `learn/README.md`. Short version:
```bash
# Nmemo platform must be on :3001
cd learn && pnpm install && pnpm db:migrate && pnpm dev
# Open http://localhost:3002
```
