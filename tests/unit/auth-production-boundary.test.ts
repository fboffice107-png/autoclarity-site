import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../functions/lib/types.ts';

const localKey = 'synthetic-local-admin-key-only';
const team = 'synthetic-owner.cloudflareaccess.com';
const audience = 'synthetic-access-audience';
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

async function signedAccess(overrides: Record<string, unknown> = {}) {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  if (!('publicKey' in keys) || !('privateKey' in keys)) throw new Error('Expected an asymmetric key pair');
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: 'owner-key' }] })));
  const data = encode({ alg: 'RS256', kid: 'owner-key' }) + '.' + encode({ aud: [audience], iss: 'https://' + team, exp: Math.floor(Date.now() / 1000) + 300, email: 'owner@example.test', ...overrides });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data));
  return data + '.' + base64url(new Uint8Array(signature));
}

function env(production: boolean, hasDevKey = false) {
  return { PPI_ENV: production ? 'production' : 'preview', CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: audience, ...(hasDevKey ? { ADMIN_DEV_KEY: localKey } : {}) } as Env;
}

describe('owner Access and preview-only development authentication', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

  it.each([true, false])('valid signed owner Access works in production with ADMIN_DEV_KEY present=%s', async (present) => {
    const jwt = await signedAccess();
    const { requireAdmin } = await import('../../functions/lib/auth.ts');
    const result = await requireAdmin(new Request('https://example.test/api/admin/config', { headers: { 'cf-access-jwt-assertion': jwt } }), env(true, present));
    expect(result).toEqual({ ok: true, actor: 'admin:owner@example.test' });
  });

  it('production refuses the development credential even when configured', async () => {
    const { requireAdmin } = await import('../../functions/lib/auth.ts');
    const result = await requireAdmin(new Request('https://example.test/api/admin/config', { headers: { authorization: 'Bearer ' + localKey } }), env(true, true));
    expect(result.ok).toBe(false);
  });

  it('local/preview development auth continues independently', async () => {
    const { requireAdmin } = await import('../../functions/lib/auth.ts');
    const result = await requireAdmin(new Request('http://localhost:8788/api/admin/config', { headers: { authorization: 'Bearer ' + localKey } }), env(false, true));
    expect(result).toEqual({ ok: true, actor: 'admin:dev-key' });
  });

  it.each([{ aud: ['wrong'] }, { iss: 'https://wrong.cloudflareaccess.com' }, { exp: 1 }])('rejects signed but invalid claims: %j', async (claims) => {
    const jwt = await signedAccess(claims);
    const { requireAdmin } = await import('../../functions/lib/auth.ts');
    const result = await requireAdmin(new Request('https://example.test/api/admin/config', { headers: { 'cf-access-jwt-assertion': jwt, authorization: 'Bearer ' + localKey } }), env(true, true));
    expect(result.ok).toBe(false);
  });

  it('rejects forged signature without falling back to development auth', async () => {
    const jwt = await signedAccess();
    const { requireAdmin } = await import('../../functions/lib/auth.ts');
    const pieces = jwt.split('.');
    pieces[1] = encode({ aud: [audience], iss: 'https://' + team, exp: Math.floor(Date.now() / 1000) + 300, email: 'attacker@example.test' });
    const result = await requireAdmin(new Request('https://example.test/api/admin/config', { headers: { 'cf-access-jwt-assertion': pieces.join('.'), authorization: 'Bearer ' + localKey } }), env(true, true));
    expect(result.ok).toBe(false);
  });
});
