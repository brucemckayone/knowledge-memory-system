/**
 * Queue Injector
 *
 * Injects benchmark messages directly into pg-boss queue.
 * Bypasses Telegram bot handlers for speed and control.
 */

import { getQueue } from '../../queue/index.js';
import { QUEUES } from '../../queue/index.js';
import type { BenchmarkMessage } from '../utils/message-factory.js';

/**
 * Injection result tracking
 */
export interface InjectionResult {
  totalMessages: number;
  successful: number;
  failed: number;
  startTime: Date;
  endTime: Date;
  errors: Array<{ messageId: number; error: string }>;
}

/**
 * Message injection tracker
 * Maps benchmark message IDs to pg-boss job IDs for correlation
 */
export class MessageTracker {
  private mapping = new Map<number, string>();

  /**
   * Track a message -> job ID relationship
   */
  track(messageId: number, jobId: string): void {
    this.mapping.set(messageId, jobId);
  }

  /**
   * Get job ID for a message
   */
  getJobId(messageId: number): string | undefined {
    return this.mapping.get(messageId);
  }

  /**
   * Get all tracked messages
   */
  getAllTracked(): Map<number, string> {
    return new Map(this.mapping);
  }

  /**
   * Clear tracking
   */
  clear(): void {
    this.mapping.clear();
  }
}

/**
 * Rate limiter for controlling injection throughput
 */
export class RateLimiter {
  private intervalMs: number;

  constructor(messagesPerSecond: number) {
    this.intervalMs = messagesPerSecond > 0 ? 1000 / messagesPerSecond : 0;
  }

  /**
   * Wait before next injection
   */
  async wait(): Promise<void> {
    if (this.intervalMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.intervalMs));
    }
  }
}

/**
 * Inject messages into pg-boss queue
 */
export async function injectMessages(
  messages: BenchmarkMessage[],
  options: {
    rateLimit?: number; // messages per second, 0 for unlimited
    onProgress?: (injected: number, total: number) => void;
  } = {}
): Promise<InjectionResult> {
  const queue = getQueue();
  const tracker = new MessageTracker();
  const rateLimiter = options.rateLimit ? new RateLimiter(options.rateLimit) : null;

  const result: InjectionResult = {
    totalMessages: messages.length,
    successful: 0,
    failed: 0,
    startTime: new Date(),
    endTime: new Date(),
    errors: [],
  };

  console.log(`📤 Injecting ${messages.length} messages into queue...`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    try {
      // Wait for rate limit
      if (rateLimiter) {
        await rateLimiter.wait();
      }

      // Send to queue
      const jobId = await queue.send(QUEUES.MESSAGE_PROCESSING, {
        chatId: msg.chatId,
        messageId: msg.messageId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        senderUsername: msg.senderUsername,
        text: msg.text,
        voice: msg.voice,
        timestamp: msg.timestamp,
      });

      // Track the job
      if (jobId) {
        tracker.track(msg.messageId, jobId);
      }
      result.successful++;

      // Report progress
      if (options.onProgress && i % 10 === 0) {
        options.onProgress(i + 1, messages.length);
      }

    } catch (error) {
      result.failed++;
      result.errors.push({
        messageId: msg.messageId,
        error: String(error),
      });
      console.error(`❌ Failed to inject message ${msg.messageId}:`, error);
    }
  }

  result.endTime = new Date();

  console.log(`✅ Injection complete: ${result.successful}/${result.totalMessages} successful`);

  if (result.failed > 0) {
    console.warn(`⚠️ ${result.failed} messages failed to inject`);
  }

  return result;
}

/**
 * Inject a single message (useful for debugging)
 */
export async function injectSingleMessage(
  message: BenchmarkMessage
): Promise<string | undefined> {
  const queue = getQueue();

  try {
    const jobId = await queue.send(QUEUES.MESSAGE_PROCESSING, {
      chatId: message.chatId,
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      senderUsername: message.senderUsername,
      text: message.text,
      voice: message.voice,
      timestamp: message.timestamp,
    });

    if (jobId) {
      console.log(`✅ Injected message ${message.messageId} -> job ${jobId}`);
    }
    return jobId || undefined;
  } catch (error) {
    console.error(`❌ Failed to inject message ${message.messageId}:`, error);
    return undefined;
  }
}

/**
 * Wait for queue to drain and processing to complete
 *
 * Monitors the actual database to detect when entities, facts, and tasks
 * have been created, rather than blindly waiting.
 */
export async function waitForQueueCompletion(
  timeoutMs: number = 300000 // 5 minutes default
): Promise<void> {
  const { db } = await import('../../db/index.js');
  const { entities, facts, tasks } = await import('../../db/schema.js');
  const { sql } = await import('drizzle-orm');

  const startTime = Date.now();
  let lastCounts = { entities: 0, facts: 0, tasks: 0 };
  let stableCount = 0;
  const STABLE_THRESHOLD = 3; // Number of consecutive checks with same counts

  console.log('⏳ Waiting for message processing to complete...');

  // Get initial counts
  try {
    const [entityResult, factResult, taskResult] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(entities),
      db.select({ count: sql<number>`count(*)::int` }).from(facts),
      db.select({ count: sql<number>`count(*)::int` }).from(tasks),
    ]);

    lastCounts = {
      entities: entityResult[0]?.count || 0,
      facts: factResult[0]?.count || 0,
      tasks: taskResult[0]?.count || 0,
    };

    console.log(`   📊 Initial: entities=${lastCounts.entities}, facts=${lastCounts.facts}, tasks=${lastCounts.tasks}`);
  } catch (error) {
    console.warn('⚠️ Could not get initial counts:', error);
  }

  // Monitor for changes
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      const [entityResult, factResult, taskResult] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(entities),
        db.select({ count: sql<number>`count(*)::int` }).from(facts),
        db.select({ count: sql<number>`count(*)::int` }).from(tasks),
      ]);

      const currentCounts = {
        entities: entityResult[0]?.count || 0,
        facts: factResult[0]?.count || 0,
        tasks: taskResult[0]?.count || 0,
      };

      const countsChanged =
        currentCounts.entities !== lastCounts.entities ||
        currentCounts.facts !== lastCounts.facts ||
        currentCounts.tasks !== lastCounts.tasks;

      if (countsChanged) {
        console.log(`   📊 Current: entities=${currentCounts.entities}, facts=${currentCounts.facts}, tasks=${currentCounts.tasks}`);
        lastCounts = currentCounts;
        stableCount = 0; // Reset stable counter
      } else {
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD) {
          console.log('✅ Processing complete (counts stabilized)');
          return;
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 30000 && stableCount === 0) {
        console.log(`   ⏳ Still processing after ${(elapsed / 1000).toFixed(1)}s...`);
      }

    } catch (error) {
      console.error('❌ Error checking database:', error);
    }
  }

  console.log('✅ Wait timeout reached, proceeding...');
}
