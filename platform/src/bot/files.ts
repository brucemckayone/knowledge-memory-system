import { config } from '../config.js';

/**
 * Get download URL for a Telegram file
 */
export async function getFileUrl(fileId: string): Promise<string> {
  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  
  const data = await response.json() as { ok: boolean; result?: { file_path: string }; description?: string };
  
  if (!data.ok) {
    throw new Error(`Failed to get file: ${data.description}`);
  }
  
  const filePath = data.result?.file_path;
  if (!filePath) {
    throw new Error('No file path in response');
  }
  
  return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
}
