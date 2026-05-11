# Work Packet W40: Obsidian Write-back Agent

**Status:** ❌ Not Started
**Dependencies:** W39 (Obsidian Read Adapter)
**Estimated Time:** 5–6 hours

---

## Objective

Implement a KARMA agent that writes Mnemo's knowledge back into the Obsidian vault as human-readable Markdown pages. Entity profiles, meeting summaries, and daily digests appear as navigable notes with wikilinks between related entities. Uses Obsidian CLI as primary write path with direct file I/O as fallback.

---

## What Goes in Obsidian vs. What Stays in Mnemo

| In Obsidian (human-browsable) | In Postgres/Qdrant (machine-only) |
|-------------------------------|-----------------------------------|
| Entity profiles (People, Projects, Companies) | Embedding vectors |
| Meeting summaries | Fact triples with confidence scores |
| Daily digests | Graph relationships (Apache AGE) |
| Topic cluster overviews | ML pipeline logs |
| Task lists | Content hashes, dedup state |

---

## Implementation

### Vault Structure

```
vault/
├── People/
│   ├── Alice Smith.md
│   └── Bob Jones.md
├── Projects/
│   └── Mnemo.md
├── Companies/
│   └── Acme Corp.md
├── Meetings/
│   ├── 2026-03-12-standup.md
│   └── 2026-03-11-project-review.md
├── Topics/
│   └── Authentication.md
└── Daily/
    ├── 2026-03-12.md
    └── 2026-03-11.md
```

### Entity Page Template

```markdown
---
mnemo_managed: true
entity_id: "uuid-here"
entity_type: "person"
last_sync: "2026-03-12T10:00:00Z"
---
# Alice Smith

## Facts
- Works at [[Acme Corp]] (since 2024)
- Lead engineer on [[Mnemo]] project
- Prefers async communication

## Recent Mentions
- [[2026-03-12-standup]]: Discussed API redesign timeline
- [[2026-03-11-project-review]]: Presented sprint demo

## Related
- [[Bob Jones]] — same team
- [[Authentication]] — primary topic
```

### Meeting Summary Template

```markdown
---
mnemo_managed: true
meeting_id: "uuid-here"
date: "2026-03-12"
last_sync: "2026-03-12T10:30:00Z"
---
# Standup — 2026-03-12

## Participants
- [[Alice Smith]]
- [[Bob Jones]]

## Summary
Discussed the API redesign. Agreed to use Hono framework.

## Action Items
- [ ] [[Alice Smith]]: Draft API spec by Friday
- [ ] [[Bob Jones]]: Set up Hono project scaffold

## Key Decisions
- Switch from Express to Hono for the new API layer
```

### Vault Writer Agent

Create `platform/src/gardener/agents/vault-writer-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { ObsidianCli } from '../../services/obsidian/cli.js';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { computeContentHash } from '../../services/ingest/router.js';
import { config } from '../../config.js';

export interface VaultWriteJob {
  type: 'entity' | 'meeting' | 'daily';
  entityId?: string;
  meetingId?: string;
  date?: string;  // For daily notes: YYYY-MM-DD
}

export interface VaultWriteResult {
  filesWritten: number;
  filesSkipped: number;
}

export const vaultWriterAgent: GardenerAgent<VaultWriteJob, VaultWriteResult> = {
  name: 'vault-writer',
  tier: 'periodic',

  async process(
    job: VaultWriteJob,
    context: AgentContext,
  ): Promise<AgentResult<VaultWriteResult>> {
    const startTime = Date.now();
    const cli = new ObsidianCli(config.OBSIDIAN_VAULT_PATH);
    const useCli = await cli.isAvailable();

    let written = 0;
    let skipped = 0;

    try {
      if (job.type === 'entity' && job.entityId) {
        const result = await writeEntityPage(job.entityId, cli, useCli);
        if (result) written++; else skipped++;
      }

      if (job.type === 'meeting' && job.meetingId) {
        const result = await writeMeetingSummary(job.meetingId, cli, useCli);
        if (result) written++; else skipped++;
      }

      if (job.type === 'daily' && job.date) {
        const result = await writeDailyDigest(job.date, cli, useCli);
        if (result) written++; else skipped++;
      }

      return {
        success: true,
        data: { filesWritten: written, filesSkipped: skipped },
        metrics: { durationMs: Date.now() - startTime },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Write or update an entity profile page.
 * Returns true if written, false if skipped (unchanged).
 */
async function writeEntityPage(
  entityId: string,
  cli: ObsidianCli,
  useCli: boolean,
): Promise<boolean> {
  // Fetch entity data from Postgres
  const entity = await db.execute(sql`
    SELECT canonical_name, entity_type, metadata
    FROM entities WHERE id = ${entityId}
  `);
  if (entity.rows.length === 0) return false;

  const { canonical_name, entity_type } = entity.rows[0];

  // Fetch facts
  const facts = await db.execute(sql`
    SELECT subject, predicate, object, confidence
    FROM facts WHERE subject_entity_id = ${entityId}
    ORDER BY confidence DESC
  `);

  // Fetch relationships
  const relationships = await db.execute(sql`
    SELECT r.predicate, e2.canonical_name as related_name
    FROM relationships r
    JOIN entities e2 ON r.target_entity_id = e2.id
    WHERE r.source_entity_id = ${entityId}
  `);

  // Build page content
  const typeFolder = entityTypeToFolder(entity_type as string);
  const vaultPath = `${typeFolder}/${canonical_name}.md`;
  const content = buildEntityMarkdown(entity.rows[0], facts.rows, relationships.rows);

  return await writeToVault(vaultPath, content, cli, useCli);
}

/**
 * Map entity type to vault folder.
 */
function entityTypeToFolder(type: string): string {
  const map: Record<string, string> = {
    person: 'People',
    organization: 'Companies',
    project: 'Projects',
    topic: 'Topics',
  };
  return map[type] || 'Topics';
}

/**
 * Build entity Markdown with frontmatter and wikilinks.
 */
function buildEntityMarkdown(
  entity: Record<string, unknown>,
  facts: Array<Record<string, unknown>>,
  relationships: Array<Record<string, unknown>>,
): string {
  const lines: string[] = [
    '---',
    'mnemo_managed: true',
    `entity_id: "${entity.id}"`,
    `entity_type: "${entity.entity_type}"`,
    `last_sync: "${new Date().toISOString()}"`,
    '---',
    `# ${entity.canonical_name}`,
    '',
  ];

  if (facts.length > 0) {
    lines.push('## Facts');
    for (const fact of facts) {
      lines.push(`- ${fact.predicate}: ${fact.object}`);
    }
    lines.push('');
  }

  if (relationships.length > 0) {
    lines.push('## Related');
    for (const rel of relationships) {
      lines.push(`- [[${rel.related_name}]] — ${rel.predicate}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write content to vault with write-lock and hash tracking.
 */
async function writeToVault(
  vaultPath: string,
  content: string,
  cli: ObsidianCli,
  useCli: boolean,
): Promise<boolean> {
  const hash = computeContentHash(content);

  // Check if content has changed
  const existing = await db.execute(sql`
    SELECT content_hash FROM obsidian_sync_state WHERE vault_path = ${vaultPath}
  `);
  if (existing.rows.length > 0 && existing.rows[0].content_hash === hash) {
    return false;  // No change
  }

  // Set write lock
  await db.execute(sql`
    INSERT INTO obsidian_sync_state (vault_path, content_hash, write_locked, locked_at)
    VALUES (${vaultPath}, ${hash}, true, NOW())
    ON CONFLICT (vault_path) DO UPDATE
    SET content_hash = ${hash}, write_locked = true, locked_at = NOW()
  `);

  try {
    const fullPath = join(config.OBSIDIAN_VAULT_PATH, vaultPath);

    if (useCli) {
      await cli.create(vaultPath, content);
    } else {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
    }

    // Update sync state
    await db.execute(sql`
      UPDATE obsidian_sync_state
      SET write_locked = false, last_written_at = NOW()
      WHERE vault_path = ${vaultPath}
    `);

    return true;
  } catch (error) {
    // Release lock on failure
    await db.execute(sql`
      UPDATE obsidian_sync_state SET write_locked = false WHERE vault_path = ${vaultPath}
    `);
    throw error;
  }
}
```

### Trigger Hooks

Other KARMA agents queue vault-writer jobs after they produce content:

**Entity extraction agent** (after creating/updating an entity):
```typescript
await context.queueJob('vault-writer', {
  type: 'entity',
  entityId: entity.id,
});
```

**Summarizer agent** (after producing a meeting summary):
```typescript
await context.queueJob('vault-writer', {
  type: 'meeting',
  meetingId: memory.id,
});
```

**Daily digest** (scheduled nightly):
```typescript
await context.queueJob('vault-writer', {
  type: 'daily',
  date: new Date().toISOString().split('T')[0],
});
```

### pg-boss Queue

Register `OBSIDIAN_WRITEBACK` queue, separate from the main processing queue to prevent write-back from blocking ingestion:

```typescript
await boss.createQueue('OBSIDIAN_WRITEBACK');
```

---

## Verification

### Automated Tests

```typescript
// platform/src/test/agents/vault-writer.test.ts
import { describe, it, expect } from 'vitest';

describe('Vault Writer Agent', () => {
  it('should build entity markdown with frontmatter', () => {
    // buildEntityMarkdown() returns correct structure
  });

  it('should skip writing when content hash unchanged', async () => {
    // writeToVault() returns false for unchanged content
  });

  it('should set and release write lock', async () => {
    // Write lock is set before write, released after
  });
});
```

### Manual Verification

```bash
# Queue a vault write
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{"agent": "vault-writer", "job": {"type": "entity", "entityId": "<entity-uuid>"}}'

# Verify file was created in vault
cat ~/vault/People/Alice\ Smith.md

# Verify frontmatter contains mnemo_managed
head -5 ~/vault/People/Alice\ Smith.md

# Verify sync state
psql -d cognitive -c "SELECT vault_path, write_locked, last_written_at FROM obsidian_sync_state;"
```

---

## Acceptance Criteria

- [ ] `vault-writer` KARMA agent registered on periodic tier
- [ ] Entity pages written with `mnemo_managed` frontmatter
- [ ] Meeting summaries written with participant wikilinks
- [ ] Daily digest appends day's highlights
- [ ] Vault folder structure: `People/`, `Projects/`, `Companies/`, `Meetings/`, `Topics/`, `Daily/`
- [ ] Wikilinks between related entities
- [ ] Write-lock prevents read adapter from re-ingesting during write
- [ ] Content hash comparison skips unchanged files
- [ ] Obsidian CLI used when available, file I/O as fallback
- [ ] `OBSIDIAN_WRITEBACK` pg-boss queue separate from main queue
- [ ] Entity/summarizer agents trigger vault-writer jobs

---

## Next Packet

- [W41: Mnemo MCP Server](./W41-mnemo-mcp-server.md) — Developer interface via Claude Code
