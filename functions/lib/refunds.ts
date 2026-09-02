import type { StripeRefundProviderStatus } from './stripe.ts';
import { nowIso } from './util.ts';

export type ProviderRefundLedgerStatus = StripeRefundProviderStatus;

export interface ProviderRefundLedgerInput {
  providerRefundId: string;
  paymentId: string;
  operationId?: string | null;
  attemptId?: string | null;
  amountCents: number;
  currency: string;
  providerCreated?: number | null;
  status: ProviderRefundLedgerStatus;
  eventCreated: number;
  eventId: string;
}

export interface ProviderRefundLedgerRow {
  provider_refund_id: string;
  payment_id: string;
  operation_id: string | null;
  attempt_id: string | null;
  amount_cents: number;
  currency: string;
  provider_created: number | null;
  legacy_claim_cents: number;
  status: ProviderRefundLedgerStatus;
  last_event_created: number;
  last_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface RefundBalanceResult {
  paymentId: string;
  requestId: string;
  amountCents: number;
  previousRefundedCents: number;
  refundedCents: number;
  previousStatus: string;
  status: string;
  wasFullyRefunded: boolean;
  isFullyRefunded: boolean;
  refundRegressionLatched: boolean;
}

export interface RefundReconciliationContext {
  eventId: string;
  providerRefundId: string;
}

export interface StripeRefundIdentityExpectation {
  paymentIntent: string;
  amountCents: number;
  currency: string;
  operationId: string;
  attemptNo: number;
}

export type StripeRefundIdentityResult =
  | {
      ok: true;
      providerRefundId: string;
      paymentIntent: string;
      amountCents: number;
      currency: string;
      providerCreated: number;
    }
  | {
      ok: false;
      providerRefundId: string | null;
      reason: string;
    };

/**
 * Proves that Stripe's immediate Refund response describes the exact local
 * operation that was submitted. A 2xx response alone cannot authorize local
 * balance changes or seed the refund ledger.
 */
export function validateStripeRefundIdentity(
  refund: unknown,
  expected: StripeRefundIdentityExpectation,
): StripeRefundIdentityResult {
  if (refund === null || typeof refund !== 'object' || Array.isArray(refund)) {
    return { ok: false, providerRefundId: null, reason: 'invalid_object' };
  }
  const value = refund as Record<string, unknown>;
  const rawId = typeof value['id'] === 'string' ? value['id'] : '';
  const providerRefundId = /^re_[A-Za-z0-9_]+$/.test(rawId) && rawId.length <= 255 ? rawId : null;
  if (!providerRefundId) return { ok: false, providerRefundId: null, reason: 'invalid_refund_id' };

  const amountCents = value['amount'];
  if (!Number.isSafeInteger(amountCents) || (amountCents as number) <= 0) {
    return { ok: false, providerRefundId, reason: 'invalid_amount' };
  }
  if (amountCents !== expected.amountCents) {
    return { ok: false, providerRefundId, reason: 'amount_mismatch' };
  }

  const currency = typeof value['currency'] === 'string' ? value['currency'].toLowerCase() : '';
  const expectedCurrency = expected.currency.toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) return { ok: false, providerRefundId, reason: 'invalid_currency' };
  if (currency !== expectedCurrency) return { ok: false, providerRefundId, reason: 'currency_mismatch' };

  const paymentIntent = typeof value['payment_intent'] === 'string' ? value['payment_intent'] : '';
  if (paymentIntent !== expected.paymentIntent) {
    return { ok: false, providerRefundId, reason: 'payment_intent_mismatch' };
  }

  const providerCreated = value['created'];
  if (!Number.isSafeInteger(providerCreated) || (providerCreated as number) < 0) {
    return { ok: false, providerRefundId, reason: 'invalid_created' };
  }

  const metadata = value['metadata'];
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { ok: false, providerRefundId, reason: 'invalid_metadata' };
  }
  const meta = metadata as Record<string, unknown>;
  if (meta['refund_operation_id'] !== expected.operationId
    || meta['refund_attempt_no'] !== String(expected.attemptNo)) {
    return { ok: false, providerRefundId, reason: 'metadata_mismatch' };
  }

  return {
    ok: true,
    providerRefundId,
    paymentIntent,
    amountCents: amountCents as number,
    currency,
    providerCreated: providerCreated as number,
  };
}

/**
 * Stripe event.created is second-granularity. When two different events have
 * the same timestamp, negative terminal outcomes win over success, then
 * action-required and pending. Equal states use event id as a stable final
 * tiebreaker so delivery order cannot change the result.
 */
export function providerRefundStatusPrecedence(status: ProviderRefundLedgerStatus): number {
  switch (status) {
    case 'failed': return 5;
    case 'canceled': return 4;
    case 'succeeded': return 3;
    case 'requires_action': return 2;
    case 'pending': return 1;
    case 'unknown': return 0;
  }
}

export function shouldApplyProviderRefundEvent(
  current: Pick<ProviderRefundLedgerRow, 'status' | 'last_event_created' | 'last_event_id'>,
  incoming: Pick<ProviderRefundLedgerInput, 'status' | 'eventCreated' | 'eventId'>,
): boolean {
  if (incoming.eventCreated !== current.last_event_created) {
    return incoming.eventCreated > current.last_event_created;
  }
  const incomingRank = providerRefundStatusPrecedence(incoming.status);
  const currentRank = providerRefundStatusPrecedence(current.status);
  if (incomingRank !== currentRank) return incomingRank > currentRank;
  return incoming.eventId > current.last_event_id;
}

function assertLedgerInput(input: ProviderRefundLedgerInput): void {
  if (!/^re_[A-Za-z0-9_]+$/.test(input.providerRefundId) || input.providerRefundId.length > 255) {
    throw new TypeError('Invalid Stripe Refund id.');
  }
  if (!input.paymentId) throw new TypeError('Provider refund must link to a payment.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TypeError('Provider refund amount must be positive integer cents.');
  }
  if (!/^[a-z]{3}$/.test(input.currency)) throw new TypeError('Invalid provider refund currency.');
  if (input.providerCreated !== undefined && input.providerCreated !== null
    && (!Number.isSafeInteger(input.providerCreated) || input.providerCreated < 0)) {
    throw new TypeError('Invalid Stripe Refund created timestamp.');
  }
  if (!Number.isSafeInteger(input.eventCreated) || input.eventCreated < 0) {
    throw new TypeError('Invalid Stripe event created timestamp.');
  }
  if (!input.eventId || input.eventId.length > 255) throw new TypeError('Invalid Stripe event id.');
}

const STATUS_RANK_SQL = `(CASE excluded.status
  WHEN 'failed' THEN 5
  WHEN 'canceled' THEN 4
  WHEN 'succeeded' THEN 3
  WHEN 'requires_action' THEN 2
  WHEN 'pending' THEN 1
  ELSE 0 END)`;
const CURRENT_STATUS_RANK_SQL = `(CASE provider_refunds.status
  WHEN 'failed' THEN 5
  WHEN 'canceled' THEN 4
  WHEN 'succeeded' THEN 3
  WHEN 'requires_action' THEN 2
  WHEN 'pending' THEN 1
  ELSE 0 END)`;

/** Upsert one Refund object, accepting only an authoritative event ordering. */
export async function upsertProviderRefund(
  db: D1Database,
  input: ProviderRefundLedgerInput,
): Promise<{ row: ProviderRefundLedgerRow; applied: boolean; authoritative: boolean }> {
  assertLedgerInput(input);
  const existing = await db
    .prepare(`SELECT * FROM provider_refunds WHERE provider_refund_id = ?`)
    .bind(input.providerRefundId)
    .first<ProviderRefundLedgerRow>();
  if (existing && existing.payment_id !== input.paymentId) {
    throw new Error(`Stripe Refund ${input.providerRefundId} is already linked to another payment.`);
  }
  if (existing && (existing.amount_cents !== input.amountCents || existing.currency !== input.currency)) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its immutable amount or currency.`);
  }
  if (existing?.provider_created != null && input.providerCreated != null
    && existing.provider_created !== input.providerCreated) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its immutable created timestamp.`);
  }
  if (existing?.operation_id && input.operationId && existing.operation_id !== input.operationId) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its operation association.`);
  }
  if (existing?.attempt_id && input.attemptId && existing.attempt_id !== input.attemptId) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its attempt association.`);
  }

  const legacyState = !existing
    ? await db
        .prepare(
          `SELECT legacy_refunded_cents, ledger_started_at,
                  COALESCE((SELECT SUM(legacy_claim_cents) FROM provider_refunds WHERE payment_id = ?), 0) AS claimed_cents
           FROM payment_refund_ledger_state WHERE payment_id = ?`,
        )
        .bind(input.paymentId, input.paymentId)
        .first<{ legacy_refunded_cents: number; ledger_started_at: number; claimed_cents: number }>()
    : null;
  const unclaimedLegacyCents = legacyState
    ? legacyState.legacy_refunded_cents - legacyState.claimed_cents
    : 0;
  if (legacyState && unclaimedLegacyCents > 0) {
    if (input.providerCreated == null || input.providerCreated === legacyState.ledger_started_at) {
      throw new Error(`Stripe Refund ${input.providerRefundId} cannot be classified against the locked legacy balance without an unambiguous created timestamp.`);
    }
    if (input.providerCreated < legacyState.ledger_started_at && input.amountCents > unclaimedLegacyCents) {
      throw new Error(`Stripe Refund ${input.providerRefundId} exceeds the unclaimed historical refund balance.`);
    }
  }
  const legacyClaimCents = legacyState
    && input.providerCreated != null
    && input.providerCreated < legacyState.ledger_started_at
    && input.amountCents <= unclaimedLegacyCents
    ? input.amountCents
    : 0;

  const timestamp = nowIso();
  const result = await db
    .prepare(
      `INSERT INTO provider_refunds
         (provider_refund_id, payment_id, operation_id, attempt_id, amount_cents,
          currency, provider_created, legacy_claim_cents, status,
          last_event_created, last_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_refund_id) DO UPDATE SET
         amount_cents = excluded.amount_cents,
         currency = excluded.currency,
         provider_created = COALESCE(provider_refunds.provider_created, excluded.provider_created),
         status = excluded.status,
         last_event_created = excluded.last_event_created,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at
       WHERE excluded.payment_id = provider_refunds.payment_id
         AND excluded.amount_cents = provider_refunds.amount_cents
         AND excluded.currency = provider_refunds.currency
         AND (
           excluded.provider_created IS NULL
           OR provider_refunds.provider_created IS NULL
           OR excluded.provider_created = provider_refunds.provider_created
         )
         AND (
           excluded.last_event_created > provider_refunds.last_event_created
           OR (
             excluded.last_event_created = provider_refunds.last_event_created
             AND ${STATUS_RANK_SQL} > ${CURRENT_STATUS_RANK_SQL}
           )
           OR (
             excluded.last_event_created = provider_refunds.last_event_created
             AND ${STATUS_RANK_SQL} = ${CURRENT_STATUS_RANK_SQL}
             AND excluded.last_event_id > provider_refunds.last_event_id
           )
         )`,
    )
    .bind(
      input.providerRefundId,
      input.paymentId,
      input.operationId ?? null,
      input.attemptId ?? null,
      input.amountCents,
      input.currency,
      input.providerCreated ?? null,
      legacyClaimCents,
      input.status,
      input.eventCreated,
      input.eventId,
      timestamp,
      timestamp,
    )
    .run();

  // Association metadata may arrive on an older delivery. It can fill an
  // empty link but can never replace an existing operation/attempt link.
  if (input.operationId || input.attemptId) {
    await db
      .prepare(
        `UPDATE provider_refunds
         SET operation_id = COALESCE(operation_id, ?),
             attempt_id = COALESCE(attempt_id, ?)
         WHERE provider_refund_id = ? AND payment_id = ?`,
      )
      .bind(input.operationId ?? null, input.attemptId ?? null, input.providerRefundId, input.paymentId)
      .run();
  }

  const row = await db
    .prepare(`SELECT * FROM provider_refunds WHERE provider_refund_id = ?`)
    .bind(input.providerRefundId)
    .first<ProviderRefundLedgerRow>();
  if (!row) throw new Error(`Provider refund ${input.providerRefundId} was not persisted.`);
  if (row.payment_id !== input.paymentId) {
    throw new Error(`Provider refund ${input.providerRefundId} changed payment association.`);
  }
  if (row.amount_cents !== input.amountCents || row.currency !== input.currency) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its immutable amount or currency.`);
  }
  if (row.provider_created != null && input.providerCreated != null
    && row.provider_created !== input.providerCreated) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its immutable created timestamp.`);
  }
  if (input.operationId && row.operation_id !== input.operationId) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its operation association.`);
  }
  if (input.attemptId && row.attempt_id !== input.attemptId) {
    throw new Error(`Stripe Refund ${input.providerRefundId} changed its attempt association.`);
  }
  const authoritative = row.last_event_created === input.eventCreated
    && row.last_event_id === input.eventId;
  return { row, applied: (result.meta?.changes ?? 0) === 1 && authoritative, authoritative };
}

/** Rebuild the payment balance from currently succeeded Refund objects. */
export async function recomputePaymentRefundBalance(
  db: D1Database,
  paymentId: string,
  context: RefundReconciliationContext,
): Promise<RefundBalanceResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const payment = await db
      .prepare(`SELECT id, request_id, amount_cents, refunded_cents, status FROM payments WHERE id = ?`)
      .bind(paymentId)
      .first<{ id: string; request_id: string; amount_cents: number; refunded_cents: number; status: string }>();
    if (!payment) throw new Error(`Payment ${paymentId} was not found for refund reconciliation.`);

    // The total is evaluated inside the guarded UPDATE, not read into Worker
    // memory. Concurrent Refund events therefore cannot write an older sum
    // after a newer one; a changed payment snapshot retries the whole CAS.
    const reconciledAt = nowIso();
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `WITH refund_total(cents) AS (
           SELECT
             COALESCE((SELECT legacy_refunded_cents FROM payment_refund_ledger_state WHERE payment_id = ?), 0)
             - COALESCE(SUM(legacy_claim_cents), 0)
             + COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END), 0)
           FROM provider_refunds WHERE payment_id = ?
         )
         UPDATE payments
         SET refunded_cents = (SELECT cents FROM refund_total),
             status = CASE
               WHEN status = 'disputed' THEN 'disputed'
               WHEN (SELECT cents FROM refund_total) >= amount_cents THEN 'refunded'
               WHEN (SELECT cents FROM refund_total) > 0 THEN 'partially_refunded'
               WHEN status IN ('succeeded','partially_refunded','refunded') THEN 'succeeded'
               ELSE status
             END,
             updated_at = ?
         WHERE id = ? AND refunded_cents = ? AND status = ?
           AND (SELECT cents FROM refund_total) BETWEEN 0 AND amount_cents`,
      ).bind(paymentId, paymentId, reconciledAt, paymentId, payment.refunded_cents, payment.status),
    ];
    // The payment balance and this durable regression latch commit in the
    // same D1 transaction. If later request/evidence/outbox work fails, an
    // exact webhook retry can still prove that a formerly full refund fell.
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO admin_audit_log
             (id, actor, action, entity, entity_id, details_json, created_at)
           SELECT ?, 'system:stripe-webhook', 'refund_reconciliation_needed',
                  'payment', p.id,
                  json_object(
                    'providerRefundId', ?,
                    'eventId', ?,
                    'previousRefundedCents', ?,
                    'refundedCents', p.refunded_cents,
                    'capacityRestored', json('false')
                  ), ?
           FROM payments p
           WHERE p.id = ? AND changes() = 1
             AND ? >= p.amount_cents
             AND p.refunded_cents < p.amount_cents`,
      ).bind(
        `al_refund_reconcile_${context.eventId}`,
        context.providerRefundId,
        context.eventId,
        payment.refunded_cents,
        reconciledAt,
        paymentId,
        payment.refunded_cents,
      ),
    );
    const results = await db.batch(statements);
    const updated = results[0];
    if ((updated?.meta?.changes ?? 0) !== 1) {
      const stillExists = await db
        .prepare(`SELECT 1 AS present FROM payments WHERE id = ?`)
        .bind(paymentId)
        .first<{ present: number }>();
      if (!stillExists) throw new Error(`Payment ${paymentId} disappeared during refund reconciliation.`);
      continue;
    }

    const regressionLatchPromise = db
      .prepare(
        `SELECT 1 AS latched FROM admin_audit_log
         WHERE id = ? AND action = 'refund_reconciliation_needed'
           AND entity = 'payment' AND entity_id = ? LIMIT 1`,
      )
      .bind(`al_refund_reconcile_${context.eventId}`, paymentId)
      .first<{ latched: number }>();
    const [persisted, regressionLatch] = await Promise.all([
      db
        .prepare(`SELECT request_id, amount_cents, refunded_cents, status FROM payments WHERE id = ?`)
        .bind(paymentId)
        .first<{ request_id: string; amount_cents: number; refunded_cents: number; status: string }>(),
      regressionLatchPromise,
    ]);
    if (!persisted) throw new Error(`Payment ${paymentId} disappeared after refund reconciliation.`);
    return {
      paymentId,
      requestId: persisted.request_id,
      amountCents: persisted.amount_cents,
      previousRefundedCents: payment.refunded_cents,
      refundedCents: persisted.refunded_cents,
      previousStatus: payment.status,
      status: persisted.status,
      wasFullyRefunded: payment.refunded_cents >= payment.amount_cents,
      isFullyRefunded: persisted.refunded_cents >= persisted.amount_cents,
      refundRegressionLatched: Boolean(regressionLatch),
    };
  }
  throw new Error(`Payment ${paymentId} changed repeatedly during refund reconciliation.`);
}
