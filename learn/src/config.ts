import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NMEMO_URL: z.string().default('http://localhost:3001'),
  PORT: z.coerce.number().default(3002),
  DB_PATH: z.string().default('./learn.db'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid config:', parsed.error.flatten());
  process.exit(1);
}

export const config = parsed.data;
