/**
 * Ingestion Agent (W22)
 *
 * KARMA agent that receives new memories and prepares them for processing.
 * Chunks long content and queues downstream agents.
 */

import type { AgentContext, JobResult, GardenerAgent, GardenerJob } from '../controller.js';
import { chunkContent, storeChunks, estimateTokens } from '../../services/chunks.js';

interface IngestionPayload {
  memoryId: string;
  content: string;
  type?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

const MAX_CHUNK_SIZE = 4000;  // chars
const CHUNK_OVERLAP = 200;    // chars
const MIN_CONTENT_LENGTH = 10;

export const ingestionAgent: GardenerAgent = {
  name: 'ingestion',
  tier: 'realtime',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as IngestionPayload;

    // Validate input
    if (!payload.memoryId) {
      log('Missing required field: memoryId', 'error');
      return { success: false };
    }

    if (!payload.content?.trim()) {
      log('Empty content, skipping', 'warn');
      return {
        success: true,
        metrics: { confidence: 1.0, itemsProcessed: 0 },
      };
    }

    const content = payload.content.trim();

    if (content.length < MIN_CONTENT_LENGTH) {
      log(`Content too short (${content.length} chars), skipping`, 'warn');
      return {
        success: true,
        metrics: { confidence: 1.0, itemsProcessed: 0 },
      };
    }

    log(`Processing memory ${payload.memoryId.slice(0, 8)}... (${content.length} chars)`);

    try {
      // Chunk content if needed
      const chunks = chunkContent(content, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
      const needsChunking = chunks.length > 1;

      if (needsChunking) {
        log(`Chunked into ${chunks.length} parts`);
        await storeChunks(payload.memoryId, chunks);
      }

      // Prepare downstream jobs
      const nextJobs: GardenerJob[] = [];

      // Always queue reader agent
      nextJobs.push({
        type: 'gardener:reader',
        tier: 'realtime',
        payload: {
          memoryId: payload.memoryId,
          contentLength: content.length,
          chunked: needsChunking,
          chunkCount: chunks.length,
          type: payload.type,
          source: payload.source,
        },
      });

      // Always queue entity extraction
      nextJobs.push({
        type: 'gardener:extract-entities',
        tier: 'realtime',
        payload: {
          memoryId: payload.memoryId,
          content: content,
          type: payload.type,
        },
      });

      log(`Queued ${nextJobs.length} downstream jobs`);

      return {
        success: true,
        outputs: {
          chunked: needsChunking,
          chunkCount: chunks.length,
          tokenEstimate: estimateTokens(content),
        },
        nextJobs,
        metrics: {
          confidence: 1.0,
          itemsProcessed: chunks.length,
        },
      };

    } catch (error) {
      log(`Ingestion failed: ${error}`, 'error');
      return { success: false };
    }
  },
};
