/**
 * Telegram Source Adapter (W34)
 *
 * Converts Telegram bot message data into the canonical IngestItem format.
 */

import { createHash } from 'crypto';
import type { IngestItem, SourceAdapter } from '../types.js';

interface TelegramMessageData {
  chatId: number;
  messageId: number;
  senderId: number;
  senderName: string;
  senderUsername?: string;
  text?: string;
  voice?: { fileId: string; duration: number };
  timestamp: string;
}

export const telegramAdapter: SourceAdapter = {
  name: 'telegram',

  toIngestItem(raw: unknown): IngestItem | null {
    const data = raw as TelegramMessageData;

    const content = data.text || '';
    if (!content && !data.voice) return null;

    const contentType = data.voice ? 'voice' : (
      content.match(/^https?:\/\//) ? 'link' : 'text'
    );

    const contentHash = createHash('sha256')
      .update(`telegram:${data.chatId}:${data.messageId}:${content}`)
      .digest('hex');

    return {
      id: `tg-${data.chatId}-${data.messageId}`,
      source: 'telegram',
      contentType,
      content,
      mediaUrl: data.voice?.fileId,
      sender: {
        id: String(data.senderId),
        name: data.senderName,
        handle: data.senderUsername,
      },
      channel: {
        id: String(data.chatId),
        name: undefined,
        platform: 'telegram',
      },
      contentHash,
      originTimestamp: data.timestamp,
      metadata: {
        messageId: data.messageId,
        voiceDuration: data.voice?.duration,
      },
    };
  },
};
