# Work Packet W41: Mnemo MCP Server

**Status:** ❌ Not Started
**Dependencies:** W35 (HTTP Ingest API)
**Estimated Time:** 3–4 hours

---

## Objective

Build a Model Context Protocol (MCP) server that exposes Mnemo's knowledge base to Claude Code and Claude Desktop. Developers can query memories, search entities, ingest content, and explore the knowledge graph — all from within their coding workflow.

**Use case:** "What did we decide about the auth approach?" → Claude searches Mnemo via MCP → returns relevant memories with source attribution.

---

## Implementation

### Project Setup

Create `mcp-server/` at repository root:

```
mcp-server/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # Server entry point
    ├── tools.ts          # MCP tool definitions
    ├── resources.ts      # MCP resource definitions
    └── mnemo-client.ts   # HTTP client for Mnemo platform API
```

```json
// mcp-server/package.json
{
  "name": "@mnemo/mcp-server",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

### MCP Server Entry Point

Create `mcp-server/src/index.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

const server = new McpServer({
  name: 'mnemo',
  version: '0.1.0',
});

registerTools(server);
registerResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Mnemo HTTP Client

Create `mcp-server/src/mnemo-client.ts`:

```typescript
const MNEMO_URL = process.env.MNEMO_URL || 'http://localhost:3001';
const MNEMO_API_KEY = process.env.MNEMO_API_KEY || '';

async function mnemoFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${MNEMO_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MNEMO_API_KEY}`,
      ...options?.headers,
    },
  });
}

export async function searchMemories(query: string, limit = 10) {
  const res = await mnemoFetch('/api/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  });
  return res.json();
}

export async function hybridSearch(query: string, limit = 10) {
  const res = await mnemoFetch('/api/hybrid-search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  });
  return res.json();
}

export async function ingestContent(content: string, type = 'text', metadata = {}) {
  const res = await mnemoFetch('/api/ingest', {
    method: 'POST',
    body: JSON.stringify({ content, type, metadata, source_label: 'claude-code' }),
  });
  return res.json();
}

export async function queryTasks(filters: Record<string, unknown> = {}) {
  const res = await mnemoFetch('/api/query/tasks', {
    method: 'POST',
    body: JSON.stringify(filters),
  });
  return res.json();
}

export async function searchEntities(query: string, type?: string) {
  const params = new URLSearchParams({ q: query });
  if (type) params.set('type', type);
  const res = await mnemoFetch(`/api/entities/search?${params}`);
  return res.json();
}

export async function getEntity(entityId: string) {
  const res = await mnemoFetch(`/api/entities/${entityId}`);
  return res.json();
}

export async function getStats() {
  const res = await mnemoFetch('/api/stats');
  return res.json();
}
```

### MCP Tools

Create `mcp-server/src/tools.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as client from './mnemo-client.js';

export function registerTools(server: McpServer): void {

  server.tool(
    'search_memories',
    'Semantic search across all memories in the knowledge base',
    { query: z.string().describe('Search query in natural language'), limit: z.number().default(10) },
    async ({ query, limit }) => {
      const results = await client.searchMemories(query, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.tool(
    'hybrid_search',
    'Combined vector + graph + keyword search for comprehensive results',
    { query: z.string(), limit: z.number().default(10) },
    async ({ query, limit }) => {
      const results = await client.hybridSearch(query, limit);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.tool(
    'ingest_content',
    'Push new content into Mnemo knowledge base',
    {
      content: z.string().describe('Content to ingest'),
      type: z.enum(['text', 'markdown', 'link']).default('text'),
      metadata: z.record(z.unknown()).optional(),
    },
    async ({ content, type, metadata }) => {
      const result = await client.ingestContent(content, type, metadata);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'query_tasks',
    'Search and filter tasks extracted from memories',
    {
      status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
      assignee: z.string().optional(),
      limit: z.number().default(20),
    },
    async (filters) => {
      const results = await client.queryTasks(filters);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.tool(
    'search_entities',
    'Find entities (people, projects, companies, topics) by name or type',
    {
      query: z.string().describe('Entity name or search term'),
      type: z.enum(['person', 'organization', 'project', 'topic']).optional(),
    },
    async ({ query, type }) => {
      const results = await client.searchEntities(query, type);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.tool(
    'get_entity',
    'Get full entity details including facts and relationships',
    { entity_id: z.string() },
    async ({ entity_id }) => {
      const result = await client.getEntity(entity_id);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'get_stats',
    'Get knowledge base statistics (memory count, entity count, etc.)',
    {},
    async () => {
      const stats = await client.getStats();
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    },
  );
}
```

### MCP Resources

Create `mcp-server/src/resources.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as client from './mnemo-client.js';

export function registerResources(server: McpServer): void {

  server.resource(
    'knowledge-base-stats',
    'mnemo://stats',
    async (uri) => {
      const stats = await client.getStats();
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(stats, null, 2),
        }],
      };
    },
  );
}
```

### Configuration

Create `.mcp.json` at repository root:

```json
{
  "mcpServers": {
    "mnemo": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "MNEMO_URL": "http://localhost:3001",
        "MNEMO_API_KEY": "${MNEMO_API_KEY}"
      }
    }
  }
}
```

Or register via CLI:

```bash
claude mcp add mnemo node mcp-server/dist/index.js \
  --env MNEMO_URL=http://localhost:3001 \
  --env MNEMO_API_KEY=$MNEMO_API_KEY
```

---

## Verification

### Automated Tests

```typescript
// mcp-server/src/__tests__/tools.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('MCP Tools', () => {
  it('search_memories should call Mnemo API', async () => {
    // Mock fetch, verify correct URL and params
  });

  it('ingest_content should tag source as claude-code', async () => {
    // Verify source_label is set
  });
});
```

### Manual Verification

```bash
# Build MCP server
cd mcp-server && pnpm build

# Test with Claude Code
claude mcp add mnemo node mcp-server/dist/index.js

# In Claude Code, ask:
# "Search my knowledge base for authentication decisions"
# → Should invoke search_memories tool and return results

# Test ingestion:
# "Save this to my knowledge base: We decided to use JWT for API auth"
# → Should invoke ingest_content tool
```

---

## Acceptance Criteria

- [ ] MCP server starts via stdio transport
- [ ] `search_memories` tool returns semantic search results
- [ ] `hybrid_search` tool returns combined results
- [ ] `ingest_content` tool pushes content with `source_label: 'claude-code'`
- [ ] `query_tasks` tool filters and returns tasks
- [ ] `search_entities` / `get_entity` tools work
- [ ] `get_stats` tool returns knowledge base statistics
- [ ] `knowledge-base-stats` resource exposed
- [ ] `.mcp.json` config works with `claude mcp add`
- [ ] Works with both Claude Code and Claude Desktop

---

## Next Packet

- [W42: Multi-Source Integration & E2E Testing](./W42-multi-source-integration.md)
