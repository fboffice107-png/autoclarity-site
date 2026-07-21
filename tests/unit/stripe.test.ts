import { describe, expect, it } from 'vitest';
import { verifyStripeSignature, stripeKey, StripeConfigError } from '../../functions/lib/stripe.ts';
import type { Env } from '../../functions/lib/types.ts';

const SECRET = 'whsec_test_secret_for_unit_tests';

async function sign(payload: string, timestamp: number, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

describe('verifyStripeSignature', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const now = 1_800_000_000;

  it('accepts a valid signature within tolerance', async () => {
    const header = await sign(payload, now - 10);
    expect((await verifyStripeSignature(payload, header, SECRET, 300, now)).ok).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const header = await sign(payload, now);
    const result = await verifyStripeSignature(payload + 'x', header, SECRET, 300, now);
    expect(result.ok).toBe(false);
  });

  it('rejects the wrong secret', async () => {
    const header = await sign(payload, now, 'whsec_other');
    expect((await verifyStripeSignature(payload, header, SECRET, 300, now)).ok).toBe(false);
  });

  it('rejects stale timestamps (replay window)', async () => {
    const header = await sign(payload, now - 600);
    const result = await verifyStripeSignature(payload, header, SECRET, 300, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/tolerance/);
  });

  it('rejects missing/malformed headers and missing secret', async () => {
    expect((await verifyStripeSignature(payload, null, SECRET)).ok).toBe(false);
    expect((await verifyStripeSignature(payload, 'garbage', SECRET)).ok).toBe(false);
    expect((await verifyStripeSignature(payload, await sign(payload, now), undefined)).ok).toBe(false);
  });

  it('accepts multiple v1 entries if one matches', async () => {
    const good = await sign(payload, now);
    const header = good.replace('v1=', 'v1=deadbeef,v1=');
    expect((await verifyStripeSignature(payload, header, SECRET, 300, now)).ok).toBe(true);
  });
});

describe('stripeKey safety rails', () => {
  const baseEnv = { PAYMENTS_ENABLED: 'true', STRIPE_ENV: 'test' } as unknown as Env;

  it('refuses when payments are disabled', () => {
    expect(() => stripeKey({ ...baseEnv, PAYMENTS_ENABLED: 'false', STRIPE_SECRET_KEY: 'sk_test_x' } as Env)).toThrow(StripeConfigError);
  });

  it('refuses live keys in test env', () => {
    expect(() => stripeKey({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_live_x' } as Env)).toThrow(StripeConfigError);
  });

  it('refuses live keys outside production live mode', () => {
    expect(() =>
      stripeKey({ PAYMENTS_ENABLED: 'true', STRIPE_ENV: 'live', STRIPE_SECRET_KEY: 'sk_live_x', PPI_ENV: 'preview', PPI_MODE: 'live' } as Env),
    ).toThrow(StripeConfigError);
    expect(() =>
      stripeKey({ PAYMENTS_ENABLED: 'true', STRIPE_ENV: 'live', STRIPE_SECRET_KEY: 'sk_live_x', PPI_ENV: 'production', PPI_MODE: 'request' } as Env),
    ).toThrow(StripeConfigError);
  });

  it('accepts sk_test_ in test env', () => {
    expect(stripeKey({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_test_ok' } as Env)).toBe('sk_test_ok');
  });
});
