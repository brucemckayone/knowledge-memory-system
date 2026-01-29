#!/usr/bin/env tsx
/**
 * Task Cleanup Script
 *
 * Removes low-quality test/seed tasks from the database.
 *
 * Cleanup Criteria:
 * - Content length < 15 characters
 * - Matches test patterns: "verify", "check out", "example.com", "E2E-TEST"
 * - Starts with question mark: "? What..."
 * - Bulk creation: 2026-01-26 22:00 hour + generic content
 * - Exact duplicates of common test phrases
 *
 * Usage:
 *   npm run cleanup:tasks -- --dry-run   # Preview deletions
 *   npm run cleanup:tasks -- --force     # Execute deletion
 */

import { db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import { eq, or, like, sql, and, gte, lte, inArray } from 'drizzle-orm';

// Cleanup patterns
const SHORT_TASK_THRESHOLD = 15;
const TEST_PATTERNS = [
  'verify',
  'check out',
  'example.com',
  'E2E-TEST',
  'test task',
  'sample task',
];

// Question pattern - tasks starting with "?"
const QUESTION_PATTERN = '?%';

// Bulk creation timeframe (2026-01-26 22:00 to 23:00 UTC)
const BULK_START = new Date('2026-01-26T22:00:00Z');
const BULK_END = new Date('2026-01-26T23:00:00Z');

// Generic low-content phrases from bulk creation
const GENERIC_PHRASES = [
  'do something',
  'task to do',
  'some task',
  'a task',
  'todo item',
];

interface CleanupStats {
  totalBefore: number;
  shortContent: number;
  testPatterns: number;
  questionStart: number;
  bulkGeneric: number;
  totalToDelete: number;
  idsToDelete: string[];
}

/**
 * Check if content matches test patterns
 */
function matchesTestPattern(content: string): boolean {
  const lower = content.toLowerCase();
  return TEST_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Check if content is a generic low-quality phrase
 */
function isGenericPhrase(content: string): boolean {
  const lower = content.toLowerCase().trim();
  return GENERIC_PHRASES.some(phrase => lower === phrase || lower === `the ${phrase}`);
}

/**
 * Analyze tasks to determine what should be deleted
 */
async function analyzeTasks(): Promise<CleanupStats> {
  console.log('🔍 Analyzing tasks for cleanup...\n');

  // Get total count before
  const allTasks = await db.select({ count: sql<number>`count(*)::int` }).from(tasks);
  const totalBefore = allTasks[0]?.count || 0;

  console.log(`📊 Total tasks before cleanup: ${totalBefore}\n`);

  // Find tasks with short content
  const shortContentTasks = await db
    .select({ id: tasks.id, content: tasks.content, createdAt: tasks.createdAt })
    .from(tasks)
    .where(sql`length(${tasks.content}) < ${SHORT_TASK_THRESHOLD}`);

  console.log(`📏 Tasks with < ${SHORT_TASK_THRESHOLD} chars: ${shortContentTasks.length}`);

  // Find tasks matching test patterns
  const testPatternConditions = TEST_PATTERNS.map(pattern =>
    like(tasks.content, `%${pattern}%`)
  );
  const testPatternTasks = await db
    .select({ id: tasks.id, content: tasks.content })
    .from(tasks)
    .where(or(...testPatternConditions));

  console.log(`🧪 Tasks matching test patterns: ${testPatternTasks.length}`);

  // Find tasks starting with question mark
  const questionTasks = await db
    .select({ id: tasks.id, content: tasks.content })
    .from(tasks)
    .where(like(tasks.content, QUESTION_PATTERN));

  console.log(`❓ Tasks starting with '?': ${questionTasks.length}`);

  // Find generic tasks from bulk creation period
  const bulkGenericTasks = await db
    .select({ id: tasks.id, content: tasks.content, createdAt: tasks.createdAt })
    .from(tasks)
    .where(
      and(
        gte(tasks.createdAt, BULK_START),
        lte(tasks.createdAt, BULK_END)
      )
    );

  // Filter for generic phrases
  const genericTasks = bulkGenericTasks.filter(t => isGenericPhrase(t.content));
  console.log(`📦 Generic bulk tasks (${BULK_START.toISOString()} - ${BULK_END.toISOString()}): ${genericTasks.length}`);

  // Collect all IDs to delete (using Set for deduplication)
  const idsToDelete = new Set<string>();

  shortContentTasks.forEach(t => idsToDelete.add(t.id));
  testPatternTasks.forEach(t => idsToDelete.add(t.id));
  questionTasks.forEach(t => idsToDelete.add(t.id));
  genericTasks.forEach(t => idsToDelete.add(t.id));

  console.log(`\n✅ Unique tasks to delete: ${idsToDelete.size}\n`);

  // Show some examples
  console.log('📋 Sample tasks to be deleted:');
  const sampleIds = Array.from(idsToDelete).slice(0, 10);
  const sampleTasks = await db
    .select({ id: tasks.id, content: tasks.content, createdAt: tasks.createdAt })
    .from(tasks)
    .where(inArray(tasks.id, sampleIds))
    .limit(10);

  for (const task of sampleTasks) {
    const reason = [];
    if (task.content.length < SHORT_TASK_THRESHOLD) reason.push('short');
    if (matchesTestPattern(task.content)) reason.push('test pattern');
    if (task.content.startsWith('?')) reason.push('question');
    if (isGenericPhrase(task.content)) reason.push('generic');

    console.log(`  - "${task.content.slice(0, 60)}${task.content.length > 60 ? '...' : ''}"`);
    console.log(`    Reason: ${reason.join(', ')}`);
  }

  if (idsToDelete.size > 10) {
    console.log(`  ... and ${idsToDelete.size - 10} more`);
  }

  return {
    totalBefore,
    shortContent: shortContentTasks.length,
    testPatterns: testPatternTasks.length,
    questionStart: questionTasks.length,
    bulkGeneric: genericTasks.length,
    totalToDelete: idsToDelete.size,
    idsToDelete: Array.from(idsToDelete),
  };
}

/**
 * Delete tasks based on analysis
 */
async function deleteTasks(stats: CleanupStats): Promise<void> {
  console.log('\n🗑️  Deleting tasks...');

  const batchSize = 100;
  const idsToDelete = stats.idsToDelete;

  for (let i = 0; i < idsToDelete.length; i += batchSize) {
    const batch = idsToDelete.slice(i, i + batchSize);
    await db.delete(tasks).where(inArray(tasks.id, batch));
    console.log(`   Deleted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(idsToDelete.length / batchSize)} (${batch.length} tasks)`);
  }

  console.log(`✅ Deleted ${idsToDelete.length} tasks`);

  // Get total count after
  const allTasks = await db.select({ count: sql<number>`count(*)::int` }).from(tasks);
  const totalAfter = allTasks[0]?.count || 0;

  console.log(`\n📊 Tasks remaining: ${totalAfter}`);
  console.log(`📉 Tasks removed: ${stats.totalBefore - totalAfter}`);
}

/**
 * Verify cleanup results
 */
async function verifyCleanup(stats: CleanupStats): Promise<void> {
  console.log('\n🔍 Verifying cleanup results...\n');

  const allTasks = await db.select({ count: sql<number>`count(*)::int` }).from(tasks);
  const totalAfter = allTasks[0]?.count || 0;

  // Calculate average content length
  const avgLengthResult = await db
    .select({ avg: sql<number>`avg(length(${tasks.content}))::int` })
    .from(tasks);

  const avgLength = avgLengthResult[0]?.avg || 0;

  console.log(`📊 Total tasks after cleanup: ${totalAfter}`);
  console.log(`📏 Average content length: ${avgLength} characters`);

  // Check for remaining low-quality tasks
  const remainingShort = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(sql`length(${tasks.content}) < ${SHORT_TASK_THRESHOLD}`);

  console.log(`📏 Remaining tasks with < ${SHORT_TASK_THRESHOLD} chars: ${remainingShort[0]?.count || 0}`);

  // Check for remaining test pattern tasks
  const testPatternConditions = TEST_PATTERNS.map(pattern =>
    like(tasks.content, `%${pattern}%`)
  );
  const remainingTestPatterns = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(or(...testPatternConditions));

  console.log(`🧪 Remaining tasks with test patterns: ${remainingTestPatterns[0]?.count || 0}`);

  if (avgLength > 40) {
    console.log('\n✅ Cleanup successful! Average content length > 40 chars');
  } else {
    console.log('\n⚠️  Average content length still below 40 chars. Manual review recommended.');
  }

  if ((remainingShort[0]?.count || 0) === 0) {
    console.log('✅ No short content tasks remaining');
  }

  if ((remainingTestPatterns[0]?.count || 0) === 0) {
    console.log('✅ No test pattern tasks remaining');
  }
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--force');
  const force = args.includes('--force');

  if (force && !dryRun) {
    console.log('🚨 FORCE MODE ENABLED - WILL DELETE TASKS\n');
  } else {
    console.log('🔍 DRY RUN MODE - WILL NOT DELETE TASKS (use --force to execute)\n');
  }

  try {
    // Analyze tasks
    const stats = await analyzeTasks();

    // Confirm before deletion
    if (!dryRun && stats.totalToDelete > 0) {
      console.log(`\n⚠️  About to delete ${stats.totalToDelete} tasks.`);
      console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Delete if not dry run
    if (!dryRun && stats.totalToDelete > 0) {
      await deleteTasks(stats);
      await verifyCleanup(stats);
    } else if (dryRun) {
      console.log('\n💡 Run with --force to execute deletion:');
      console.log('   npm run cleanup:tasks -- --force');
    } else {
      console.log('\n✅ No tasks to delete');
    }

  } catch (error) {
    console.error('\n❌ Cleanup failed:', error);
    process.exit(1);
  }
}

main();
