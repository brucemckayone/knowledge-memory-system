/**
 * Shared formatting utilities
 */

export const PRIORITY_EMOJI: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
};

export function priorityEmoji(priority?: string): string {
  return PRIORITY_EMOJI[priority || 'medium'] || '🟡';
}
