import type { Context, NextFunction } from 'grammy';
import { config } from '../config.js';

const userTimestamps = new Map<number, number[]>();

const WINDOW_MS = 60_000;
const MAX_MESSAGES = config.RATE_LIMIT_MESSAGES_PER_MINUTE;

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of userTimestamps) {
    const recent = timestamps.filter(t => now - t < WINDOW_MS);
    if (recent.length === 0) {
      userTimestamps.delete(userId);
    } else {
      userTimestamps.set(userId, recent);
    }
  }
}, 5 * 60_000).unref();

export async function rateLimiter(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await next();
    return;
  }

  const now = Date.now();
  const timestamps = userTimestamps.get(userId) ?? [];
  const recent = timestamps.filter(t => now - t < WINDOW_MS);

  if (recent.length >= MAX_MESSAGES) {
    await ctx.reply('⏳ You\'re sending messages too quickly. Please wait a moment.');
    return;
  }

  recent.push(now);
  userTimestamps.set(userId, recent);
  await next();
}
