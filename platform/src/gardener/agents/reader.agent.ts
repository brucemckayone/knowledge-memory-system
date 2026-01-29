/**
 * Reader Agent (W23)
 *
 * KARMA agent that parses and classifies memory content.
 * Extracts metadata like dates, links, tags, and mentions.
 */

import type { AgentContext, JobResult, GardenerAgent, GardenerJob } from '../controller.js';
import { reassembleContent, markAllChunksProcessed } from '../../services/chunks.js';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { parseContent } from '../../services/ml.js';
import { getMemory, updatePayload } from '../../services/qdrant.js';

interface ReaderPayload {
  memoryId: string;
  contentLength?: number;
  chunked?: boolean;
  chunkCount?: number;
  type?: string;
  source?: string;
  content?: string;  // Optional: if provided, skip chunk reassembly
}

interface ParsedContent {
  content_type: string;
  title: string;
  summary: string;
  mentions: string[];
  dates: string[];
  links: string[];
  tags: string[];
  sentiment: string;
  language: string;
  word_count: number;
}

const MIN_LENGTH_FOR_SUMMARIZER = 500;  // Only summarize longer content

export const readerAgent: GardenerAgent = {
  name: 'reader',
  tier: 'realtime',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as ReaderPayload;

    if (!payload.memoryId) {
      log('Missing required field: memoryId', 'error');
      return { success: false };
    }

    log(`Reading memory ${payload.memoryId.slice(0, 8)}...`);

    try {
      // Get content - either from payload, chunks, or fetch from Qdrant
      let content: string;

      if (payload.content) {
        content = payload.content;
      } else if (payload.chunked) {
        log('Reassembling from chunks...');
        content = await reassembleContent(payload.memoryId);
      } else {
        // Fetch from Qdrant
        content = await fetchMemoryContent(payload.memoryId);
      }

      if (!content) {
        log('No content found', 'warn');
        return {
          success: true,
          metrics: { confidence: 0.5, itemsProcessed: 0 },
        };
      }

      // Call ML service for content parsing
      const parsed = await parseContent(content, payload.type);

      log(`Parsed as: ${parsed.content_type} (${parsed.word_count} words)`);

      // Store metadata in database
      await storeMetadata(payload.memoryId, parsed);

      // Update Qdrant payload with parsed metadata
      await updateQdrantPayload(payload.memoryId, parsed);

      // Mark chunks as processed if we had any
      if (payload.chunked) {
        await markAllChunksProcessed(payload.memoryId);
      }

      // Queue summarizer for longer content
      const nextJobs: GardenerJob[] = [];

      if (parsed.word_count >= MIN_LENGTH_FOR_SUMMARIZER) {
        nextJobs.push({
          type: 'gardener:summarize',
          tier: 'frequent',
          payload: {
            memoryId: payload.memoryId,
            contentType: parsed.content_type,
            wordCount: parsed.word_count,
          },
        });
        log('Queued summarizer for long content');
      }

      return {
        success: true,
        outputs: {
          contentType: parsed.content_type,
          wordCount: parsed.word_count,
          tagsFound: parsed.tags.length,
          mentionsFound: parsed.mentions.length,
          linksFound: parsed.links.length,
        },
        nextJobs,
        metrics: {
          confidence: 0.9,
          itemsProcessed: 1,
        },
      };

    } catch (error) {
      log(`Reader failed: ${error}`, 'error');
      return { success: false };
    }
  },
};

// parseContent is imported from services/ml.js



/**
 * Store parsed metadata in database
 */
async function storeMetadata(memoryId: string, parsed: ParsedContent): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO memory_metadata (
        memory_id, content_type, title, summary,
        extracted_dates, extracted_links, extracted_tags,
        mentioned_entities, word_count, language, sentiment
      ) VALUES (
        ${memoryId},
        ${parsed.content_type},
        ${parsed.title},
        ${parsed.summary},
        ${JSON.stringify(parsed.dates)}::jsonb,
        ${JSON.stringify(parsed.links)}::jsonb,
        ${sql.raw(`ARRAY[${parsed.tags.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]::text[]`)},
        ${sql.raw(`ARRAY[${parsed.mentions.map(m => `'${m.replace(/'/g, "''")}'`).join(',')}]::text[]`)},
        ${parsed.word_count},
        ${parsed.language},
        ${parsed.sentiment}
      )
      ON CONFLICT (memory_id) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        extracted_dates = EXCLUDED.extracted_dates,
        extracted_links = EXCLUDED.extracted_links,
        extracted_tags = EXCLUDED.extracted_tags,
        mentioned_entities = EXCLUDED.mentioned_entities,
        word_count = EXCLUDED.word_count,
        language = EXCLUDED.language,
        sentiment = EXCLUDED.sentiment,
        parsed_at = NOW()
    `);
  } catch (error) {
    console.error('Failed to store metadata:', error);
  }
}

/**
 * Update Qdrant payload with parsed metadata
 */
async function updateQdrantPayload(memoryId: string, parsed: ParsedContent): Promise<void> {
  try {
    await updatePayload(memoryId, {
      parsed_type: parsed.content_type,
      tags: parsed.tags,
      mentions: parsed.mentions,
      has_links: parsed.links.length > 0,
      word_count: parsed.word_count,
      sentiment: parsed.sentiment,
      parsed_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('Failed to update Qdrant payload:', error);
  }
}

/**
 * Fetch memory content from Qdrant
 */
async function fetchMemoryContent(memoryId: string): Promise<string> {
  try {
    const memory = await getMemory(memoryId);
    return (memory?.payload?.content as string) || '';
  } catch (error) {
    console.warn('Failed to fetch from Qdrant:', error);
    return '';
  }
}
