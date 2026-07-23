// Stripe integration via the REST API (no SDK dependency in the Worker).
// Checkout Sessions for one-time physical-service payments only. Webhooks —
// never the browser redirect — are the source of truth for payment status.

import { timingSafeEqual } from './util.ts';
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

async function stripePost(env: Env, key: string, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase(env)}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': '2024-06-20',
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
  amountCents: number;
  customerEmail: string;
  publicBaseUrl: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: number;
}

/**
 * Fresh Checkout Session per attempt. Metadata carries ONLY internal ids —
 * never VIN, address, notes or diagnostics.
 */
export async function createCheckoutSession(env: Env, input: CheckoutInput): Promise<CheckoutSession> {
  const key = stripeKey(env);
  const base = input.publicBaseUrl.replace(/\/$/, '');
  const session = await stripePost(env, key, '/checkout/sessions', {
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
    'payment_intent_data[metadata][request_id]': input.requestId,
    'payment_intent_data[metadata][booking_id]': input.bookingId,
    success_url: `${base}/ppi/portal/?checkout=success`,
    cancel_url: `${base}/ppi/portal/?checkout=cancelled`,
    expires_at: String(Math.floor(Date.now() / 1000) + 1800), // 30 min minimum
  });
  return {
    id: String(session['id']),
    url: String(session['url']),
    expiresAt: Number(session['expires_at']),
  };
}

export async function createRefund(env: Env, paymentIntent: string, amountCents?: number): Promise<Record<string, unknown>> {
  const key = stripeKey(env);
  const params: Record<string, string> = { payment_intent: paymentIntent };
  if (amountCents !== undefined) params['amount'] = String(amountCents);
  return stripePost(env, key, '/refunds', params);
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
