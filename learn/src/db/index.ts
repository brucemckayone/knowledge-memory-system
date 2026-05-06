import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { config } from '../config.js';
import * as schema from './schema.js';

const client = createClient({ url: `file:${config.DB_PATH}` });
export const db = drizzle(client, { schema });

export * from './schema.js';
