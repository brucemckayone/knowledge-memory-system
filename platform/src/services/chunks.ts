/**
 * Chunk Storage Service
 *
 * Manages chunked memory content for processing long texts.
 * Used by W22 Ingestion Agent to break down large memories.
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

export interface MemoryChunk {
  id: string;
  memoryId: string;
  chunkIndex: number;
  content: string;
  charCount: number;
  tokenEstimate?: number;
  overlapChars: number;
  createdAt: Date;
  processedAt?: Date;
}

export interface ChunkOptions {
  maxChunkSize?: number;
  overlap?: number;
  preserveSentences?: boolean;
}

const DEFAULT_CHUNK_SIZE = 4000;
const DEFAULT_OVERLAP = 200;

/**
 * Split content into chunks with overlap
 */
export function chunkContent(
  content: string,
  maxSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_OVERLAP
): Array<{ content: string; charCount: number; overlapChars: number }> {
  if (content.length <= maxSize) {
    return [{
      content,
      charCount: content.length,
      overlapChars: 0,
    }];
  }

  const chunks: Array<{ content: string; charCount: number; overlapChars: number }> = [];
  let position = 0;

  while (position < content.length) {
    let end = Math.min(position + maxSize, content.length);

    // Try to break at sentence boundary if not at end
    if (end < content.length) {
      // Look for sentence boundary in last 20% of chunk
      const searchStart = end - Math.floor(maxSize * 0.2);
      const searchText = content.slice(searchStart, end);

      // Find last sentence end
      const sentenceEndMatch = searchText.match(/[.!?]\s+[A-Z][^.!?]*$/);
      if (sentenceEndMatch) {
        end = searchStart + searchText.lastIndexOf(sentenceEndMatch[0]) + 1;
      }
    }

    const chunkContent = content.slice(position, end);
    const actualOverlap = chunks.length > 0 ? Math.min(overlap, position) : 0;

    chunks.push({
      content: chunkContent,
      charCount: chunkContent.length,
      overlapChars: actualOverlap,
    });

    // Move position, accounting for overlap
    position = end - (end < content.length ? overlap : 0);

    // Prevent infinite loop
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk && position <= lastChunk.charCount) {
      position = end;
    }
  }

  return chunks;
}

/**
 * Estimate token count (rough approximation: ~4 chars per token for English)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Store chunks in database
 */
export async function storeChunks(
  memoryId: string,
  chunks: Array<{ content: string; charCount: number; overlapChars: number }>
): Promise<number> {
  if (chunks.length === 0) return 0;

  const values = chunks.map((chunk, index) => ({
    memoryId,
    chunkIndex: index,
    content: chunk.content,
    charCount: chunk.charCount,
    tokenEstimate: estimateTokens(chunk.content),
    overlapChars: chunk.overlapChars,
  }));

  try {
    await db.execute(sql`
      INSERT INTO memory_chunks (memory_id, chunk_index, content, char_count, token_estimate, overlap_chars)
      SELECT
        v.memory_id,
        v.chunk_index,
        v.content,
        v.char_count,
        v.token_estimate,
        v.overlap_chars
      FROM (
        VALUES ${sql.join(
          values.map(v => sql`(
            ${v.memoryId}::text,
            ${v.chunkIndex}::int,
            ${v.content}::text,
            ${v.charCount}::int,
            ${v.tokenEstimate}::int,
            ${v.overlapChars}::int
          )`),
          sql`, `
        )}
      ) AS v(memory_id, chunk_index, content, char_count, token_estimate, overlap_chars)
      ON CONFLICT (memory_id, chunk_index) DO UPDATE
      SET content = EXCLUDED.content,
          char_count = EXCLUDED.char_count,
          token_estimate = EXCLUDED.token_estimate,
          overlap_chars = EXCLUDED.overlap_chars
    `);

    return chunks.length;
  } catch (error) {
    console.error('Failed to store chunks:', error);
    throw error;
  }
}

/**
 * Get chunks for a memory
 */
export async function getChunks(memoryId: string): Promise<MemoryChunk[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      memory_id as "memoryId",
      chunk_index as "chunkIndex",
      content,
      char_count as "charCount",
      token_estimate as "tokenEstimate",
      overlap_chars as "overlapChars",
      created_at as "createdAt",
      processed_at as "processedAt"
    FROM memory_chunks
    WHERE memory_id = ${memoryId}
    ORDER BY chunk_index
  `);

  return (result as unknown as { rows: MemoryChunk[] }).rows;
}

/**
 * Reassemble chunks into full content
 */
export async function reassembleContent(memoryId: string): Promise<string> {
  const chunks = await getChunks(memoryId);

  if (chunks.length === 0) return '';
  if (chunks.length === 1) return chunks[0]!.content;

  // Reassemble, removing overlap
  let content = chunks[0]!.content;

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    // Skip the overlap portion (which is already in previous chunk)
    const nonOverlap = chunk.content.slice(chunk.overlapChars);
    content += nonOverlap;
  }

  return content;
}

/**
 * Mark chunk as processed
 */
export async function markChunkProcessed(chunkId: string): Promise<void> {
  await db.execute(sql`
    UPDATE memory_chunks
    SET processed_at = NOW()
    WHERE id = ${chunkId}::uuid
  `);
}

/**
 * Mark all chunks for a memory as processed
 */
export async function markAllChunksProcessed(memoryId: string): Promise<void> {
  await db.execute(sql`
    UPDATE memory_chunks
    SET processed_at = NOW()
    WHERE memory_id = ${memoryId}
  `);
}

/**
 * Delete chunks for a memory
 */
export async function deleteChunks(memoryId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM memory_chunks WHERE memory_id = ${memoryId}
  `);
}

/**
 * Get unprocessed chunks across all memories
 */
export async function getUnprocessedChunks(limit: number = 100): Promise<MemoryChunk[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      memory_id as "memoryId",
      chunk_index as "chunkIndex",
      content,
      char_count as "charCount",
      token_estimate as "tokenEstimate",
      overlap_chars as "overlapChars",
      created_at as "createdAt",
      processed_at as "processedAt"
    FROM memory_chunks
    WHERE processed_at IS NULL
    ORDER BY created_at
    LIMIT ${limit}
  `);

  return (result as unknown as { rows: MemoryChunk[] }).rows;
}

/**
 * Get chunk count for a memory
 */
export async function getChunkCount(memoryId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*) as count FROM memory_chunks WHERE memory_id = ${memoryId}
  `);

  const rows = (result as unknown as { rows: Array<{ count: number }> }).rows;
  return rows[0]?.count || 0;
}
