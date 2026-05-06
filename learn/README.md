# Adaptive Learning Platform

A demo learning platform built on top of the Nmemo dual-graph system. Demonstrates adaptive learning where the system understands *why* a learner is struggling (via Graph C causal chains) and generates targeted content to address root causes.

## Architecture

Standalone Hono server, completely separate from the Nmemo platform. Communicates with Nmemo via HTTP only. SQLite for course/question/quiz data. Vanilla JS frontend.

**MCP-first agents:** all five agents (course generator, chat tutor, quiz generator, answer evaluator, gap analyzer) use Claude Code via `-p` with an MCP server that exposes learning-specific tools. Agents make targeted, deliberate writes to the Nmemo graph — no bulk ingestion of chat messages.

```
┌─ learn/ (port 3002) ────────────────────────────────────┐
│  Hono server + SQLite + vanilla JS frontend             │
│                                                          │
│  Agents ── Claude -p ─┐                                  │
│                       ├── MCP tools ──┐                  │
│  Routes ──────────────┘               │                  │
└───────────────────────────────────────┼─────────────────┘
                                        │ HTTP
                              ┌─────────▼────────────┐
                              │ Nmemo platform :3001 │
                              │ Graph S + Graph C    │
                              └──────────────────────┘
```

## Setup

**Prerequisites:** Node.js 20+, Claude Code CLI on PATH, Nmemo platform running on :3001.

```bash
cd learn
cp .env.example .env
pnpm install                    # or npm install
pnpm db:migrate                 # creates learn.db
pnpm dev                        # starts server on :3002
```

Open http://localhost:3002 in a browser.

## How it works

### Two course creation flows
- **Generate from topic:** model uses its own knowledge to design the curriculum and creates concept entities + prerequisite facts in the Nmemo graph via MCP
- **Paste a book:** content is sent to Nmemo's full ingest pipeline (curriculum graph built from real text), course agent then structures the extracted concepts

### The learning loop
1. Learner takes quizzes — answers are evaluated by an agent (web search + graph context) → score 0-1 → MCP write to update learner facts
2. Learner chats with a tutor — agent silently makes targeted MCP writes only when something semantically meaningful happens (clear understanding shown, specific misconception, prerequisite gap detected)
3. Confidence on facts represents mastery; decay over time models forgetting

### The wow moment — Gap Analysis
Reads the learner's full Graph S + Graph C state, finds the highest-impact gap (what blocks the most downstream understanding), traces its causal history (why are you struggling), then generates a targeted mini-lesson for the root cause + follow-up questions.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET    | /api/courses | List courses |
| POST   | /api/courses | Create (generated or from pasted content) |
| GET    | /api/courses/:id | Course with sections + questions |
| GET    | /api/chat/sessions | List chat sessions |
| POST   | /api/chat/sessions | New chat session |
| GET    | /api/chat/sessions/:id/messages | Message history |
| POST   | /api/chat/sessions/:id/messages | Send message → tutor response |
| GET    | /api/quiz/sections/:id/next-question | Adaptive next question |
| POST   | /api/quiz/questions/:id/attempt | Submit answer → evaluation |
| POST   | /api/quiz/generate | Generate a new question for a concept |
| GET    | /api/learner/stats | Quiz + understanding stats |
| GET    | /api/learner/knowledge | Full learner graph state |
| POST   | /api/learner/gap-analysis | Generate targeted content for highest-impact gap |
| POST   | /api/learner/ask | Natural language question about your progress |

## Files added to the Nmemo platform

The learning platform needed three thin endpoints on Nmemo (in `platform/src/index.ts`):
- `POST /api/learn/record` — direct fact creation (used by MCP write tools)
- `GET /api/learn/concept/:name` — concept entity + facts
- `GET /api/learn/learner-facts` — all facts where Learner is the subject

These are minimal wrappers around the existing `services/entities.ts` and `services/facts.ts`.
