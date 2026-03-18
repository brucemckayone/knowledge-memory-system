/**
 * Interval Parser
 *
 * Converts human-readable interval strings (e.g., "30s", "5m", "1h")
 * to cron expressions and millisecond values.
 *
 * This enables acceleration of gardener schedules for testing.
 */

/**
 * Parse interval string to seconds
 * Supports: s (seconds), m (minutes), h (hours), d (days)
 */
export function parseIntervalToSeconds(interval: string): number {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid interval format: ${interval}. Expected format: <number><unit> (e.g., 30s, 5m, 1h, 1d)`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
      return value * 86400;
    default:
      throw new Error(`Invalid interval unit: ${unit}. Supported units: s, m, h, d`);
  }
}

/**
 * Parse interval string to milliseconds
 */
export function parseIntervalToMs(interval: string): number {
  return parseIntervalToSeconds(interval) * 1000;
}

/**
 * Convert interval string to cron expression
 *
 * Rules:
 * - Seconds (< 60s): "* /<seconds> * * * * *" (6-field cron with seconds)
 * - Minutes (< 60m): "* /<minutes> * * * *" (5-field cron)
 * - Hours (< 24h): "0 * /<hours> * * *" (at minute 0, every N hours)
 * - Days: "0 0 * /<days> * *" (at 00:00, every N days)
 *
 * @example
 * intervalToCron("30s")  // "* /30 * * * * *"
 * intervalToCron("5m")   // "* /5 * * * *"
 * intervalToCron("1h")   // "0 * * * *"
 * intervalToCron("2h")   // "0 * /2 * * *"
 * intervalToCron("1d")   // "0 0 * * *"
 */
export function intervalToCron(interval: string): string {
  const seconds = parseIntervalToSeconds(interval);

  if (seconds < 60) {
    // Sub-minute intervals require 6-field cron (with seconds field)
    // Note: pg-boss supports 6-field cron
    return `*/${seconds} * * * * *`;
  } else if (seconds < 3600) {
    // Minute intervals: "*/<minutes> * * * *"
    const minutes = Math.floor(seconds / 60);
    return `*/${minutes} * * * *`;
  } else if (seconds < 86400) {
    // Hour intervals: "0 */<hours> * * *"
    const hours = Math.floor(seconds / 3600);
    return `0 */${hours} * * *`;
  } else {
    // Day intervals: "0 0 */<days> * *"
    const days = Math.floor(seconds / 86400);
    return `0 0 */${days} * *`;
  }
}

