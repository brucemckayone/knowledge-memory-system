import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url(),

  // Qdrant
  QDRANT_URL: z.string().url().default('http://localhost:6333'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  WEBHOOK_URL: z.string().url().optional(),

  // ML Services
  ML_SERVICES_URL: z.string().url().default('http://localhost:8000'),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().default(2),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
