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

/**
 * Create a fresh portal link. D1 executes `batch()` transactionally, so a
 * rotation can never revoke the working link without also storing its
 * replacement.
 */
export async function issueMagicLink(
  db: D1Database,
  requestId: string,
  config: PpiConfig,
  rotate = true,
): Promise<{ id: string; token: string; expiresAt: string }> {
  const token = randomToken(32); // 256 bits
  const hash = await sha256Hex(token);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + config.magicLinks.ttlHours * 3600_000).toISOString();
  const id = `ml_${crypto.randomUUID().replaceAll('-', '')}`;
  const insert = db
    .prepare(
      `INSERT INTO magic_links (id, request_id, token_hash, purpose, expires_at, created_at)
       VALUES (?, ?, ?, 'portal', ?, ?)`,
    )
    .bind(id, requestId, hash, expiresAt, now);
  const statements = rotate
    ? [
        db
          .prepare(`UPDATE magic_links SET revoked_at = ? WHERE request_id = ? AND revoked_at IS NULL`)
          .bind(now, requestId),
        insert,
      ]
    : [insert];
  await db.batch(statements);
  return { id, token, expiresAt };
}

export type MagicVerifyResult =
  | { ok: true; requestId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' };

export type MagicInspectResult =
  | { ok: true; id: string; requestId: string; expiresAt: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' };

/** Read-only token validation for notification retries. */
export async function inspectMagicToken(db: D1Database, token: string): Promise<MagicInspectResult> {
  if (!token || token.length < 20 || token.length > 128) return { ok: false, reason: 'invalid' };
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(`SELECT id, request_id, expires_at, revoked_at FROM magic_links WHERE token_hash = ?`)
    .bind(hash)
    .first<Pick<MagicLinkRow, 'id' | 'request_id' | 'expires_at' | 'revoked_at'>>();
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, id: row.id, requestId: row.request_id, expiresAt: row.expires_at };
}

/** Revoke only a specifically identified unused link, never every request link. */
export async function revokeMagicLinkById(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE magic_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(nowIso(), id)
    .run();
}

export async function verifyMagicToken(db: D1Database, token: string): Promise<MagicVerifyResult> {
  const inspected = await inspectMagicToken(db, token);
  if (!inspected.ok) return inspected;
  await db.prepare(`UPDATE magic_links SET used_at = ? WHERE id = ?`).bind(nowIso(), inspected.id).run();
  return { ok: true, requestId: inspected.requestId };
}

export function portalUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/$/, '')}/ppi/portal/?t=${token}`;
}
