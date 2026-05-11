# Work Packet W36: File Watcher Service

**Status:** ❌ Not Started
**Dependencies:** W34 (Source Adapter Framework)
**Estimated Time:** 3–4 hours

---

## Objective

Implement a file watcher that monitors a configurable directory for new files, detects their type, and routes them into the ingest pipeline. Text-based files (`.txt`, `.md`, `.vtt`, `.srt`) are read directly; binary files (`.pdf`, `.docx`) and audio files (`.mp3`, `.wav`, `.m4a`, `.ogg`) are routed to ML service endpoints for extraction or transcription.

---

## Implementation

### File Lifecycle

```
incoming/           → File dropped here (by user, Power Automate, script, etc.)
  ↓
processing/         → Moved here while being ingested
  ↓
done/    or  error/ → Moved on success or failure
```

This prevents double-processing and makes the state of each file visible.

### FileWatcherAdapter

Create `platform/src/services/ingest/adapters/file-watcher.ts`:

```typescript
import chokidar from 'chokidar';
import { readFile, rename, mkdir } from 'fs/promises';
import { basename, extname, join } from 'path';
import { SourceAdapter, IngestJobData } from '../types.js';
import { IngestRouter, computeContentHash } from '../router.js';
import { randomUUID } from 'crypto';
import { config } from '../../../config.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.vtt', '.srt', '.json', '.csv']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx']);

export class FileWatcherAdapter implements SourceAdapter {
  readonly name = 'file-watcher';
  readonly platform = 'file' as const;
  private watcher: chokidar.FSWatcher | null = null;

  constructor(private readonly router: IngestRouter) {}

  async start(): Promise<void> {
    const watchDir = config.WATCH_DIR;
    const incomingDir = join(watchDir, 'incoming');

    // Ensure directory structure exists
    await mkdir(join(watchDir, 'incoming'), { recursive: true });
    await mkdir(join(watchDir, 'processing'), { recursive: true });
    await mkdir(join(watchDir, 'done'), { recursive: true });
    await mkdir(join(watchDir, 'error'), { recursive: true });

    this.watcher = chokidar.watch(incomingDir, {
      ignoreInitial: false,     // Process existing files on startup
      awaitWriteFinish: {       // Wait for file to finish writing
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
    });

    this.watcher.on('add', (filePath) => this.handleFile(filePath));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private async handleFile(filePath: string): Promise<void> {
    const fileName = basename(filePath);
    const ext = extname(fileName).toLowerCase();
    const watchDir = config.WATCH_DIR;
    const processingPath = join(watchDir, 'processing', fileName);

    try {
      // Move to processing/
      await rename(filePath, processingPath);

      let content: string;
      let rawType: IngestJobData['rawType'];

      if (TEXT_EXTENSIONS.has(ext)) {
        content = await readFile(processingPath, 'utf-8');
        rawType = ext === '.md' ? 'markdown'
                : (ext === '.vtt' || ext === '.srt') ? 'transcript'
                : 'text';
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        // Route to existing /transcribe/upload endpoint (W10 Whisper pipeline)
        content = processingPath;  // Pass file path; processor will upload
        rawType = 'audio';
      } else if (DOCUMENT_EXTENSIONS.has(ext)) {
        // Route to /parse-document endpoint (W37)
        content = processingPath;
        rawType = 'document';
      } else {
        throw new Error(`Unsupported file extension: ${ext}`);
      }

      const job: IngestJobData = {
        traceId: randomUUID(),
        platform: 'file',
        rawType,
        content,
        contentHash: rawType === 'audio' || rawType === 'document'
          ? computeContentHash(fileName + ':' + (await readFile(processingPath)).length)
          : computeContentHash(content),
        metadata: {
          fileName,
          extension: ext,
          filePath: processingPath,
        },
        createdAt: new Date().toISOString(),
      };

      await this.router.route(job);

      // Move to done/
      await rename(processingPath, join(watchDir, 'done', fileName));

    } catch (error) {
      console.error(`File watcher error for ${fileName}:`, error);
      // Move to error/
      try {
        await rename(processingPath, join(watchDir, 'error', fileName));
      } catch {
        // File may not have been moved to processing/ yet
      }
    }
  }
}
```

### Config Additions

Add to `platform/src/config.ts`:

```typescript
WATCH_DIR: z.string().default('./watch').describe('Directory for file watcher ingestion'),
WATCH_ENABLED: z.coerce.boolean().default(false).describe('Enable file watcher service'),
```

### Startup Registration

In `platform/src/index.ts`:

```typescript
if (config.WATCH_ENABLED) {
  const fileWatcher = new FileWatcherAdapter(ingestRouter);
  await fileWatcher.start();
  console.log(`📂 File watcher started on ${config.WATCH_DIR}/incoming`);
}
```

---

## Verification

### Automated Tests

```typescript
// platform/src/test/services/file-watcher.test.ts
import { describe, it, expect } from 'vitest';

describe('FileWatcherAdapter', () => {
  it('should detect text file extensions', () => {
    // Verify TEXT_EXTENSIONS set
  });

  it('should detect audio file extensions', () => {
    // Verify AUDIO_EXTENSIONS set
  });

  it('should move files through lifecycle dirs', async () => {
    // Drop file in incoming/ → verify it ends up in done/
  });
});
```

### Manual Verification

```bash
# Create watch directories
mkdir -p ./watch/incoming ./watch/processing ./watch/done ./watch/error

# Start platform with WATCH_ENABLED=true
WATCH_ENABLED=true pnpm dev

# Drop a text file
echo "Meeting notes: decided to use Hono" > ./watch/incoming/meeting-2026-03-12.txt

# Verify it moved to done/
ls ./watch/done/

# Drop an audio file
cp ~/recording.mp3 ./watch/incoming/standup-2026-03-12.mp3

# Verify transcription + ingest
psql -d cognitive -c "SELECT * FROM content_hashes WHERE platform = 'file' ORDER BY created_at DESC LIMIT 5;"
```

---

## Acceptance Criteria

- [ ] `chokidar` watches `WATCH_DIR/incoming/`
- [ ] Files move through `incoming/` → `processing/` → `done/` (or `error/`)
- [ ] Text files (`.txt`, `.md`, `.vtt`, `.srt`) read directly
- [ ] Audio files (`.mp3`, `.wav`, `.m4a`, `.ogg`) routed to Whisper transcription
- [ ] Document files (`.pdf`, `.docx`) routed to ML parse endpoint
- [ ] `awaitWriteFinish` prevents partial-file reads
- [ ] Duplicate files detected via content hash
- [ ] `WATCH_DIR` and `WATCH_ENABLED` config options work
- [ ] Unsupported extensions land in `error/`

---

## Next Packet

- [W38: Meeting Capture](./W38-meeting-capture.md) — VTT + audio processing for meetings
