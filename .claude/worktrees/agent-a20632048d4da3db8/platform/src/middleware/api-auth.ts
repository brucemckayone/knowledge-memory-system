/**
 * API Authentication Middleware (W35)
 *
 * Bearer token authentication for the HTTP ingest API.
 * Validates against MNEMO_API_KEY from config.
 */

import type { Context, Next } from 'hono';
import { config } from '../config.js';

export async function apiAuth(c: Context, next: Next): Promise<Response | void> {
  const apiKey = config.MNEMO_API_KEY;

  // If no key configured, reject all API requests
  if (!apiKey) {
    return c.json({ error: 'API authentication not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (token !== apiKey) {
    return c.json({ error: 'Invalid API key' }, 403);
  }

  await next();
}
