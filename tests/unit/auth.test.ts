// Admin/inspector authorization fail-closed matrix. Production must refuse
// the dev key outright and answer 503 until Cloudflare Access is configured —
// obscurity is never the production control.
import { describe, expect, it } from 'vitest';
import { requireAdmin } from '../../functions/lib/auth.ts';
import type { Env } from '../../functions/lib/types.ts';

const DEV_KEY = 'unit-test-dev-key-0123456789abcdef';

const req = (headers: Record<string, string> = {}) =>
  new Request('https://example.com/api/admin/overview', { headers });

async function code(auth: Awaited<ReturnType<typeof requireAdmin>>): Promise<{ status: number; code: string }> {
  if (auth.ok) throw new Error('expected refusal');
  const body = (await auth.response.json()) as { error: { code: string } };
  return { status: auth.response.status, code: body.error.code };
}

describe('requireAdmin — preview (staging)', () => {
  const env = { PPI_ENV: 'preview', ADMIN_DEV_KEY: DEV_KEY } as Env;

  it('accepts the correct dev key', async () => {
    const auth = await requireAdmin(req({ authorization: `Bearer ${DEV_KEY}` }), env);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.actor).toBe('admin:dev-key');
  });

  it('rejects a missing or wrong key with 401', async () => {
    expect((await code(await requireAdmin(req(), env))).status).toBe(401);
    const wrong = await requireAdmin(req({ authorization: 'Bearer wrong-key-wrong-key-wrong-key' }), env);
    expect((await code(wrong)).status).toBe(401);
  });

  it('ignores a dev key that is too short to be safe', async () => {
    const shortEnv = { PPI_ENV: 'preview', ADMIN_DEV_KEY: 'short' } as Env;
    const auth = await requireAdmin(req({ authorization: 'Bearer short' }), shortEnv);
    expect((await code(auth)).status).toBe(401);
  });
});

describe('requireAdmin — production (fail closed)', () => {
  it('refuses the dev key even when it matches', async () => {
    const env = { PPI_ENV: 'production', ADMIN_DEV_KEY: DEV_KEY } as Env;
    const auth = await requireAdmin(req({ authorization: `Bearer ${DEV_KEY}` }), env);
    const r = await code(auth);
    expect(r.status).toBe(503);
    expect(r.code).toBe('admin_locked');
  });

  it('answers 503 admin_locked until Cloudflare Access is configured', async () => {
    const env = { PPI_ENV: 'production' } as Env;
    const r = await code(await requireAdmin(req(), env));
    expect(r.status).toBe(503);
    expect(r.code).toBe('admin_locked');
  });

  it('rejects a malformed Access JWT with 401 (no fallback to anything)', async () => {
    const env = {
      PPI_ENV: 'production',
      CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      CF_ACCESS_AUD: 'aud-tag-unit-test',
    } as Env;
    const auth = await requireAdmin(req({ 'cf-access-jwt-assertion': 'not.a.jwt' }), env);
    const r = await code(auth);
    expect(r.status).toBe(401);
    expect(r.code).toBe('unauthorized');
  });

  it('rejects a structurally valid JWT whose audience does not match', async () => {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const jwt = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ aud: 'someone-else', exp: Math.floor(Date.now() / 1000) + 600, iss: 'https://example.cloudflareaccess.com' })}.${b64({ sig: 'x' })}`;
    const env = {
      PPI_ENV: 'production',
      CF_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      CF_ACCESS_AUD: 'aud-tag-unit-test',
    } as Env;
    const auth = await requireAdmin(req({ 'cf-access-jwt-assertion': jwt }), env);
    expect((await code(auth)).status).toBe(401);
  });
});
