// Admin authorization — enforced on EVERY /api/admin route and the admin UI.
//
// Order of checks:
//   1. Cloudflare Access JWT (Cf-Access-Jwt-Assertion) when CF_ACCESS_TEAM_DOMAIN
//      + CF_ACCESS_AUD are configured — the production path.
//   2. Preview-only dev key (Authorization: Bearer <ADMIN_DEV_KEY>) — refused
//      outright when PPI_ENV=production.
//   3. Otherwise fail closed (503 in production so misconfiguration is loud).

import type { Env } from './types.ts';
import { errorJson, timingSafeEqual } from './util.ts';

export type AdminAuth = { ok: true; actor: string } | { ok: false; response: Response };

interface AccessCerts {
  keys: JsonWebKey[];
  fetchedAt: number;
}

let certsCache: AccessCerts | null = null;
const CERTS_TTL_MS = 3600_000;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyAccessJwt(env: Env, jwt: string): Promise<string | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) return null;

  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; exp?: number; iss?: string; email?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  // Claims first (cheap): audience, expiry, issuer.
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;

  // Signature against the team's published certs.
  if (!certsCache || Date.now() - certsCache.fetchedAt > CERTS_TTL_MS) {
    try {
      const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { keys?: JsonWebKey[] };
      certsCache = { keys: body.keys ?? [], fetchedAt: Date.now() };
    } catch {
      return null;
    }
  }

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBytes(sigB64);
  for (const jwk of certsCache.keys) {
    if (header.kid && (jwk as { kid?: string }).kid !== header.kid) continue;
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedData);
      if (valid) return payload.email ?? payload.sub ?? 'access-user';
    } catch {
      /* try next key */
    }
  }
  return null;
}

export async function requireAdmin(request: Request, env: Env): Promise<AdminAuth> {
  const isProduction = env.PPI_ENV === 'production';

  // 1. Cloudflare Access
  const accessJwt = request.headers.get('cf-access-jwt-assertion');
  if (accessJwt && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    const email = await verifyAccessJwt(env, accessJwt);
    if (email) return { ok: true, actor: `admin:${email}` };
    return { ok: false, response: errorJson('unauthorized', 'Cloudflare Access verification failed.', 401) };
  }

  // 2. Preview-only dev key
  if (!isProduction && env.ADMIN_DEV_KEY && env.ADMIN_DEV_KEY.length >= 16) {
    const header = request.headers.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : (request.headers.get('x-admin-key') ?? '');
    if (provided && provided.length === env.ADMIN_DEV_KEY.length && timingSafeEqual(provided, env.ADMIN_DEV_KEY)) {
      return { ok: true, actor: 'admin:dev-key' };
    }
    return { ok: false, response: errorJson('unauthorized', 'Admin authorization required.', 401) };
  }

  // 3. Fail closed
  if (isProduction) {
    return {
      ok: false,
      response: errorJson('admin_locked', 'Admin access requires Cloudflare Access; it is not configured.', 503),
    };
  }
  return {
    ok: false,
    response: errorJson('unauthorized', 'Admin authorization required (set ADMIN_DEV_KEY for preview or configure Cloudflare Access).', 401),
  };
}

export async function auditLog(
  db: D1Database,
  actor: string,
  action: string,
  entity: string,
  entityId: string | null,
  details?: unknown,
): Promise<void> {
  await db
    .prepare(`INSERT INTO admin_audit_log (id, actor, action, entity, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      `al_${crypto.randomUUID().replaceAll('-', '')}`,
      actor,
      action,
      entity,
      entityId,
      details === undefined ? null : JSON.stringify(details).slice(0, 4000),
      new Date().toISOString(),
    )
    .run();
}
