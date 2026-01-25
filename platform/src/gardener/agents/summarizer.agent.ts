/**
 * Summarizer Agent (W24)
 *
 * KARMA agent that generates summaries and key points for memories.
 * Updates embeddings with summary-enhanced content.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';

interface SummarizerPayload {
  memoryId?: string;
  contentType?: string;
  wordCount?: number;
  batchMode?: boolean;  // For scheduled runs
  limit?: number;
}

interface SummaryResult {
  summary: string;
  key_points: string[];
  style: string;
}

const SUMMARY_STYLES: Record<string, string> = {
  thought: 'concise',
  link: 'article',
  task: 'action',
  event: 'timeline',
  note: 'bullet',
  question: 'answer',
  default: 'standard',
};

export const summarizerAgent: GardenerAgent = {
  name: 'summarize',
  tier: 'frequent',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as SummarizerPayload;

    // Handle scheduled batch mode
    if (payload.batchMode || (!payload.memoryId)) {
      return executeBatch(context);
    }

    // Single memory mode
    if (!payload.memoryId) {
      log('Missing required field: memoryId', 'error');
      return { success: false };
    }

    log(`Summarizing memory ${payload.memoryId.slice(0, 8)}...`);

    try {
      // Get memory content
      const content = await fetchMemoryContent(payload.memoryId);

      if (!content) {
        log('No content found', 'warn');
        return {
          success: true,
          metrics: { confidence: 0.5, itemsProcessed: 0 },
        };
      }

      // Determine summary style based on content type
      const style = SUMMARY_STYLES[payload.contentType || 'default'] ?? 'standard';

      // Generate summary
      const result = await generateSummary(content, style);

      log(`Generated ${result.key_points.length} key points`);

      // Store summary
      await storeSummary(payload.memoryId, result);

      // Update embedding with summary-enhanced content
      await updateEmbedding(payload.memoryId, content, result.summary);

      return {
        success: true,
        outputs: {
          summaryLength: result.summary.length,
          keyPointCount: result.key_points.length,
          style: result.style,
        },
        metrics: {
          confidence: 0.85,
          itemsProcessed: 1,
        },
      };

    } catch (error) {
      log(`Summarization failed: ${error}`, 'error');
      return { success: false };
    }
  },
};

/**
 * Execute batch summarization for scheduled runs
 */
async function executeBatch(context: AgentContext): Promise<JobResult> {
  const { job, log, checkpoint, restoreCheckpoint } = context;
  const payload = job.data as SummarizerPayload;

  const limit = payload.limit || 20;

  // Restore checkpoint
  const state = await restoreCheckpoint() as { processedIds?: string[] } | null;
  const processedIds = new Set<string>(state?.processedIds || []);

  log(`Batch mode: processing up to ${limit} memories`);

  try {
    // Find memories needing summarization
    const memories = await findMemoriesNeedingSummary(limit);

    if (memories.length === 0) {
      log('No memories need summarization');
      return {
        success: true,
        metrics: { confidence: 1.0, itemsProcessed: 0 },
      };
    }

    let processed = 0;
    let failed = 0;

    for (const memory of memories) {
      if (processedIds.has(memory.id)) continue;

      try {
        const content = memory.content;
        const style = SUMMARY_STYLES[memory.type || 'default'] ?? 'standard';

        const result = await generateSummary(content, style);
        await storeSummary(memory.id, result);
        await updateEmbedding(memory.id, content, result.summary);

        processed++;
        processedIds.add(memory.id);

        // Checkpoint every 5 processed
        if (processed % 5 === 0) {
          await checkpoint({ processedIds: Array.from(processedIds) });
        }

      } catch (error) {
        log(`Failed to summarize ${memory.id.slice(0, 8)}: ${error}`, 'warn');
        failed++;
      }
    }

    log(`Batch complete: ${processed} processed, ${failed} failed`);

    return {
      success: true,
      outputs: {
        processed,
        failed,
        total: memories.length,
      },
      metrics: {
        confidence: processed > 0 ? 0.9 : 0.5,
        itemsProcessed: processed,
      },
    };

  } catch (error) {
    log(`Batch summarization failed: ${error}`, 'error');

    // Save checkpoint on failure
    await checkpoint({ processedIds: Array.from(processedIds) });

    return { success: false };
  }
}

/**
 * Generate summary via ML service
 */
async function generateSummary(content: string, style: string): Promise<SummaryResult> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: content,
        style,
        max_length: 200,
        include_key_points: true,
      }),
    });

    if (!response.ok) {
      return fallbackSummary(content, style);
    }

    const data = await response.json() as {
      summary?: string;
      key_points?: string[];
    };

    return {
      summary: data.summary || content.slice(0, 200),
      key_points: data.key_points || [],
      style,
    };

  } catch (error) {
    console.warn('Summary generation failed:', error);
    return fallbackSummary(content, style);
  }
}

/**
 * Fallback summary when ML service unavailable
 */
function fallbackSummary(content: string, style: string): SummaryResult {
  // Simple extractive summary - first and last sentences
  const sentences = content.split(/[.!?]+\s+/);
  const summary = sentences.length > 2
    ? `${sentences[0]}. ${sentences[sentences.length - 1]}.`
    : content.slice(0, 200);

  // Extract key phrases (simple approach)
  const words = content.toLowerCase().split(/\s+/);
  const wordFreq = new Map<string, number>();

  for (const word of words) {
    if (word.length > 4) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
  }

  const keyPoints = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word);

  return {
    summary,
    key_points: keyPoints,
    style,
  };
}

/**
 * Store summary in database
 */
async function storeSummary(memoryId: string, result: SummaryResult): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO memory_summaries (
        memory_id, summary_type, summary, key_points, model_used
      ) VALUES (
        ${memoryId},
        ${result.style},
        ${result.summary},
        ${JSON.stringify(result.key_points)}::jsonb,
        'ollama'
      )
    `);
  } catch (error) {
    console.error('Failed to store summary:', error);
  }
}

/**
 * Update embedding with summary-enhanced content
 */
async function updateEmbedding(
  memoryId: string,
  content: string,
  summary: string
): Promise<void> {
  try {
    // Create enhanced text: summary + content
    const enhancedText = `${summary}\n\n${content}`;

    // Generate new embedding
    const embedResponse = await fetch(`${config.ML_SERVICES_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: enhancedText.slice(0, 8000) }),
    });

    if (!embedResponse.ok) {
      console.warn('Embedding generation failed');
      return;
    }

    const embedData = await embedResponse.json() as {
      vector?: number[];
      embedding?: number[];
    };
    const vector = embedData.vector || embedData.embedding;

    if (!vector || vector.length === 0) {
      return;
    }

    // Update in Qdrant
    await fetch(`${config.QDRANT_URL}/collections/memories/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: [{
          id: memoryId,
          vector,
          payload: {
            summary,
            embedding_updated_at: new Date().toISOString(),
          },
        }],
      }),
    });

    // Mark as updated in database
    await db.execute(sql`
      UPDATE memory_summaries
      SET embedding_updated = true
      WHERE memory_id = ${memoryId}
    `);

  } catch (error) {
    console.warn('Failed to update embedding:', error);
  }
}

/**
 * Fetch memory content from Qdrant
 */
async function fetchMemoryContent(memoryId: string): Promise<string> {
  try {
    const response = await fetch(`${config.QDRANT_URL}/collections/memories/points/${memoryId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return '';
    }

    const data = await response.json() as {
      result?: { payload?: { content?: string } };
    };

    return data.result?.payload?.content || '';

  } catch (error) {
    console.warn('Failed to fetch from Qdrant:', error);
    return '';
  }
}

/**
 * Find memories that need summarization
 */
async function findMemoriesNeedingSummary(
  limit: number
): Promise<Array<{ id: string; content: string; type: string }>> {
  try {
    // Find memories with metadata but no summary
    const result = await db.execute(sql`
      SELECT
        m.memory_id as id,
        m.content_type as type
      FROM memory_metadata m
      LEFT JOIN memory_summaries s ON m.memory_id = s.memory_id
      WHERE s.id IS NULL
        AND m.word_count >= 100
      ORDER BY m.parsed_at DESC
      LIMIT ${limit}
    `);

    const rows = (result as unknown as { rows: Array<{ id: string; type: string }> }).rows;

    // Fetch content for each
    const memories: Array<{ id: string; content: string; type: string }> = [];

    for (const row of rows) {
      const content = await fetchMemoryContent(row.id);
      if (content) {
        memories.push({
          id: row.id,
          content,
          type: row.type,
        });
      }
    }

    return memories;

  } catch (error) {
    console.warn('Failed to find memories:', error);
    return [];
  }
}
