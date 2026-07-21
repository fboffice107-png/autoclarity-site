// Passwordless customer access: high-entropy single-purpose tokens.
// Only the SHA-256 hash is stored; the raw token exists in the emailed link.

import { nowIso, randomToken, sha256Hex } from './util.ts';
import type { PpiConfig } from './config.ts';

export interface MagicLinkRow {
  id: string;
  request_id: string;
  token_hash: string;
  purpose: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Create a fresh portal link for a request, revoking earlier ones (rotation). */
export async function issueMagicLink(
  db: D1Database,
  requestId: string,
  config: PpiConfig,
  rotate = true,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32); // 256 bits
  const hash = await sha256Hex(token);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + config.magicLinks.ttlHours * 3600_000).toISOString();
  if (rotate) {
    await db
      .prepare(`UPDATE magic_links SET revoked_at = ? WHERE request_id = ? AND revoked_at IS NULL`)
      .bind(now, requestId)
      .run();
  }
  await db
    .prepare(
      `INSERT INTO magic_links (id, request_id, token_hash, purpose, expires_at, created_at)
       VALUES (?, ?, ?, 'portal', ?, ?)`,
    )
    .bind(`ml_${crypto.randomUUID().replaceAll('-', '')}`, requestId, hash, expiresAt, now)
    .run();
  return { token, expiresAt };
}

export type MagicVerifyResult =
  | { ok: true; requestId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' };

export async function verifyMagicToken(db: D1Database, token: string): Promise<MagicVerifyResult> {
  if (!token || token.length < 20 || token.length > 128) return { ok: false, reason: 'invalid' };
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(`SELECT * FROM magic_links WHERE token_hash = ?`)
    .bind(hash)
    .first<MagicLinkRow>();
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  await db.prepare(`UPDATE magic_links SET used_at = ? WHERE id = ?`).bind(nowIso(), row.id).run();
  return { ok: true, requestId: row.request_id };
}

export function portalUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/$/, '')}/ppi/portal/?t=${token}`;
}
