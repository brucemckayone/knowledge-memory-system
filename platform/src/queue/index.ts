import PgBoss from 'pg-boss';
import { config } from '../config.js';

let boss: PgBoss | null = null;

/**
 * Initialize pg-boss queue
 */
export async function initQueue(): Promise<PgBoss> {
  if (boss) return boss;

  boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    // Queue configuration
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 60 * 60, // 1 hour
    archiveCompletedAfterSeconds: 60 * 60 * 24, // 24 hours
    deleteAfterSeconds: 60 * 60 * 24 * 7, // 7 days
  });

  // Event handlers
  boss.on('error', (error) => {
    console.error('❌ Queue error:', error);
  });

  boss.on('monitor-states', (states) => {
    console.log('📊 Queue states:', states);
  });

  await boss.start();
  console.log('✅ pg-boss queue started');

  return boss;
}

/**
 * Get queue instance (must call initQueue first)
 */
export function getQueue(): PgBoss {
  if (!boss) {
    throw new Error('Queue not initialized. Call initQueue() first.');
  }
  return boss;
}

/**
 * Queue names
 */
export const QUEUES = {
  MESSAGE_PROCESSING: 'message-processing',
  CONTEXT_UPDATE: 'context-update',
  GARDENER: 'gardener',
} as const;

/**
 * Shutdown queue gracefully
 */
export async function shutdownQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30000 });
    boss = null;
    console.log('✅ Queue stopped');
  }
}
