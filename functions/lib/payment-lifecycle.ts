import { expireCheckoutSession, StripeConfigError } from './stripe.ts';
import type { Env } from './types.ts';
import { nowIso } from './util.ts';

export type CheckoutExpiryResult =
  | { ok: true; expired: string[] }
  | { ok: false; code: 'payments_unavailable' | 'reconciliation_required'; detail: string };

/**
 * Provider-confirm every open Checkout Session as expired before a local
 * cancellation is committed. Any ambiguity fails closed, leaving the request
 * active so a late successful charge cannot be attached to a cancelled job.
 */
export async function expireOpenCheckoutAttempts(env: Env, requestId: string): Promise<CheckoutExpiryResult> {
  const rows = await env.DB
    .prepare(
      `SELECT id, stripe_session_id FROM payments
       WHERE request_id = ? AND status IN ('created','pending')
       ORDER BY created_at`,
    )
    .bind(requestId)
    .all<{ id: string; stripe_session_id: string | null }>();
  const expired: string[] = [];
  for (const payment of rows.results ?? []) {
    if (!payment.stripe_session_id) {
      return {
        ok: false,
        code: 'reconciliation_required',
        detail: 'An open payment attempt has no provider session id.',
      };
    }
    try {
      await expireCheckoutSession(env, payment.stripe_session_id);
    } catch (error) {
      return {
        ok: false,
        code: error instanceof StripeConfigError ? 'payments_unavailable' : 'reconciliation_required',
        detail: String(error).slice(0, 240),
      };
    }
    const update = await env.DB
      .prepare(
        `UPDATE payments SET status = 'expired', updated_at = ?
         WHERE id = ? AND status IN ('created','pending')`,
      )
      .bind(nowIso(), payment.id)
      .run();
    if ((update.meta?.changes ?? 0) !== 1) {
      // A concurrently delivered checkout.session.expired webhook may have
      // recorded the exact provider result first. That is equivalent proof,
      // while every other state (especially succeeded) remains ambiguous.
      const persisted = await env.DB
        .prepare(`SELECT status FROM payments WHERE id = ?`)
        .bind(payment.id)
        .first<{ status: string }>();
      if (persisted?.status === 'expired') {
        expired.push(payment.id);
        continue;
      }
      return {
        ok: false,
        code: 'reconciliation_required',
        detail: 'The payment changed while Checkout was being expired.',
      };
    }
    expired.push(payment.id);
  }
  return { ok: true, expired };
}
