// Stripe integration via the REST API (no SDK dependency in the Worker).
// Checkout Sessions for one-time physical-service payments only. Webhooks —
// never the browser redirect — are the source of truth for payment status.

import { sha256Hex, timingSafeEqual } from './util.ts';
import type { Env } from './types.ts';
import { modeFlags } from './types.ts';

const STRIPE_API = 'https://api.stripe.com/v1';

/** Real Stripe in production, always. Overridable only outside production so
 *  integration tests can exercise the full payment path against a mock. */
function apiBase(env: Env): string {
  if (env.PPI_ENV !== 'production' && env.STRIPE_API_BASE) return env.STRIPE_API_BASE;
  return STRIPE_API;
}

export class StripeConfigError extends Error {}

/**
 * Payment states that mean money has moved. Anything in this list must block a
 * new charge, block an "unpaid" cancellation, and stop a slot release. One
 * definition, used by the checkout gate, the portal cancel action and the
 * webhook — the customer-facing copy in assets/js/ppi-portal.js mirrors it.
 */
export const SETTLED_PAYMENT_STATUSES = ['succeeded', 'refunded', 'partially_refunded', 'disputed'] as const;
const SETTLED_PLACEHOLDERS = SETTLED_PAYMENT_STATUSES.map(() => '?').join(',');

/** `SELECT ... WHERE status IN (?,?,?,?)` fragment plus its bind values. */
export function settledPaymentFilter(): { sql: string; values: string[] } {
  return { sql: SETTLED_PLACEHOLDERS, values: [...SETTLED_PAYMENT_STATUSES] };
}

/**
 * Returns the Stripe secret key after safety checks:
 * - payments must be enabled
 * - test env requires sk_test_; a live key is refused unless STRIPE_ENV=live
 *   AND PPI_ENV=production AND PPI_MODE=live (owner-approved launch state).
 */
/** A Stripe LIVE secret/restricted key (sk_live_… / rk_live_…). */
function isLiveKey(key: string): boolean {
  return key.startsWith('sk_live_') || key.startsWith('rk_live_');
}

export function stripeKey(env: Env): string {
  const flags = modeFlags(env);
  if (!flags.paymentsEnabled) throw new StripeConfigError('Payments are not enabled in this environment.');
  const key = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key) throw new StripeConfigError('STRIPE_SECRET_KEY is not configured.');
  // The safety goal: a test environment must NEVER use a live key, and a live
  // environment must use a live key only in production live mode. We do not
  // pin the exact test-key prefix (Stripe test/sandbox/restricted keys vary:
  // sk_test_, rk_test_, sandbox variants), we only reject the dangerous case.
  if (flags.stripeEnv === 'test') {
    if (isLiveKey(key)) throw new StripeConfigError('STRIPE_ENV=test refuses a live Stripe key.');
    if (key.startsWith('pk_')) throw new StripeConfigError('That looks like a publishable key (pk_…); use the SECRET key.');
  } else {
    if (!isLiveKey(key)) throw new StripeConfigError('STRIPE_ENV=live requires a live secret key (sk_live_… / rk_live_…).');
    if (flags.env !== 'production' || flags.mode !== 'live') {
      throw new StripeConfigError('Live Stripe keys are refused outside production live mode.');
    }
  }
  return key;
}

async function stripePost(
  env: Env,
  key: string,
  path: string,
  params: Record<string, string>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase(env)}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': '2024-06-20',
      // Stripe replays the original response for a repeated key, so a retry
      // after a lost response recovers the first object instead of creating a
      // second one. This is server-side and survives any client behaviour.
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body as { error?: { message?: string; type?: string } }).error;
    throw new Error(`Stripe ${path} failed (${res.status}): ${err?.message ?? 'unknown error'}`);
  }
  return body;
}

export interface CheckoutInput {
  requestId: string;
  requestRef: string;
  quoteId: string;
  bookingId: string;
  /** The window this payment reserves — part of the attempt's identity. */
  slotId: string;
  /** The reserved payments row. One attempt row = one payable session. */
  paymentId: string;
  amountCents: number;
  customerEmail: string;
  publicBaseUrl: string;
  /**
   * Session expiry as a unix timestamp, derived by the caller from the payment
   * attempt's own created_at. It must be IDENTICAL on every retry of the same
   * attempt: Stripe rejects a repeated idempotency key whose request body
   * differs, so a clock-derived value here would break retry recovery.
   */
  expiresAtEpoch: number;
}

/**
 * Stable idempotency key for ONE intended payment attempt, derived only from
 * immutable identifiers: the request, the quote being charged, the window it
 * reserves and the reserved attempt row. Retrying the same attempt — after a
 * timeout, a lost response, or a Worker restart — replays the same key, so
 * Stripe can only ever return the session it already created. A different
 * quote, window or attempt produces a different key, which is what makes a
 * genuinely new payment possible.
 */
export async function checkoutIdempotencyKey(input: Pick<CheckoutInput, 'requestId' | 'quoteId' | 'slotId' | 'paymentId'>): Promise<string> {
  const digest = await sha256Hex(`checkout|${input.requestId}|${input.quoteId}|${input.slotId}|${input.paymentId}`);
  return `ppi_co_${digest.slice(0, 48)}`;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: number;
}

/**
 * One Checkout Session per payment attempt. Metadata carries ONLY internal ids
 * — never VIN, address, notes or diagnostics. Every field below must be a pure
 * function of the attempt, because the idempotency key replays only when the
 * request body is byte-identical.
 */
export async function createCheckoutSession(env: Env, input: CheckoutInput): Promise<CheckoutSession> {
  const key = stripeKey(env);
  const base = input.publicBaseUrl.replace(/\/$/, '');
  const idempotencyKey = await checkoutIdempotencyKey(input);
  const session = await stripePost(
    env,
    key,
    '/checkout/sessions',
    {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(input.amountCents),
      'line_items[0][price_data][product_data][name]': `AutoClarity Pre-Purchase Inspection — ${input.requestRef}`,
      customer_email: input.customerEmail,
      client_reference_id: input.bookingId,
      'metadata[request_id]': input.requestId,
      'metadata[quote_id]': input.quoteId,
      'metadata[booking_id]': input.bookingId,
      'metadata[payment_id]': input.paymentId,
      'payment_intent_data[metadata][request_id]': input.requestId,
      'payment_intent_data[metadata][booking_id]': input.bookingId,
      success_url: `${base}/ppi/portal/?checkout=success`,
      cancel_url: `${base}/ppi/portal/?checkout=cancelled`,
      expires_at: String(input.expiresAtEpoch), // fixed to the attempt, never to "now"
    },
    idempotencyKey,
  );
  return {
    id: String(session['id']),
    url: String(session['url']),
    expiresAt: Number(session['expires_at']),
  };
}

/**
 * Closes an open Checkout Session so a request can never have two live
 * sessions (double-charge protection). Returns false when Stripe refused —
 * which includes the dangerous case of a session it has already completed, so
 * callers must never treat false as "safe to replace".
 */
export async function expireCheckoutSession(env: Env, sessionId: string): Promise<boolean> {
  try {
    const key = stripeKey(env);
    await stripePost(env, key, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
    return true;
  } catch {
    return false;
  }
}

export interface RemoteSession {
  /** open | complete | expired */
  status: string;
  /** paid | unpaid | no_payment_required */
  paymentStatus: string;
}

/**
 * Asks Stripe what it currently thinks of a session. The local database is not
 * allowed to decide that a session is dead — only Stripe knows whether money
 * has moved. Returns null when Stripe could not be reached, which callers must
 * treat as "unknown", never as "expired".
 */
export async function retrieveCheckoutSession(env: Env, sessionId: string): Promise<RemoteSession | null> {
  try {
    const key = stripeKey(env);
    const res = await fetch(`${apiBase(env)}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${key}`, 'stripe-version': '2024-06-20' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    return { status: String(body['status'] ?? ''), paymentStatus: String(body['payment_status'] ?? '') };
  } catch {
    return null;
  }
}

/** Money has moved (or is committed) on this session. */
export function sessionIsPayingOrPaid(remote: RemoteSession): boolean {
  return remote.status === 'complete' || remote.paymentStatus === 'paid' || remote.paymentStatus === 'no_payment_required';
}

/**
 * `attemptSeed` should describe this exact refund decision (payment id, amount,
 * and how much was already refunded). A double-submitted refund replays and
 * returns the first refund; a genuine second partial refund has a different
 * seed and goes through.
 */
export async function createRefund(
  env: Env,
  paymentIntent: string,
  amountCents?: number,
  attemptSeed?: string,
): Promise<Record<string, unknown>> {
  const key = stripeKey(env);
  const params: Record<string, string> = { payment_intent: paymentIntent };
  if (amountCents !== undefined) params['amount'] = String(amountCents);
  const idempotencyKey = attemptSeed ? `ppi_rf_${(await sha256Hex(`refund|${paymentIntent}|${attemptSeed}`)).slice(0, 48)}` : undefined;
  return stripePost(env, key, '/refunds', params, idempotencyKey);
}

// ------------------------------------------------------------------ webhooks

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SignatureResult {
  ok: boolean;
  reason?: string;
}

/** Verify a `stripe-signature` header against the raw request body. */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string | undefined,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<SignatureResult> {
  if (!secret) return { ok: false, reason: 'webhook secret not configured' };
  if (!header) return { ok: false, reason: 'missing signature header' };

  let timestamp = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k?.trim() === 't' && v) timestamp = v.trim();
    if (k?.trim() === 'v1' && v) v1.push(v.trim());
  }
  if (!timestamp || v1.length === 0) return { ok: false, reason: 'malformed signature header' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  for (const candidate of v1) {
    if (timingSafeEqual(expected, candidate)) return { ok: true };
  }
  return { ok: false, reason: 'signature mismatch' };
}

/**
 * Idempotency guard: records the event id; returns false when the event was
 * already processed (replay), true when this call owns processing.
 */
export async function claimStripeEvent(db: D1Database, eventId: string, type: string, payloadSha256: string): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO stripe_events (event_id, type, payload_sha256, received_at) VALUES (?, ?, ?, ?)`)
    .bind(eventId, type, payloadSha256, new Date().toISOString())
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function markStripeEventProcessed(db: D1Database, eventId: string): Promise<void> {
  await db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE event_id = ?`).bind(new Date().toISOString(), eventId).run();
}
