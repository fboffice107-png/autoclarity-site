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

export class StripeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }

  /** A 4xx response proves Stripe rejected the operation before success. */
  get definitiveFailure(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/**
 * Returns the Stripe secret key after safety checks:
 * - payments must be enabled
 * - test env requires sk_test_; a live key is refused unless STRIPE_ENV=live
 *   AND PPI_ENV=production AND PPI_MODE=live (owner-approved launch state).
 */
export function stripeKey(env: Env): string {
  const flags = modeFlags(env);
  if (!flags.paymentsEnabled) throw new StripeConfigError('Payments are not enabled in this environment.');
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeConfigError('STRIPE_SECRET_KEY is not configured.');
  if (flags.stripeEnv === 'test') {
    if (!key.startsWith('sk_test_')) throw new StripeConfigError('STRIPE_ENV=test requires an sk_test_ key.');
  } else {
    if (!key.startsWith('sk_live_')) throw new StripeConfigError('STRIPE_ENV=live requires an sk_live_ key.');
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
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/x-www-form-urlencoded',
    'stripe-version': '2024-06-20',
    'user-agent': 'AutoClarity-PPI/1.0',
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey.slice(0, 255);
  const res = await fetch(`${apiBase(env)}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    if (!res.ok) {
      throw new StripeApiError(`Stripe ${path} failed (${res.status}): invalid provider response`, res.status);
    }
    throw new Error(`Stripe ${path} returned an invalid success response.`);
  }
  if (!res.ok) {
    const err = (body as { error?: { message?: string; type?: string } }).error;
    throw new StripeApiError(`Stripe ${path} failed (${res.status}): ${err?.message ?? 'unknown error'}`, res.status);
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
  attempt: number;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: number;
}

export type CheckoutAttemptDecision =
  | { kind: 'new'; attempt: number }
  | { kind: 'reuse'; attempt: number }
  | { kind: 'already_paid' }
  | { kind: 'reconciliation_required' };

/**
 * Chooses whether checkout may be opened without risking another charge.
 * Locally ageing an attempt is not proof that Stripe expired it, so an
 * ambiguous/stale attempt fails closed until a verified webhook resolves it.
 */
export function decideCheckoutAttempt(
  total: number,
  activeCount: number,
  activeCreatedAt: string | null,
  succeededCount: number,
  nowMs = Date.now(),
): CheckoutAttemptDecision {
  const safeTotal = Number.isInteger(total) && total > 0 ? total : 0;
  if (succeededCount > 0) return { kind: 'already_paid' };
  if (activeCount > 1) return { kind: 'reconciliation_required' };
  if (activeCount === 1) {
    const createdMs = activeCreatedAt ? Date.parse(activeCreatedAt) : Number.NaN;
    if (!Number.isFinite(createdMs) || createdMs > nowMs || nowMs - createdMs >= 30 * 60_000) {
      return { kind: 'reconciliation_required' };
    }
    return { kind: 'reuse', attempt: Math.max(1, safeTotal) };
  }
  return { kind: 'new', attempt: safeTotal + 1 };
}

/**
 * One Stripe-idempotent Checkout Session per database attempt. Metadata
 * carries ONLY internal ids — never VIN, address, notes or diagnostics.
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
    // Stripe's lower bound is 30 minutes; leave margin for request latency.
    expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
  }, `checkout/${input.bookingId}/${input.quoteId}/${input.attempt}`);
  return {
    id: String(session['id']),
    url: String(session['url']),
    expiresAt: Number(session['expires_at']),
  };
}

export type StripeRefundProviderStatus =
  | 'pending'
  | 'succeeded'
  | 'requires_action'
  | 'failed'
  | 'canceled'
  | 'unknown';

/**
 * Classifies the explicit status on a Stripe Refund object. Stripe can return
 * a Refund object with a non-success terminal or action-required status from
 * a successful API request, so HTTP success alone must not drive local state.
 */
export function classifyStripeRefundStatus(refund: unknown): StripeRefundProviderStatus {
  if (refund === null || typeof refund !== 'object' || Array.isArray(refund)) return 'unknown';
  const status = (refund as { status?: unknown }).status;
  switch (status) {
    case 'pending':
    case 'succeeded':
    case 'requires_action':
    case 'failed':
    case 'canceled':
      return status;
    default:
      return 'unknown';
  }
}

export async function createRefund(
  env: Env,
  paymentIntent: string,
  amountCents?: number,
  idempotencyKey?: string,
  metadata?: { operationId: string; attemptNo: number },
): Promise<Record<string, unknown>> {
  const key = stripeKey(env);
  const params: Record<string, string> = { payment_intent: paymentIntent };
  if (amountCents !== undefined) params['amount'] = String(amountCents);
  if (metadata) {
    params['metadata[refund_operation_id]'] = metadata.operationId.slice(0, 255);
    params['metadata[refund_attempt_no]'] = String(metadata.attemptNo);
  }
  return stripePost(env, key, '/refunds', params, idempotencyKey);
}

/**
 * Expires an open Checkout Session. Restrict the provider id to Stripe's
 * ASCII `cs_` shape before interpolating it into the request path.
 */
export async function expireCheckoutSession(env: Env, sessionId: string): Promise<Record<string, unknown>> {
  if (sessionId.length < 6 || sessionId.length > 255 || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    throw new TypeError('Invalid Stripe Checkout Session id.');
  }
  const key = stripeKey(env);
  return stripePost(env, key, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
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
 * Idempotency guard: records the event id; returns false for a processed or
 * currently-owned replay. An unprocessed claim older than five minutes can be
 * reclaimed, recovering a Worker termination between claim and completion.
 */
export async function claimStripeEvent(db: D1Database, eventId: string, type: string, payloadSha256: string): Promise<boolean> {
  const now = new Date();
  const receivedAt = now.toISOString();
  const result = await db
    .prepare(`INSERT OR IGNORE INTO stripe_events (event_id, type, payload_sha256, received_at) VALUES (?, ?, ?, ?)`)
    .bind(eventId, type, payloadSha256, receivedAt)
    .run();
  if ((result.meta?.changes ?? 0) === 1) return true;

  const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  const reclaimed = await db
    .prepare(
      `UPDATE stripe_events SET received_at = ?
       WHERE event_id = ? AND type = ? AND payload_sha256 = ?
         AND processed_at IS NULL AND received_at < ?`,
    )
    .bind(receivedAt, eventId, type, payloadSha256, staleBefore)
    .run();
  return (reclaimed.meta?.changes ?? 0) === 1;
}

export async function markStripeEventProcessed(db: D1Database, eventId: string): Promise<void> {
  await db.prepare(`UPDATE stripe_events SET processed_at = ? WHERE event_id = ?`).bind(new Date().toISOString(), eventId).run();
}
