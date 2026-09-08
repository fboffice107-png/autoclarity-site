import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimStripeEvent, classifyStripeRefundStatus, createCheckoutSession, createRefund, decideCheckoutAttempt, expireCheckoutSession, verifyStripeSignature, stripeKey, StripeApiError, StripeConfigError } from '../../functions/lib/stripe.ts';
import { modeFlags, type Env } from '../../functions/lib/types.ts';
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

  it('enables production payments only for the verified complete live tuple', () => {
    const complete = {
      PPI_ENV: 'production',
      PPI_MODE: 'live',
      PAYMENTS_ENABLED: 'true',
      STRIPE_ENV: 'live',
      STRIPE_SECRET_KEY: 'sk_live_owner_approved',
      BOOKING_ENABLED: 'true',
    } as Env;
    expect(modeFlags(complete)).toMatchObject({
      env: 'production',
      mode: 'live',
      stripeEnv: 'live',
      bookingEnabled: true,
      paymentsEnabled: true,
    });
    expect(stripeKey(complete)).toBe('sk_live_owner_approved');

    expect(modeFlags({ ...complete, PPI_MODE: 'request' }).paymentsEnabled).toBe(false);
    expect(modeFlags({ ...complete, PAYMENTS_ENABLED: 'false' }).paymentsEnabled).toBe(false);
    expect(modeFlags({ ...complete, STRIPE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_wrong_for_production' }).paymentsEnabled).toBe(false);
    expect(modeFlags({ ...complete, STRIPE_SECRET_KEY: 'sk_test_wrong_key_mode' }).paymentsEnabled).toBe(false);
  });

  it('keeps preview test Checkout effective but never enables preview live Checkout', () => {
    expect(modeFlags({
      PPI_ENV: 'preview',
      PPI_MODE: 'request',
      PAYMENTS_ENABLED: 'true',
      STRIPE_ENV: 'test',
      STRIPE_SECRET_KEY: 'sk_test_preview',
    } as Env).paymentsEnabled).toBe(true);
    expect(modeFlags({
      PPI_ENV: 'preview',
      PPI_MODE: 'live',
      PAYMENTS_ENABLED: 'true',
      STRIPE_ENV: 'live',
      STRIPE_SECRET_KEY: 'sk_live_never_preview',
    } as Env).paymentsEnabled).toBe(false);
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

  it('maps the authoritative ledger outcome even after an earlier definitive state', () => {
    expect(reconcileRefundLifecycle('pending', 'provider_accepted')).toBe('provider_accepted');
    expect(reconcileRefundLifecycle('requires_action', 'failed')).toBe('failed');
    expect(reconcileRefundLifecycle('reconciliation_required', 'pending')).toBe('pending');
    expect(reconcileRefundLifecycle('provider_accepted', 'failed')).toBe('failed');
    expect(reconcileRefundLifecycle('failed', 'provider_accepted')).toBe('provider_accepted');
    expect(reconcileRefundLifecycle('canceled', 'pending')).toBe('pending');
    expect(reconcileRefundLifecycle('confirmed', 'failed')).toBe('failed');
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
      currency: 'usd',
      customerEmail: 'customer@example.com',
      publicBaseUrl: 'https://example.com',
      attempt: 2,
    });

    expect(session.id).toBe('cs_unit');
    expect(new Headers(requestInit?.headers).get('idempotency-key')).toBe('checkout/bkg_1/qot_1/2');
    const params = new URLSearchParams(String(requestInit?.body));
    expect(Number(params.get('expires_at'))).toBeGreaterThanOrEqual(before + 31 * 60);
    expect(params.get('metadata[request_id]')).toBe('req_1');
    expect(params.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('19900');
  });

  it('rejects zero, unsafe, and non-USD Checkout identities before contacting Stripe', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      requestId: 'req_1',
      requestRef: 'PPI-UNIT-1',
      quoteId: 'qot_1',
      bookingId: 'bkg_1',
      amountCents: 19900,
      currency: 'usd',
      customerEmail: 'customer@example.com',
      publicBaseUrl: 'https://example.com',
      attempt: 1,
    };

    await expect(createCheckoutSession(env, { ...input, amountCents: 0 })).rejects.toThrow(/positive safe integer/);
    await expect(createCheckoutSession(env, { ...input, amountCents: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(/positive safe integer/);
    await expect(createCheckoutSession(env, { ...input, currency: 'eur' })).rejects.toThrow(/currency must be usd/);
    expect(fetchMock).not.toHaveBeenCalled();
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
  function claimDb(
    insertChanges: number,
    reclaimChanges: number,
    existing: { type: string; payload_sha256: string; processed_at: string | null } | null = null,
  ): D1Database {
    let call = 0;
    return {
      prepare() {
        const current = call++;
        return {
          bind() { return this; },
          async run() { return { meta: { changes: current === 0 ? insertChanges : reclaimChanges } }; },
          async first() { return existing; },
        };
      },
    } as unknown as D1Database;
  }

  it('owns a new event and does not need a reclaim query', async () => {
    expect(await claimStripeEvent(claimDb(1, 0), 'evt_new', 'checkout.session.completed', 'sha')).toBe('claimed');
  });

  it('reclaims stale events and distinguishes processed from in-flight duplicates', async () => {
    expect(await claimStripeEvent(claimDb(0, 1), 'evt_stale', 'checkout.session.completed', 'sha')).toBe('claimed');
    expect(await claimStripeEvent(
      claimDb(0, 0, { type: 'checkout.session.completed', payload_sha256: 'sha', processed_at: '2030-01-01T00:00:00.000Z' }),
      'evt_replay',
      'checkout.session.completed',
      'sha',
    )).toBe('processed');
    expect(await claimStripeEvent(
      claimDb(0, 0, { type: 'checkout.session.completed', payload_sha256: 'sha', processed_at: null }),
      'evt_active',
      'checkout.session.completed',
      'sha',
    )).toBe('in_progress');
    expect(await claimStripeEvent(
      claimDb(0, 0, { type: 'checkout.session.completed', payload_sha256: 'different', processed_at: '2030-01-01T00:00:00.000Z' }),
      'evt_collision',
      'checkout.session.completed',
      'sha',
    )).toBe('in_progress');
  });
});

describe('Stripe webhook environment and duplicate guards', () => {
  async function webhookRequest(event: Record<string, unknown>): Promise<Request> {
    const payload = JSON.stringify(event);
    return new Request('https://example.com/api/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': await sign(payload, Math.floor(Date.now() / 1000)) },
      body: payload,
    });
  }

  it('rejects a livemode mismatch before touching D1', async () => {
    const db = {
      prepare() { throw new Error('D1 must not be touched for a mode mismatch'); },
    } as unknown as D1Database;
    const response = await stripeWebhook({
      request: await webhookRequest({ id: 'evt_wrong_mode', type: 'customer.created', livemode: true, data: { object: {} } }),
      env: { DB: db, STRIPE_ENV: 'test', STRIPE_WEBHOOK_SECRET: SECRET } as Env,
      waitUntil: vi.fn(),
    } as unknown as EventContext<Env, string, Record<string, unknown>>);

    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('stripe_mode_mismatch');
  });

  it('requires an explicit boolean livemode before touching D1', async () => {
    const db = {
      prepare() { throw new Error('D1 must not be touched for a malformed mode'); },
    } as unknown as D1Database;
    const response = await stripeWebhook({
      request: await webhookRequest({ id: 'evt_missing_mode', type: 'customer.created', data: { object: {} } }),
      env: { DB: db, STRIPE_ENV: 'test', STRIPE_WEBHOOK_SECRET: SECRET } as Env,
      waitUntil: vi.fn(),
    } as unknown as EventContext<Env, string, Record<string, unknown>>);

    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('bad_event');
  });

  it('returns non-2xx for an in-flight duplicate so Stripe retries it', async () => {
    const event = { id: 'evt_in_flight', type: 'customer.created', livemode: false, data: { object: {} } };
    const payload = JSON.stringify(event);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const payloadSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    let statement = 0;
    const db = {
      prepare() {
        const current = statement++;
        return {
          bind() { return this; },
          async run() { return { meta: { changes: 0 } }; },
          async first() {
            if (current !== 2) throw new Error('Unexpected claim query order');
            return { type: event.type, payload_sha256: payloadSha256, processed_at: null };
          },
        };
      },
    } as unknown as D1Database;
    const response = await stripeWebhook({
      request: await webhookRequest(event),
      env: { DB: db, STRIPE_ENV: 'test', STRIPE_WEBHOOK_SECRET: SECRET } as Env,
      waitUntil: vi.fn(),
    } as unknown as EventContext<Env, string, Record<string, unknown>>);

    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBe('5');
    expect((await response.json() as { error: { code: string } }).error.code).toBe('event_in_progress');
  });

  it('reconciles a matching late event while new payments are disabled', async () => {
    const sqlCalls: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async run() { sqlCalls.push(sql); return { meta: { changes: 1 } }; },
        };
      },
    } as unknown as D1Database;
    const response = await stripeWebhook({
      request: await webhookRequest({
        id: 'evt_late_expiry',
        type: 'checkout.session.expired',
        livemode: true,
        data: { object: { id: 'cs_live_late' } },
      }),
      env: {
        DB: db,
        PPI_ENV: 'production',
        PPI_MODE: 'request',
        PAYMENTS_ENABLED: 'false',
        STRIPE_ENV: 'live',
        STRIPE_WEBHOOK_SECRET: SECRET,
      } as Env,
      waitUntil: vi.fn(),
    } as unknown as EventContext<Env, string, Record<string, unknown>>);

    expect(response.status).toBe(200);
    expect(sqlCalls.some((sql) => sql.includes("UPDATE payments SET status = 'expired'"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('UPDATE stripe_events SET processed_at'))).toBe(true);
  });

  it('rejects charge.refunded when one PaymentIntent maps to multiple local payments', async () => {
    const sqlCalls: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async run() {
            sqlCalls.push(sql);
            return { meta: { changes: 1 } };
          },
          async all() {
            sqlCalls.push(sql);
            if (sql.includes('FROM payments WHERE stripe_payment_intent')) {
              return {
                results: [
                  { id: 'pay_duplicate_1', request_id: 'req_1', amount_cents: 19900, currency: 'usd' },
                  { id: 'pay_duplicate_2', request_id: 'req_2', amount_cents: 19900, currency: 'usd' },
                ],
              };
            }
            throw new Error(`Unexpected all(): ${sql}`);
          },
        };
      },
    } as unknown as D1Database;
    const response = await stripeWebhook({
      request: await webhookRequest({
        id: 'evt_ambiguous_charge_refund',
        type: 'charge.refunded',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object: { payment_intent: 'pi_ambiguous', amount_refunded: 1000, refunded: false } },
      }),
      env: { DB: db, STRIPE_ENV: 'test', STRIPE_WEBHOOK_SECRET: SECRET } as Env,
      waitUntil: vi.fn(),
    } as unknown as EventContext<Env, string, Record<string, unknown>>);

    expect(response.status).toBe(500);
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM stripe_events'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('UPDATE stripe_events SET processed_at'))).toBe(false);
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
              return { id: 'pay_1', request_id: 'req_1', amount_cents: 19900, currency: 'usd', refunded_cents: 0, status: 'succeeded' };
            }
            if (sql.includes('SELECT id, request_id, amount_cents, refunded_cents, status FROM payments WHERE id')) {
              return { id: 'pay_1', request_id: 'req_1', amount_cents: 19900, refunded_cents: 0, status: 'succeeded' };
            }
            if (sql.includes('SELECT request_id, amount_cents, refunded_cents, status FROM payments WHERE id')) {
              return { request_id: 'req_1', amount_cents: 19900, refunded_cents: 19900, status: 'refunded' };
            }
            if (sql.includes('AS cents') && sql.includes('FROM provider_refunds')) return { cents: 19900 };
            if (sql.includes('FROM ppi_requests r JOIN customers')) {
              return { status: 'confirmed', ref: 'PPI-UNIT-1', email: 'customer@example.com' };
            }
            if (sql.includes('FROM ppi_requests WHERE id = ? AND deleted_at IS NULL')) {
              return { status: 'confirmed', has_open_payment: 0 };
            }
            if (sql.includes('FROM configuration')) return null;
            if (sql.includes('SELECT 1 AS latched FROM admin_audit_log')) return null;
            throw new Error(`Unexpected first(): ${sql} (${String(args)})`);
          },
          async all() {
            sqlCalls.push(sql);
            if (sql.includes('FROM payments WHERE stripe_payment_intent')) {
              return { results: [{ id: 'pay_1', request_id: 'req_1', amount_cents: 19900, currency: 'usd' }] };
            }
            if (sql.includes('FROM refund_operations o')) return { results: [] };
            throw new Error(`Unexpected all(): ${sql} (${String(args)})`);
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
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { payment_intent: 'pi_1', amount_refunded: 19900, refunded: true } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const request = new Request('https://example.com/api/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': await sign(event, timestamp) },
      body: event,
    });
    const response = await stripeWebhook({
      request,
      env: { DB: db, STRIPE_WEBHOOK_SECRET: SECRET } as Env,
      waitUntil: vi.fn(),
    } as unknown as EventContext<Env, string, Record<string, unknown>>);

    expect(response.status).toBe(500);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO messages'))).toBe(true);
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
