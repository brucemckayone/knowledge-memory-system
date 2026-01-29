/**
 * Task Deduplication Service
 *
 * ⚠️ CRITICAL DESIGN NOTE: Context-Aware Deduplication ⚠️
 *
 * **Problem**: Tasks with identical text may NOT be duplicates if they belong to different contexts/groups.
 *
 * **Example**:
 * - "Return the car to the lot" (personal/family car) vs "Return the car to the lot" (work/rental car)
 * - Both have the SAME text but are DIFFERENT tasks
 *
 * **Solution Approach**:
 * 1. **Context-scoped deduplication**: Only check for duplicates within the same context (conversation)
 *    - Current implementation does this via the `contextId` parameter
 *    - This handles the case where the same task appears in different conversations
 *
 * 2. **Future: LLM-based semantic deduplication** (RECOMMENDED for production):
 *    - Use LLM to compare task contexts, not just text
 *    - Extract: who, what, when, which entity, which life area
 *    - Only dedupe if ALL attributes match, not just text
 *    - Example prompt:
 *      "Are these tasks truly the same or just similar wording?
 *       Task A: 'Return the car' (context: family vacation, personal car)
 *       Task B: 'Return the car' (context: work trip, rental car)
 *       Answer: Different tasks (different cars, different purposes)"
 *
 * 3. **Task enrichment with entities**:
 *    - Extract entities during task creation (which car? whose car?)
 *    - Compare entities along with text
 *    - "Return the Toyota Camry" ≠ "Return the Ford Fiesta"
 *
 * **Current Implementation**:
 * - Simple fuzzy matching within the same context
 * - Semantic similarity using Qdrant embeddings
 * - Safe for now because different conversations = different contextIds
 * - But within the SAME conversation, we might still get false duplicates
 *
 * **Production Recommendation**:
 * - Use contextId parameter (always scope to conversation)
 * - Implement LLM-based deduplication for within-conversation checks
 * - Enrich tasks with entity metadata for better disambiguation
 *
 * Prevents creation of duplicate tasks using multiple strategies:
 * 1. Exact match check (case-insensitive)
 * 2. Semantic similarity (embedding cosine similarity > 0.90)
 * 3. Fuzzy string match (Levenshtein distance > 80%)
 *
 * Phase 5: Added semantic similarity using Qdrant embeddings
 */

import { db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { searchMemories } from './qdrant.js';

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingTask?: {
    id: string;
    content: string;
    similarity: number;
    method: 'exact' | 'fuzzy' | 'semantic';
  };
}

// Thresholds
const FUZZY_SIMILARITY_THRESHOLD = 0.80; // 80% similarity
const SEMANTIC_SIMILARITY_THRESHOLD = 0.90; // 90% similarity for duplicates
const RECENT_TASK_HOURS = 24; // Only check tasks from last 24 hours

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[len1][len2];
}

/**
 * Calculate similarity ratio (0-1) using Levenshtein distance
 */
function fuzzySimilarity(str1: string, str2: string): number {
  const normalized1 = str1.toLowerCase().trim();
  const normalized2 = str2.toLowerCase().trim();

  if (normalized1 === normalized2) return 1.0;
  if (normalized1.length === 0 || normalized2.length === 0) return 0.0;

  const distance = levenshteinDistance(normalized1, normalized2);
  const maxLength = Math.max(normalized1.length, normalized2.length);

  return 1 - distance / maxLength;
}

/**
 * Check for semantic duplicates using vector embeddings
 *
 * Searches Qdrant for semantically similar tasks and returns
 * the closest match if above the SEMANTIC_SIMILARITY_THRESHOLD.
 *
 * @param action - The task action to check
 * @param embedding - The task embedding vector
 * @param contextId - Optional context UUID to scope the search
 * @returns Duplicate check result
 */
export async function checkSemanticDuplicate(
  action: string,
  embedding: number[],
  contextId?: string
): Promise<DuplicateCheckResult> {
  try {
    // Build filter for context and type
    const filter: Record<string, unknown> = {
      type: 'task',
    };

    if (contextId) {
      filter.context_id = contextId;
    }

    // Search Qdrant for semantically similar tasks
    const results = await searchMemories(embedding, {
      limit: 5,
      filter,
      with_payload: true,
    });

    // Check results for duplicates
    for (const result of results) {
      if (result.score >= SEMANTIC_SIMILARITY_THRESHOLD) {
        const payload = result.payload as Record<string, unknown>;

        // Only consider if it's a task type with a task_id
        if (payload.type === 'task' && payload.task_id && typeof payload.task_id === 'string') {
          return {
            isDuplicate: true,
            existingTask: {
              id: payload.task_id,
              content: (payload.content || payload.summary || '') as string,
              similarity: result.score,
              method: 'semantic',
            },
          };
        }
      }
    }

    return { isDuplicate: false };
  } catch (error) {
    console.error('Semantic duplicate check failed:', error);
    // Fall back to no duplicate on error
    return { isDuplicate: false };
  }
}

/**
 * Check if a task is a duplicate of existing tasks
 *
 * Performs multiple checks in order:
 * 1. Exact match (case-insensitive)
 * 2. Semantic similarity (if embedding provided)
 * 3. Fuzzy similarity (Levenshtein distance)
 *
 * @param action - The extracted task action to check
 * @param contextId - Optional context UUID to scope the search
 * @param embedding - Optional embedding vector for semantic check
 * @returns Duplicate check result
 */
export async function checkDuplicate(
  action: string,
  contextId?: string,
  embedding?: number[]
): Promise<DuplicateCheckResult> {
  // Skip very short actions (likely not specific enough to be duplicates)
  if (action.length < 15) {
    return { isDuplicate: false };
  }

  const normalizedAction = action.toLowerCase().trim();

  // Build time filter (last 24 hours)
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - RECENT_TASK_HOURS);

  // Fetch recent pending tasks
  const recentTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'pending'),
        gte(tasks.createdAt, cutoffTime),
        contextId ? eq(tasks.contextId, contextId) : undefined
      )
    )
    .limit(50); // Check last 50 recent tasks

  // Check 1: Exact match (case-insensitive)
  for (const task of recentTasks) {
    if (task.content.toLowerCase().trim() === normalizedAction) {
      return {
        isDuplicate: true,
        existingTask: {
          id: task.id,
          content: task.content,
          similarity: 1.0,
          method: 'exact',
        },
      };
    }
  }

  // Check 2: Semantic similarity (if embedding provided)
  if (embedding) {
    const semanticResult = await checkSemanticDuplicate(action, embedding, contextId);
    if (semanticResult.isDuplicate && semanticResult.existingTask) {
      return semanticResult;
    }
  }

  // Check 3: Fuzzy similarity
  for (const task of recentTasks) {
    const similarity = fuzzySimilarity(action, task.content);

    if (similarity >= FUZZY_SIMILARITY_THRESHOLD) {
      return {
        isDuplicate: true,
        existingTask: {
          id: task.id,
          content: task.content,
          similarity,
          method: 'fuzzy',
        },
      };
    }
  }

  // No duplicate found
  return { isDuplicate: false };
}
