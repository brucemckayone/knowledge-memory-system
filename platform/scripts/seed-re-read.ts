#!/usr/bin/env tsx
/**
 * seed-re-read — compose ONE real re-read letter so /api/re-read/* has something
 * to read end-to-end (ASK-011 read-path v1).
 *
 * Picks a real thread entity + its linked source memories from the runtime DB,
 * then calls composeReReadLetter (which lifts each memory's Qdrant content,
 * composes Voice-C prose via composeVoiceCWithLLM, and persists a current letter).
 *
 * USAGE (from platform/):
 *   npx tsx scripts/seed-re-read.ts
 *     # auto-pick: the entity with the most linked memories (a real "thread")
 *   npx tsx scripts/seed-re-read.ts <threadEntityId> [memoryId ...]
 *     # explicit thread + (optional) explicit source memory ids
 *
 * Requires the same env the server uses (DATABASE_URL, QDRANT_URL,
 * ML_SERVICES_URL). The compose path falls back to the deterministic floor if
 * ml-services is unreachable, so a letter is produced either way (span-bearing).
 *
 * Re-runnable: each run composes a NEW current letter for the thread and
 * supersedes the prior current row (the prior stays in the archive).
 */

import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { composeReReadLetter } from '../src/services/re-read.js';

/** How many linked memories to feed the composer when auto-picking. */
const MAX_AUTO_SOURCES = 6;

interface AutoPick {
  threadEntityId: string;
  sourceMemoryIds: string[];
}

/**
 * Auto-pick a real thread: the entity with the MOST linked memories (a substantive
 * thread to compose over), and that entity's most-recent linked memory ids.
 */
async function autoPickThread(): Promise<AutoPick | null> {
  const entityRows = (await db.execute(sql`
    SELECT me.entity_id::text AS entity_id, COUNT(*) AS n
      FROM public.memory_entities me
     GROUP BY me.entity_id
     ORDER BY n DESC
     LIMIT 1
  `)) as unknown as Array<{ entity_id: string; n: number }>;

  const top = entityRows[0];
  if (!top) return null;

  const memoryRows = (await db.execute(sql`
    SELECT me.memory_id::text AS memory_id
      FROM public.memory_entities me
     WHERE me.entity_id = ${top.entity_id}::uuid
     ORDER BY me.created_at DESC
     LIMIT ${MAX_AUTO_SOURCES}
  `)) as unknown as Array<{ memory_id: string }>;

  return {
    threadEntityId: top.entity_id,
    sourceMemoryIds: memoryRows.map((r) => r.memory_id),
  };
}

async function main(): Promise<void> {
  const [argThread, ...argMemoryIds] = process.argv.slice(2);

  let threadEntityId: string;
  let sourceMemoryIds: string[];

  if (argThread) {
    threadEntityId = argThread;
    sourceMemoryIds = argMemoryIds;
    if (sourceMemoryIds.length === 0) {
      // Explicit thread, no explicit memories — pull this entity's linked ones.
      const rows = (await db.execute(sql`
        SELECT me.memory_id::text AS memory_id
          FROM public.memory_entities me
         WHERE me.entity_id = ${threadEntityId}::uuid
         ORDER BY me.created_at DESC
         LIMIT ${MAX_AUTO_SOURCES}
      `)) as unknown as Array<{ memory_id: string }>;
      sourceMemoryIds = rows.map((r) => r.memory_id);
    }
  } else {
    const picked = await autoPickThread();
    if (!picked) {
      console.error(
        '[seed-re-read] no memory_entities links found — ingest some memories first, ' +
        'or pass an explicit <threadEntityId> [memoryId ...].',
      );
      process.exit(1);
      return;
    }
    threadEntityId = picked.threadEntityId;
    sourceMemoryIds = picked.sourceMemoryIds;
  }

  if (sourceMemoryIds.length === 0) {
    console.error(
      `[seed-re-read] no source memories for thread=${threadEntityId}; ` +
      'pass explicit memory ids.',
    );
    process.exit(1);
    return;
  }

  console.log(
    `[seed-re-read] composing a letter for thread=${threadEntityId} ` +
    `over ${sourceMemoryIds.length} source(s): ${sourceMemoryIds.join(', ')}`,
  );

  const letter = await composeReReadLetter({ threadEntityId, sourceMemoryIds });

  console.log('[seed-re-read] composed + persisted letter:');
  console.log(JSON.stringify(letter, null, 2));
  console.log(
    `\n[seed-re-read] now readable at:\n` +
    `  GET /api/re-read/current\n` +
    `  GET /api/re-read/?threadEntityId=${threadEntityId}\n` +
    `  GET /api/re-read/all`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-re-read] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
