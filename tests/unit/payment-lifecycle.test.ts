import { afterEach, describe, expect, it, vi } from 'vitest';
import { expireOpenCheckoutAttempts } from '../../functions/lib/payment-lifecycle.ts';
import type { Env } from '../../functions/lib/types.ts';

function envWith(
  rows: Array<{ id: string; stripe_session_id: string | null }>,
  updateChanges = 1,
  persistedStatus = 'expired',
): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async all() {
          if (sql.includes("status IN ('created','pending')")) return { results: rows };
          throw new Error(`Unexpected all: ${sql}`);
        },
        async run() {
          if (sql.includes("SET status = 'expired'")) return { meta: { changes: updateChanges } };
          throw new Error(`Unexpected run: ${sql}`);
        },
        async first() {
          if (sql.includes('SELECT status FROM payments')) return { status: persistedStatus };
          throw new Error(`Unexpected first: ${sql}`);
        },
      };
    },
  } as unknown as D1Database;
  return {
    DB: db,
    PPI_ENV: 'preview',
    PPI_MODE: 'request',
    PAYMENTS_ENABLED: 'true',
    STRIPE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_unit',
  } as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe('cancellation Checkout reconciliation', () => {
  it('expires every provider session before recording local expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'cs_test_open', status: 'expired' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await expireOpenCheckoutAttempts(envWith([{ id: 'pay_1', stripe_session_id: 'cs_test_open' }]), 'req_1');
    expect(result).toEqual({ ok: true, expired: ['pay_1'] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed when Stripe cannot prove expiration', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'already complete' } }), { status: 400 })));
    const result = await expireOpenCheckoutAttempts(envWith([{ id: 'pay_1', stripe_session_id: 'cs_test_open' }]), 'req_1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('reconciliation_required');
  });

  it('fails closed without contacting Stripe when an active row lacks a session id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await expireOpenCheckoutAttempts(envWith([{ id: 'pay_1', stripe_session_id: null }]), 'req_1');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the same provider expiry recorded first by a concurrent webhook', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'cs_test_open', status: 'expired' }), { status: 200 })));
    const result = await expireOpenCheckoutAttempts(
      envWith([{ id: 'pay_1', stripe_session_id: 'cs_test_open' }], 0, 'expired'),
      'req_1',
    );
    expect(result).toEqual({ ok: true, expired: ['pay_1'] });
  });

  it('fails closed if payment succeeded while provider expiry was in flight', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'cs_test_open', status: 'expired' }), { status: 200 })));
    const result = await expireOpenCheckoutAttempts(
      envWith([{ id: 'pay_1', stripe_session_id: 'cs_test_open' }], 0, 'succeeded'),
      'req_1',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('reconciliation_required');
  });
});
