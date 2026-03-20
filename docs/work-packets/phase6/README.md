# Phase 6: Multi-Source Ingestion

> **Goal:** Expand Mnemo beyond Telegram into a universal second brain — meetings, documents, notes, and developer tools all feed the same knowledge graph.
> **Status:** ✅ Complete — 12 work packets (W34–W45) implemented.

---

## Motivation

Mnemo's downstream pipeline (envelope → message processor → ML services → KARMA agents) is already source-agnostic. But the only input edge is Telegram. Phase 6 adds new input sources, makes Obsidian a bidirectional front end, and exposes the knowledge base to Claude Code via MCP.

---

## Architecture

```
┌─────────────────── INPUTS ──────────────────────┐
│                                                  │
│  Telegram ──────────┐                            │
│  File Watcher ──────┤  Source    Ingest           │
│  HTTP API ──────────┤→ Adapters → Router → Queue  │
│  Obsidian (read) ───┤                            │
│  Claude Code (MCP) ─┘                            │
│                                                  │
└──────────────────────────────────────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  Message Processor  │
              │  (source-agnostic)  │
              └──────────┬──────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ ML Svcs  │  │  Qdrant  │  │ Postgres │
    └──────────┘  └──────────┘  └──────────┘
          │
          ▼
    ┌──────────┐
    │  KARMA   │
    │  Agents  │──→ Obsidian Vault (write-back via CLI)
    └──────────┘

┌─────────────────── INTERFACES ──────────────────┐
│                                                  │
│  Telegram Bot (existing)                        │
│  Obsidian Vault (bidirectional — human UI)      │
│  Claude Code (MCP server — developer/power UI)  │
│  HTTP API (programmatic access)                 │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## Research Findings Summary

### Teams Transcripts

- **Microsoft Graph API** provides `GET .../transcripts/{tid}/content` for `.vtt` download, plus Change Notifications for auto-push when transcripts are ready.
- **Free since August 2025** — metered API charges removed.
- **Auto-transcription is default** since Feb 2025 for new tenants.
- **Limitation:** No API to start recording — someone must click Record or set tenant policy to auto-record.
- **Our approach:** Three paths. (1) **Live capture** — native Python system tray app records mic + system audio via WASAPI loopback, saves `.wav` to watch directory. (2) **VTT file drop** — pre-transcribed files parsed directly. (3) **Audio file drop** — pre-recorded files routed to the existing faster-whisper pipeline. No Azure AD dependency. Works with any meeting platform (Teams, Zoom, Meet, phone calls).

### Obsidian Integration

- **Official CLI (v1.12, Feb 2026):** `create`, `read`, `append`, `search`, `search:context`, `rename`, `daily`, `tasks`, `tags`, `properties`, `templates`, `plugins`, `sync`. Talks to running Obsidian via IPC. Requires Catalyst license.
- **Local REST API Plugin:** Community plugin, HTTPS + API key, full CRUD. Mature but requires plugin install.
- **MCP Servers:** Multiple implementations exist (cyanheads, jacksteamdev, MarkusPfundstein).
- **Our approach:** CLI primary (cleanest, no plugin dependency), direct file I/O as fallback when Obsidian isn't running.

### Claude Code / MCP

- **MCP (Model Context Protocol)** is the standard for connecting Claude Code to external tools.
- Build a custom MCP server in TypeScript using `@modelcontextprotocol/sdk`.
- Expose Mnemo's APIs as MCP tools: search, ingest, entities, tasks, graph queries.
- Configure via `.mcp.json` in project root or `claude mcp add`.
- Data stays local — MCP server runs on same machine as Mnemo.

---

## Source Adapter Pattern

All sources implement a common `SourceAdapter` interface. The adapter normalizes source-specific data into a generalized `IngestJobData` envelope, checks for duplicates via content hash, and dispatches to the existing pg-boss queue.

```
SourceAdapter.receive() → IngestJobData → IngestRouter.route() → pg-boss queue
```

### Envelope Type Evolution

New `platform` values: `file`, `obsidian`, `teams`, `api`
New `rawType` values: `transcript`, `markdown`, `document`, `audio`

---

## Obsidian as Front End

Obsidian serves as the **human-readable interface** to Mnemo's knowledge base:

- **Read direction:** Obsidian vault notes are ingested as memories (wikilinks become relationship hints).
- **Write direction:** KARMA agents write entity profiles, meeting summaries, and daily digests back into the vault.
- **Loop prevention:** Three layers — `mnemo_managed` frontmatter marker, content hash comparison, write-lock table.

### What Goes in Obsidian

Entity profiles, meeting summaries, daily digests, topic clusters — anything a human browses.

### What Stays in Postgres/Qdrant

Embeddings, fact triples, confidence scores, graph relationships, ML pipeline logs — machine-only data.

---

## Claude Code MCP Server

Exposes Mnemo as a set of MCP tools that Claude Code can call during development:

- `search_memories` — semantic search
- `hybrid_search` — vector + graph + keyword
- `ingest_content` — push content into Mnemo
- `list_tasks` / `query_tasks` — task queries
- `search_entities` / `get_entity` — entity lookup
- `get_stats` — knowledge base statistics

**Use case:** "What did we decide about the auth approach?" → Claude searches Mnemo via MCP → returns relevant memories with source attribution.

---

## Work Packets

| Packet | Name | Dependencies | Est. |
|--------|------|-------------|------|
| [W34](./W34-source-adapter-framework.md) | Source Adapter Framework | None | 4–5h |
| [W35](./W35-http-ingest-api.md) | HTTP Ingest API | W34 | 2–3h |
| [W36](./W36-file-watcher.md) | File Watcher Service | W34 | 3–4h |
| [W37](./W37-document-transcript-ml.md) | Document & Transcript ML Endpoints | None | 4–5h |
| [W38](./W38-meeting-capture.md) | Meeting Capture (Live + Transcripts + Audio) | W36, W37 | 4–5h |
| [W39](./W39-obsidian-read.md) | Obsidian Read Adapter | W34, W37 | 4–5h |
| [W40](./W40-obsidian-writeback.md) | Obsidian Write-back Agent | W39 | 5–6h |
| [W41](./W41-mnemo-mcp-server.md) | Mnemo MCP Server | W35 | 3–4h |
| [W42](./W42-multi-source-integration.md) | Integration & E2E Testing | W35–W41 | 3–4h |
| [W43](./W43-processing-profiles.md) | Processing Profile System | W34 | 3–4h |
| [W44](./W44-conversation-context.md) | Conversation Context Service | W34, W43 | 5–6h |
| [W45](./W45-project-association.md) | Project Association Agent | W44 | 4–5h |

### Dependency Graph

```
W37 (ML endpoints) ─────────────────────────────┐
                                                 │
W34 (Framework) ──┬── W35 (HTTP API) ──── W41 (MCP Server)
                  │                              │
                  ├── W36 (File Watcher) ── W38 (Meeting Capture)
                  │                              │
                  ├── W39 (Obsidian Read) ── W40 (Write-back)
                  │                              │
                  ├── W43 (Profiles) ── W44 (Conversation Context) ── W45 (Project Assoc.)
                  │                                                          │
                  └──────────────────────────────────────────────────────────┘
                                                 │
                                          W42 (Integration)
```

W34 and W37 can start in parallel (TypeScript and Python respectively).
W43–W45 form a new chain that can proceed in parallel with W35–W41.

### Recommended Order

1. **W34** + **W37** in parallel (framework + ML endpoints)
2. **W35** + **W36** + **W39** + **W43** (input sources + processing profiles)
3. **W38** (meeting capture, needs W36 + W37)
4. **W44** (conversation context, needs W34 + W43)
5. **W40** + **W41** (Obsidian write-back + MCP server)
6. **W45** (project association, needs W44)
7. **W42** (integration testing, needs everything)

---

## Prerequisites

- Phase 4 KARMA agents provide the agent infrastructure that W40 (vault-writer) builds on.
- W10 Voice Transcription provides the Whisper pipeline that W38 reuses for audio files.
- Phase 5 is not a hard dependency — these phases can proceed in parallel.

---

## Research Sources

### Teams
- [Fetch Meeting Transcripts — Microsoft Learn](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts)
- [Get callTranscript API](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0)
- [Change Notifications for Transcripts](https://learn.microsoft.com/en-us/graph/teams-changenotifications-callrecording-and-calltranscript)
- [Microsoft Ends Metered Graph API Charges](https://empowering.cloud/microsoft-ends-charges-for-select-teams-metered-graph-apis/)
- [Teams Recording & Transcription Policies](https://office365itpros.com/2025/01/08/teams-recording-and-transcription/)

### Obsidian
- [Obsidian CLI Help](https://help.obsidian.md/cli)
- [Obsidian 1.12 Changelog](https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/)
- [Obsidian CLI Ultimate Guide](https://blog.wenhaofree.com/en/posts/articles/obsidian-1-12-cli-ultimate-guide/)
- [Local REST API Plugin](https://github.com/coddingtonbear/obsidian-local-rest-api)
- [Obsidian MCP Server](https://github.com/cyanheads/obsidian-mcp-server)

### Claude Code / MCP
- [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp)
- [Build MCP Server with TypeScript](https://www.freecodecamp.org/news/how-to-build-a-custom-mcp-server-with-typescript-a-handbook-for-developers/)
- [Claude Code MCP Integration Guide](https://www.oflight.co.jp/en/columns/claude-code-mcp-integration-guide-2026)

---

## Related Documents

- [ARCHITECTURE.md](../../architecture/current.md)
- [TECHNICAL_PLAN.md](../../INDEX.md)
- [Phase 5 README](../phase5/README.md)
