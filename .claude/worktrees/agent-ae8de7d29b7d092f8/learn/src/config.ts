import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NMEMO_URL: z.string().default('http://localhost:3001'),
  PORT: z.coerce.number().default(3002),
  DB_PATH: z.string().default('./learn.db'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Background patrol cron interval, minutes. Unset/0 = disabled.
  PATROL_INTERVAL_MIN: z.coerce.number().nonnegative().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid config:', parsed.error.flatten());
  process.exit(1);
}

export const config = parsed.data;
