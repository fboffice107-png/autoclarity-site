// Fixed-window rate limiting backed by D1. Keys are salted daily hashes of the
// caller identity (IP), so raw IPs are not stored in the limits table.

import { sha256Hex } from './util.ts';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

export async function rateLimit(
  db: D1Database,
  identity: string,
  route: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const daySalt = new Date().toISOString().slice(0, 10);
  const bucket = `${route}:${(await sha256Hex(`${daySalt}:${identity}`)).slice(0, 24)}`;
  const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;

  // Opportunistic cleanup of stale windows (~2% of calls).
  if (Math.random() < 0.02) {
    const cutoff = windowStart - windowSec * 4;
    await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(cutoff).run();
  }

  return { allowed: count <= limit, count, limit };
}
