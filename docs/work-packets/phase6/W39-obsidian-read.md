# Work Packet W39: Obsidian Read Adapter

**Status:** ❌ Not Started
**Dependencies:** W34 (Source Adapter Framework), W37 (Document & Transcript ML — markdown parsing)
**Estimated Time:** 4–5 hours

---

## Objective

Ingest notes from an Obsidian vault into Mnemo. Uses the Obsidian CLI 1.12 as the primary interface (search, read) with direct file watching as fallback when Obsidian isn't running. Implements three-layer loop prevention to avoid re-ingesting content that Mnemo itself wrote back (W40).

---

## Implementation

### Obsidian CLI Client

Create `platform/src/services/obsidian/cli.ts`:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface ObsidianNote {
  path: string;
  content: string;
}

export interface ObsidianSearchResult {
  path: string;
  matches: string[];
}

/**
 * Wrapper around Obsidian CLI 1.12.
 * Requires Obsidian to be running (CLI talks via IPC).
 */
export class ObsidianCli {
  constructor(private readonly vaultPath: string) {}

  /**
   * Check if Obsidian is running and CLI is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await exec('obsidian', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a note by vault-relative path.
   */
  async read(notePath: string): Promise<string> {
    const { stdout } = await exec('obsidian', [
      'read', notePath,
      '--vault', this.vaultPath,
    ]);
    return stdout;
  }

  /**
   * Search vault by text query. Returns matching note paths.
   */
  async search(query: string): Promise<ObsidianSearchResult[]> {
    const { stdout } = await exec('obsidian', [
      'search', query,
      '--vault', this.vaultPath,
      '--format', 'json',
    ]);
    return JSON.parse(stdout);
  }

  /**
   * Get all tags in the vault.
   */
  async tags(): Promise<string[]> {
    const { stdout } = await exec('obsidian', [
      'tags',
      '--vault', this.vaultPath,
      '--format', 'json',
    ]);
    return JSON.parse(stdout);
  }
}
```

### ObsidianReadAdapter

Create `platform/src/services/ingest/adapters/obsidian-read.ts`:

```typescript
import chokidar from 'chokidar';
import { readFile } from 'fs/promises';
import { basename, extname, relative } from 'path';
import { SourceAdapter, IngestJobData } from '../types.js';
import { IngestRouter, computeContentHash } from '../router.js';
import { ObsidianCli } from '../../obsidian/cli.js';
import { randomUUID } from 'crypto';
import { config } from '../../../config.js';
import { db } from '../../../db/index.js';
import { sql } from 'drizzle-orm';

export class ObsidianReadAdapter implements SourceAdapter {
  readonly name = 'obsidian-read';
  readonly platform = 'obsidian' as const;

  private cli: ObsidianCli;
  private watcher: chokidar.FSWatcher | null = null;

  constructor(private readonly router: IngestRouter) {
    this.cli = new ObsidianCli(config.OBSIDIAN_VAULT_PATH);
  }

  async start(): Promise<void> {
    const useCli = await this.cli.isAvailable();

    if (useCli) {
      console.log('📓 Obsidian CLI available — using CLI for vault access');
      // CLI mode: could poll with obsidian search, or just watch files
      // We still use file watcher for change detection, CLI for reading
    } else {
      console.log('📓 Obsidian not running — using direct file watcher');
    }

    // Watch vault for changes (works in both modes)
    this.watcher = chokidar.watch(config.OBSIDIAN_VAULT_PATH, {
      ignored: [
        /(^|[/\\])\../,         // Hidden files (.obsidian/, .git/)
        /node_modules/,
      ],
      ignoreInitial: true,       // Don't process existing files on startup
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 300,
      },
    });

    this.watcher.on('change', (path) => this.handleChange(path));
    this.watcher.on('add', (path) => this.handleChange(path));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private async handleChange(filePath: string): Promise<void> {
    const ext = extname(filePath).toLowerCase();
    if (ext !== '.md') return;  // Only markdown files

    try {
      const content = await readFile(filePath, 'utf-8');
      const vaultRelPath = relative(config.OBSIDIAN_VAULT_PATH, filePath);

      // --- Loop Prevention Layer 1: frontmatter marker ---
      if (this.isMnemoManaged(content)) {
        return;  // Skip files that Mnemo wrote
      }

      // --- Loop Prevention Layer 2: content hash ---
      const cleanContent = this.stripFrontmatter(content);
      const hash = computeContentHash(cleanContent);

      // --- Loop Prevention Layer 3: write-lock check ---
      const isLocked = await this.isWriteLocked(vaultRelPath);
      if (isLocked) {
        return;  // Mnemo is currently writing to this file
      }

      const job: IngestJobData = {
        traceId: randomUUID(),
        platform: 'obsidian',
        rawType: 'markdown',
        content: cleanContent,
        contentHash: hash,
        metadata: {
          vaultPath: vaultRelPath,
          fileName: basename(filePath),
          frontmatter: this.extractFrontmatter(content),
          wikilinks: this.extractWikilinks(cleanContent),
        },
        createdAt: new Date().toISOString(),
      };

      const result = await this.router.route(job);
      if (!result.duplicate) {
        console.log(`📓 Ingested vault note: ${vaultRelPath}`);
      }

    } catch (error) {
      console.error(`Obsidian read error for ${filePath}:`, error);
    }
  }

  /**
   * Layer 1: Check for mnemo_managed frontmatter marker.
   * Notes written by W40 (Obsidian Write-back) include this marker.
   */
  private isMnemoManaged(content: string): boolean {
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;
    return fmMatch[1].includes('mnemo_managed: true');
  }

  /**
   * Strip YAML frontmatter from content (for hashing and ingestion).
   */
  private stripFrontmatter(content: string): string {
    return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
  }

  /**
   * Extract frontmatter as object.
   */
  private extractFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return {};
    try {
      // Simple key-value parse; full YAML done by /parse-markdown
      const lines = match[1].split('\n');
      const result: Record<string, unknown> = {};
      for (const line of lines) {
        const [key, ...rest] = line.split(':');
        if (key && rest.length > 0) {
          result[key.trim()] = rest.join(':').trim();
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  /**
   * Extract [[wikilinks]] as relationship hints for entity linking.
   */
  private extractWikilinks(content: string): string[] {
    const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
    return [...matches].map((m) => m[1].split('|')[0]);
  }

  /**
   * Layer 3: Check if Mnemo is currently writing to this file.
   */
  private async isWriteLocked(vaultPath: string): Promise<boolean> {
    const result = await db.execute(sql`
      SELECT 1 FROM obsidian_sync_state
      WHERE vault_path = ${vaultPath}
        AND write_locked = true
        AND locked_at > NOW() - INTERVAL '30 seconds'
      LIMIT 1
    `);
    return result.rows.length > 0;
  }
}
```

### Database: obsidian_sync_state

```sql
CREATE TABLE IF NOT EXISTS obsidian_sync_state (
  vault_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  write_locked BOOLEAN NOT NULL DEFAULT false,
  locked_at TIMESTAMP WITH TIME ZONE,
  last_ingested_at TIMESTAMP WITH TIME ZONE,
  last_written_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_obsidian_sync_locked ON obsidian_sync_state(write_locked) WHERE write_locked = true;
```

### Config Additions

Add to `platform/src/config.ts`:

```typescript
OBSIDIAN_VAULT_PATH: z.string().optional().describe('Path to Obsidian vault directory'),
OBSIDIAN_ENABLED: z.coerce.boolean().default(false).describe('Enable Obsidian vault integration'),
```

---

## Loop Prevention Summary

Three layers prevent the read adapter from re-ingesting content that the write-back agent (W40) produced:

| Layer | Check | When |
|-------|-------|------|
| 1. Frontmatter marker | `mnemo_managed: true` in YAML | Before reading content |
| 2. Content hash | SHA-256 in `content_hashes` table | During `IngestRouter.route()` |
| 3. Write-lock | `obsidian_sync_state.write_locked` | Before queuing |

A note edited by the user (even one originally written by Mnemo) will:
- Still have `mnemo_managed: true` but the user's edits change the content hash
- Decision: **re-ingest user edits** to `mnemo_managed` files. The frontmatter check only skips files whose content hash matches what Mnemo last wrote. This allows the user to curate Mnemo's output.

---

## Verification

### Automated Tests

```typescript
// platform/src/test/services/obsidian-read.test.ts
import { describe, it, expect } from 'vitest';

describe('ObsidianReadAdapter', () => {
  it('should detect mnemo_managed frontmatter', () => {
    const content = '---\nmnemo_managed: true\nlast_sync: 2026-03-12\n---\n# Entity';
    // isMnemoManaged should return true
  });

  it('should extract wikilinks', () => {
    const content = 'Talked to [[Alice]] about [[Project X|the project]]';
    // extractWikilinks should return ['Alice', 'Project X']
  });

  it('should strip frontmatter for hashing', () => {
    const content = '---\ntitle: Test\n---\n# Content here';
    // stripFrontmatter should return '# Content here'
  });
});
```

### Manual Verification

```bash
# Start with Obsidian integration enabled
OBSIDIAN_ENABLED=true OBSIDIAN_VAULT_PATH=~/vault pnpm dev

# Edit a note in Obsidian — verify it appears in Mnemo
psql -d cognitive -c "SELECT * FROM content_hashes WHERE platform = 'obsidian' ORDER BY created_at DESC LIMIT 5;"

# Verify mnemo_managed files are skipped
echo '---\nmnemo_managed: true\n---\n# Entity' > ~/vault/People/Test.md
# Should NOT appear in content_hashes
```

---

## Acceptance Criteria

- [ ] Obsidian CLI wrapper with `read`, `search`, `isAvailable`
- [ ] File watcher monitors vault directory for `.md` changes
- [ ] `mnemo_managed` frontmatter marker detected and skipped
- [ ] Content hash dedup prevents re-ingestion of unchanged files
- [ ] Write-lock check prevents reading during active write-back
- [ ] Wikilinks extracted as relationship hints in metadata
- [ ] Frontmatter extracted as metadata
- [ ] `obsidian_sync_state` table created
- [ ] `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_ENABLED` config options
- [ ] Hidden directories (`.obsidian/`) ignored

---

## Next Packet

- [W40: Obsidian Write-back Agent](./W40-obsidian-writeback.md) — Completes bidirectional sync
