import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimStripeEvent, classifyStripeRefundStatus, createCheckoutSession, createRefund, decideCheckoutAttempt, expireCheckoutSession, verifyStripeSignature, stripeKey, StripeApiError, StripeConfigError } from '../../functions/lib/stripe.ts';
import type { Env } from '../../functions/lib/types.ts';
import { onRequestPost as stripeWebhook, reconcileRefundLifecycle, stripeWebhookBase } from '../../functions/api/stripe/webhook.ts';

const SECRET = 'whsec_test_secret_for_unit_tests';

afterEach(() => vi.unstubAllGlobals());

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

describe('Stripe refund provider status classification', () => {
  it.each([
    'pending',
    'succeeded',
    'requires_action',
    'failed',
    'canceled',
  ] as const)('classifies the documented Refund status %s', (status) => {
    expect(classifyStripeRefundStatus({ object: 'refund', status })).toBe(status);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { status: null },
    { status: 200 },
    { status: 'processing' },
    { status: 'SUCCEEDED' },
  ])('fails closed to unknown for malformed or unrecognized input', (refund) => {
    expect(classifyStripeRefundStatus(refund)).toBe('unknown');
  });

  it('advances pending/action-required states while preserving definitive outcomes', () => {
    expect(reconcileRefundLifecycle('pending', 'provider_accepted')).toBe('provider_accepted');
    expect(reconcileRefundLifecycle('requires_action', 'failed')).toBe('failed');
    expect(reconcileRefundLifecycle('reconciliation_required', 'pending')).toBe('pending');
    expect(reconcileRefundLifecycle('provider_accepted', 'pending')).toBe('provider_accepted');
    expect(reconcileRefundLifecycle('failed', 'provider_accepted')).toBe('failed');
    expect(reconcileRefundLifecycle('canceled', 'pending')).toBe('canceled');
    expect(reconcileRefundLifecycle('confirmed', 'failed')).toBe('confirmed');
  });
});

describe('Stripe POST idempotency', () => {
  const env = {
    PPI_ENV: 'preview',
    PPI_MODE: 'request',
    PAYMENTS_ENABLED: 'true',
    STRIPE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_unit',
    STRIPE_API_BASE: 'https://stripe-mock.example/v1',
  } as unknown as Env;

  it('uses a stable Checkout idempotency key and a safe expiry margin', async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ id: 'cs_unit', url: 'https://checkout.example/cs_unit', expires_at: 1_900_000_000 }), { status: 200 });
    }));
    const before = Math.floor(Date.now() / 1000);

    const session = await createCheckoutSession(env, {
      requestId: 'req_1',
      requestRef: 'PPI-UNIT-1',
      quoteId: 'qot_1',
      bookingId: 'bkg_1',
      amountCents: 19900,
      customerEmail: 'customer@example.com',
      publicBaseUrl: 'https://example.com',
      attempt: 2,
    });

    expect(session.id).toBe('cs_unit');
    expect(new Headers(requestInit?.headers).get('idempotency-key')).toBe('checkout/bkg_1/qot_1/2');
    const params = new URLSearchParams(String(requestInit?.body));
    expect(Number(params.get('expires_at'))).toBeGreaterThanOrEqual(before + 31 * 60);
    expect(params.get('metadata[request_id]')).toBe('req_1');
  });

  it('passes the caller-defined refund idempotency key', async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ id: 're_unit', status: 'pending' }), { status: 200 });
    }));

    await createRefund(env, 'pi_unit', 5000, 'refund/pay_1/0/5000');
    expect(new Headers(requestInit?.headers).get('idempotency-key')).toBe('refund/pay_1/0/5000');
  });

  it('classifies a 2xx Refund response instead of assuming it succeeded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 're_requires_action',
      object: 'refund',
      status: 'requires_action',
    }), { status: 200 })));

    const refund = await createRefund(env, 'pi_unit', 5000, 'refund/pay_1/0/5000');

    expect(classifyStripeRefundStatus(refund)).toBe('requires_action');
  });

  it('adds only internal operation metadata to a Refund request', async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ id: 're_metadata', status: 'pending' }), { status: 200 });
    }));

    await createRefund(env, 'pi_unit', 5000, 'refund/rfo_1/2', { operationId: 'rfo_1', attemptNo: 2 });

    const params = new URLSearchParams(String(requestInit?.body));
    expect(params.get('metadata[refund_operation_id]')).toBe('rfo_1');
    expect(params.get('metadata[refund_attempt_no]')).toBe('2');
  });

  it('expires a Checkout Session with the guarded Stripe POST helper', async () => {
    let requestUrl: RequestInfo | URL | undefined;
    let requestInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = input;
      requestInit = init;
      return new Response(JSON.stringify({ id: 'cs_test_open_123', status: 'expired' }), { status: 200 });
    }));

    const result = await expireCheckoutSession(env, 'cs_test_open_123');

    expect(requestUrl).toBe('https://stripe-mock.example/v1/checkout/sessions/cs_test_open_123/expire');
    expect(requestInit?.method).toBe('POST');
    expect(new Headers(requestInit?.headers).get('authorization')).toBe('Bearer sk_test_unit');
    expect(String(requestInit?.body)).toBe('');
    expect(result).toMatchObject({ id: 'cs_test_open_123', status: 'expired' });
  });

  it.each([
    '',
    'pi_test_not_a_session',
    'cs_test_bad/../../refunds',
    'cs_test_bad?expand[]=payment_intent',
    `cs_${'a'.repeat(253)}`,
  ])('rejects an invalid Checkout Session id before calling Stripe: %s', async (sessionId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(expireCheckoutSession(env, sessionId)).rejects.toThrow('Invalid Stripe Checkout Session id.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates provider errors when Stripe refuses to expire the Session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { type: 'invalid_request_error', message: 'Checkout Session is not open' },
    }), { status: 400 })));

    await expect(expireCheckoutSession(env, 'cs_test_complete_123')).rejects.toThrow(
      'Stripe /checkout/sessions/cs_test_complete_123/expire failed (400): Checkout Session is not open',
    );
  });

  it('distinguishes definitive provider rejection from ambiguous server failure', () => {
    expect(new StripeApiError('rejected', 400).definitiveFailure).toBe(true);
    expect(new StripeApiError('unavailable', 503).definitiveFailure).toBe(false);
  });
});

describe('Stripe event claims', () => {
  function claimDb(insertChanges: number, reclaimChanges: number): D1Database {
    let call = 0;
    return {
      prepare() {
        const current = call++;
        return {
          bind() { return this; },
          async run() { return { meta: { changes: current === 0 ? insertChanges : reclaimChanges } }; },
        };
      },
    } as unknown as D1Database;
  }

  it('owns a new event and does not need a reclaim query', async () => {
    expect(await claimStripeEvent(claimDb(1, 0), 'evt_new', 'checkout.session.completed', 'sha')).toBe(true);
  });

  it('can reclaim a stale unprocessed event but not an active/processed replay', async () => {
    expect(await claimStripeEvent(claimDb(0, 1), 'evt_stale', 'checkout.session.completed', 'sha')).toBe(true);
    expect(await claimStripeEvent(claimDb(0, 0), 'evt_replay', 'checkout.session.completed', 'sha')).toBe(false);
  });
});

describe('Stripe required notification outbox', () => {
  it('returns 500 and releases the event claim when D1 cannot record a required email', async () => {
    const sqlCalls: string[] = [];
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { args = values; return this; },
          async run() {
            sqlCalls.push(sql);
            if (sql.includes('INSERT INTO messages')) throw new Error('simulated outbox failure');
            return { meta: { changes: 1 } };
          },
          async first() {
            sqlCalls.push(sql);
            if (sql.includes('FROM payments WHERE stripe_payment_intent')) {
              return { id: 'pay_1', request_id: 'req_1', amount_cents: 19900, refunded_cents: 0, status: 'succeeded' };
            }
            if (sql.includes('SELECT refunded_cents, status FROM payments')) return { refunded_cents: 19900, status: 'refunded' };
            if (sql.includes('FROM ppi_requests r JOIN customers')) {
              return { status: 'confirmed', ref: 'PPI-UNIT-1', email: 'customer@example.com' };
            }
            if (sql.includes('FROM ppi_requests WHERE id = ? AND deleted_at IS NULL')) {
              return { status: 'confirmed', has_open_payment: 0 };
            }
            if (sql.includes('FROM configuration')) return null;
            throw new Error(`Unexpected first(): ${sql} (${String(args)})`);
          },
        };
        return statement;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database;

    const event = JSON.stringify({
      id: 'evt_outbox_failure',
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_1', amount_refunded: 19900, refunded: true } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const request = new Request('https://example.com/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': await sign(event, timestamp) },
      body: event,
    });
    const response = await stripeWebhook({
      request,
      env: { DB: db, STRIPE_WEBHOOK_SECRET: SECRET } as Env,
      waitUntil: vi.fn(),
    } as unknown as EventContext<Env, string, Record<string, unknown>>);

    expect(response.status).toBe(500);
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM stripe_events'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('UPDATE stripe_events SET processed_at'))).toBe(false);
  });
});

describe('Stripe webhook absolute links', () => {
  it('falls back to the webhook request origin when PUBLIC_BASE_URL is absent', () => {
    expect(stripeWebhookBase('https://getautoclarity.com/api/stripe/webhook')).toBe('https://getautoclarity.com');
    expect(stripeWebhookBase('https://getautoclarity.com/api/stripe/webhook', '')).toBe('https://getautoclarity.com');
    expect(stripeWebhookBase('https://worker.example/api/stripe/webhook', 'https://getautoclarity.com/')).toBe('https://getautoclarity.com');
  });
});

describe('Checkout attempt reconciliation', () => {
  const now = Date.parse('2030-01-01T12:00:00.000Z');

  it('reuses only a recent active provider attempt', () => {
    expect(decideCheckoutAttempt(1, 1, '2030-01-01T11:45:00.000Z', 0, now)).toEqual({ kind: 'reuse', attempt: 1 });
  });

  it('fails closed for stale, malformed, or multiple active attempts', () => {
    expect(decideCheckoutAttempt(1, 1, '2030-01-01T11:29:59.000Z', 0, now)).toEqual({ kind: 'reconciliation_required' });
    expect(decideCheckoutAttempt(1, 1, 'not-a-date', 0, now)).toEqual({ kind: 'reconciliation_required' });
    expect(decideCheckoutAttempt(2, 2, '2030-01-01T11:50:00.000Z', 0, now)).toEqual({ kind: 'reconciliation_required' });
  });

  it('never starts checkout after a succeeded payment and advances only after verified expiry/failure', () => {
    expect(decideCheckoutAttempt(1, 0, null, 1, now)).toEqual({ kind: 'already_paid' });
    expect(decideCheckoutAttempt(2, 0, null, 0, now)).toEqual({ kind: 'new', attempt: 3 });
  });
});
