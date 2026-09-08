import { nowIso } from './util.ts';

export const PROVIDER_DISPUTE_STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
  'unknown',
] as const;

export type ProviderDisputeStatus = (typeof PROVIDER_DISPUTE_STATUSES)[number];
export type DisputeFundsState = 'unknown' | 'withdrawn' | 'reinstated';
export type DisputeAxisDisposition = 'applied' | 'replay' | 'stale' | 'not_supplied';

export interface PaymentDisputeEventInput {
  providerDisputeId: string;
  paymentId: string;
  paymentIntent: string;
  providerChargeId: string;
  amountCents: number;
  currency: string;
  providerCreated: number;
  eventCreated: number;
  eventId: string;
  providerStatus?: ProviderDisputeStatus;
  fundsState?: DisputeFundsState;
}

export interface PaymentDisputeLedgerRow {
  provider_dispute_id: string;
  payment_id: string;
  payment_intent: string;
  provider_charge_id: string;
  amount_cents: number;
  currency: string;
  provider_created: number;
  provider_status: ProviderDisputeStatus;
  status_event_created: number | null;
  status_event_id: string | null;
  funds_state: DisputeFundsState;
  funds_event_created: number | null;
  funds_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentDisputeEventResult {
  row: PaymentDisputeLedgerRow;
  statusDisposition: DisputeAxisDisposition;
  fundsDisposition: DisputeAxisDisposition;
  /**
   * True for a newly applied event and for an exact retry that is still the
   * current authority on every supplied axis. Downstream reconciliation should
   * run for either case so a prior partial failure can be repaired.
   */
  authoritative: boolean;
  applied: boolean;
}

export interface OrderedDisputeAxis<T extends string> {
  value: T;
  eventCreated: number | null;
  eventId: string | null;
}

export interface IncomingDisputeAxis<T extends string> {
  value: T;
  eventCreated: number;
  eventId: string;
}

export type OrderedAxisDecision = 'apply' | 'replay' | 'stale' | 'conflict';

export function providerDisputeStatusPrecedence(status: ProviderDisputeStatus): number {
  switch (status) {
    case 'lost': return 8;
    case 'won': return 7;
    case 'prevented': return 6;
    case 'warning_closed': return 5;
    case 'under_review': return 4;
    case 'needs_response': return 3;
    case 'warning_under_review': return 2;
    case 'warning_needs_response': return 1;
    case 'unknown': return 0;
  }
}

export function disputeFundsStatePrecedence(state: DisputeFundsState): number {
  switch (state) {
    case 'withdrawn': return 2;
    case 'reinstated': return 1;
    case 'unknown': return 0;
  }
}

/**
 * Stripe event.created is second-granularity. Newer events win; at the same
 * second the caller-provided fail-closed precedence wins, followed by event id
 * as a deterministic delivery-order-independent tiebreaker.
 */
export function decideOrderedDisputeAxis<T extends string>(
  current: OrderedDisputeAxis<T>,
  incoming: IncomingDisputeAxis<T>,
  precedence: (value: T) => number,
): OrderedAxisDecision {
  if (current.eventCreated === null || current.eventId === null) return 'apply';
  if (incoming.eventCreated === current.eventCreated && incoming.eventId === current.eventId) {
    return incoming.value === current.value ? 'replay' : 'conflict';
  }
  if (incoming.eventCreated !== current.eventCreated) {
    return incoming.eventCreated > current.eventCreated ? 'apply' : 'stale';
  }
  const incomingRank = precedence(incoming.value);
  const currentRank = precedence(current.value);
  if (incomingRank !== currentRank) return incomingRank > currentRank ? 'apply' : 'stale';
  return incoming.eventId > current.eventId ? 'apply' : 'stale';
}

export function classifyProviderDisputeStatus(value: unknown): ProviderDisputeStatus {
  return typeof value === 'string' && (PROVIDER_DISPUTE_STATUSES as readonly string[]).includes(value)
    ? value as ProviderDisputeStatus
    : 'unknown';
}

export function disputeFundsStateForEvent(eventType: string): DisputeFundsState | null {
  if (eventType === 'charge.dispute.funds_withdrawn') return 'withdrawn';
  if (eventType === 'charge.dispute.funds_reinstated') return 'reinstated';
  return null;
}

function assertEventInput(input: PaymentDisputeEventInput): void {
  if (!/^du_[A-Za-z0-9_]+$/.test(input.providerDisputeId) || input.providerDisputeId.length > 255) {
    throw new TypeError('Invalid Stripe Dispute id.');
  }
  if (!input.paymentId || input.paymentId.length > 255) {
    throw new TypeError('Stripe Dispute must link to a payment.');
  }
  if (!/^pi_[A-Za-z0-9_]+$/.test(input.paymentIntent) || input.paymentIntent.length > 255) {
    throw new TypeError('Invalid disputed PaymentIntent id.');
  }
  if (!/^ch_[A-Za-z0-9_]+$/.test(input.providerChargeId) || input.providerChargeId.length > 255) {
    throw new TypeError('Invalid disputed Charge id.');
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TypeError('Dispute amount must be positive integer cents.');
  }
  if (!/^[a-z]{3}$/.test(input.currency)) throw new TypeError('Invalid dispute currency.');
  if (!Number.isSafeInteger(input.providerCreated) || input.providerCreated < 0) {
    throw new TypeError('Invalid Stripe Dispute created timestamp.');
  }
  if (!Number.isSafeInteger(input.eventCreated) || input.eventCreated < input.providerCreated) {
    throw new TypeError('Invalid Stripe dispute event created timestamp.');
  }
  if (!input.eventId || input.eventId.length > 255) throw new TypeError('Invalid Stripe event id.');
  if (input.providerStatus === undefined && input.fundsState === undefined) {
    throw new TypeError('Dispute event must update its status or funds axis.');
  }
}

function assertImmutableIdentity(row: PaymentDisputeLedgerRow, input: PaymentDisputeEventInput): void {
  if (
    row.payment_id !== input.paymentId
    || row.payment_intent !== input.paymentIntent
    || row.provider_charge_id !== input.providerChargeId
    || row.amount_cents !== input.amountCents
    || row.currency !== input.currency
    || row.provider_created !== input.providerCreated
  ) {
    throw new Error(`Stripe Dispute ${input.providerDisputeId} changed its immutable payment identity.`);
  }
}

function assertNoEventIdentityConflict(row: PaymentDisputeLedgerRow, input: PaymentDisputeEventInput): void {
  if (
    input.providerStatus !== undefined
    && row.status_event_created === input.eventCreated
    && row.status_event_id === input.eventId
    && row.provider_status !== input.providerStatus
  ) {
    throw new Error(`Stripe event ${input.eventId} conflicts with the stored dispute status payload.`);
  }
  if (
    input.fundsState !== undefined
    && row.funds_event_created === input.eventCreated
    && row.funds_event_id === input.eventId
    && row.funds_state !== input.fundsState
  ) {
    throw new Error(`Stripe event ${input.eventId} conflicts with the stored dispute funds payload.`);
  }
}

const CURRENT_STATUS_RANK_SQL = `(CASE provider_status
  WHEN 'lost' THEN 8
  WHEN 'won' THEN 7
  WHEN 'prevented' THEN 6
  WHEN 'warning_closed' THEN 5
  WHEN 'under_review' THEN 4
  WHEN 'needs_response' THEN 3
  WHEN 'warning_under_review' THEN 2
  WHEN 'warning_needs_response' THEN 1
  ELSE 0 END)`;

const CURRENT_FUNDS_RANK_SQL = `(CASE funds_state
  WHEN 'withdrawn' THEN 2
  WHEN 'reinstated' THEN 1
  ELSE 0 END)`;

function dispositionForStatus(
  row: PaymentDisputeLedgerRow,
  input: PaymentDisputeEventInput,
  changed: boolean,
): DisputeAxisDisposition {
  if (input.providerStatus === undefined) return 'not_supplied';
  const decision = decideOrderedDisputeAxis(
    {
      value: row.provider_status,
      eventCreated: row.status_event_created,
      eventId: row.status_event_id,
    },
    { value: input.providerStatus, eventCreated: input.eventCreated, eventId: input.eventId },
    providerDisputeStatusPrecedence,
  );
  if (decision === 'conflict') {
    throw new Error(`Stripe event ${input.eventId} conflicts with the stored dispute status payload.`);
  }
  if (decision === 'apply') {
    throw new Error(`Stripe dispute status event ${input.eventId} was not persisted.`);
  }
  return decision === 'replay' ? (changed ? 'applied' : 'replay') : 'stale';
}

function dispositionForFunds(
  row: PaymentDisputeLedgerRow,
  input: PaymentDisputeEventInput,
  changed: boolean,
): DisputeAxisDisposition {
  if (input.fundsState === undefined) return 'not_supplied';
  const decision = decideOrderedDisputeAxis(
    {
      value: row.funds_state,
      eventCreated: row.funds_event_created,
      eventId: row.funds_event_id,
    },
    { value: input.fundsState, eventCreated: input.eventCreated, eventId: input.eventId },
    disputeFundsStatePrecedence,
  );
  if (decision === 'conflict') {
    throw new Error(`Stripe event ${input.eventId} conflicts with the stored dispute funds payload.`);
  }
  if (decision === 'apply') {
    throw new Error(`Stripe dispute funds event ${input.eventId} was not persisted.`);
  }
  return decision === 'replay' ? (changed ? 'applied' : 'replay') : 'stale';
}

/**
 * Record one signed Stripe dispute snapshot. Status and funds clocks advance
 * independently. An exact retry is authoritative even when no row changes, so
 * webhook callers can repair downstream state after a partial failure.
 */
export async function recordPaymentDisputeEvent(
  db: D1Database,
  input: PaymentDisputeEventInput,
): Promise<PaymentDisputeEventResult> {
  assertEventInput(input);

  const payment = await db
    .prepare(`SELECT id, stripe_payment_intent, amount_cents, currency FROM payments WHERE id = ?`)
    .bind(input.paymentId)
    .first<{ id: string; stripe_payment_intent: string | null; amount_cents: number; currency: string }>();
  if (!payment) throw new Error(`Payment ${input.paymentId} was not found for dispute reconciliation.`);
  if (payment.stripe_payment_intent !== input.paymentIntent) {
    throw new Error(`Stripe Dispute ${input.providerDisputeId} does not match the payment's PaymentIntent.`);
  }
  if (payment.currency.toLowerCase() !== input.currency) {
    throw new Error(`Stripe Dispute ${input.providerDisputeId} does not match the payment currency.`);
  }
  if (input.amountCents > payment.amount_cents) {
    throw new Error(`Stripe Dispute ${input.providerDisputeId} exceeds the captured payment amount.`);
  }

  const before = await db
    .prepare(`SELECT * FROM payment_disputes WHERE provider_dispute_id = ?`)
    .bind(input.providerDisputeId)
    .first<PaymentDisputeLedgerRow>();
  if (before) {
    assertImmutableIdentity(before, input);
    assertNoEventIdentityConflict(before, input);
  }

  const timestamp = nowIso();
  const inserted = await db
    .prepare(
      `INSERT INTO payment_disputes
         (provider_dispute_id, payment_id, payment_intent, provider_charge_id,
          amount_cents, currency, provider_created, provider_status,
          status_event_created, status_event_id, funds_state,
          funds_event_created, funds_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_dispute_id) DO NOTHING`,
    )
    .bind(
      input.providerDisputeId,
      input.paymentId,
      input.paymentIntent,
      input.providerChargeId,
      input.amountCents,
      input.currency,
      input.providerCreated,
      input.providerStatus ?? 'unknown',
      input.providerStatus === undefined ? null : input.eventCreated,
      input.providerStatus === undefined ? null : input.eventId,
      input.fundsState ?? 'unknown',
      input.fundsState === undefined ? null : input.eventCreated,
      input.fundsState === undefined ? null : input.eventId,
      timestamp,
      timestamp,
    )
    .run();
  const insertedRow = (inserted.meta?.changes ?? 0) === 1;

  // Two first-seen deliveries can both observe `before = null`. Verify the
  // winning INSERT before either axis is allowed to update, so a losing event
  // with conflicting immutable identity cannot mutate the winner's row.
  const identityRow = await db
    .prepare(`SELECT * FROM payment_disputes WHERE provider_dispute_id = ?`)
    .bind(input.providerDisputeId)
    .first<PaymentDisputeLedgerRow>();
  if (!identityRow) throw new Error(`Stripe Dispute ${input.providerDisputeId} was not persisted.`);
  assertImmutableIdentity(identityRow, input);
  assertNoEventIdentityConflict(identityRow, input);

  let statusChanged = false;
  if (!insertedRow && input.providerStatus !== undefined) {
    const rank = providerDisputeStatusPrecedence(input.providerStatus);
    const updated = await db
      .prepare(
        `UPDATE payment_disputes
         SET provider_status = ?, status_event_created = ?, status_event_id = ?, updated_at = ?
         WHERE provider_dispute_id = ?
           AND payment_id = ? AND payment_intent = ? AND provider_charge_id = ?
           AND amount_cents = ? AND currency = ? AND provider_created = ?
           AND (
             status_event_created IS NULL
             OR ? > status_event_created
             OR (? = status_event_created AND ? > ${CURRENT_STATUS_RANK_SQL})
             OR (
               ? = status_event_created AND ? = ${CURRENT_STATUS_RANK_SQL}
               AND ? > status_event_id
             )
           )`,
      )
      .bind(
        input.providerStatus,
        input.eventCreated,
        input.eventId,
        timestamp,
        input.providerDisputeId,
        input.paymentId,
        input.paymentIntent,
        input.providerChargeId,
        input.amountCents,
        input.currency,
        input.providerCreated,
        input.eventCreated,
        input.eventCreated,
        rank,
        input.eventCreated,
        rank,
        input.eventId,
      )
      .run();
    statusChanged = (updated.meta?.changes ?? 0) === 1;
  }

  let fundsChanged = false;
  if (!insertedRow && input.fundsState !== undefined) {
    const rank = disputeFundsStatePrecedence(input.fundsState);
    const updated = await db
      .prepare(
        `UPDATE payment_disputes
         SET funds_state = ?, funds_event_created = ?, funds_event_id = ?, updated_at = ?
         WHERE provider_dispute_id = ?
           AND payment_id = ? AND payment_intent = ? AND provider_charge_id = ?
           AND amount_cents = ? AND currency = ? AND provider_created = ?
           AND (
             funds_event_created IS NULL
             OR ? > funds_event_created
             OR (? = funds_event_created AND ? > ${CURRENT_FUNDS_RANK_SQL})
             OR (
               ? = funds_event_created AND ? = ${CURRENT_FUNDS_RANK_SQL}
               AND ? > funds_event_id
             )
           )`,
      )
      .bind(
        input.fundsState,
        input.eventCreated,
        input.eventId,
        timestamp,
        input.providerDisputeId,
        input.paymentId,
        input.paymentIntent,
        input.providerChargeId,
        input.amountCents,
        input.currency,
        input.providerCreated,
        input.eventCreated,
        input.eventCreated,
        rank,
        input.eventCreated,
        rank,
        input.eventId,
      )
      .run();
    fundsChanged = (updated.meta?.changes ?? 0) === 1;
  }

  const row = await db
    .prepare(`SELECT * FROM payment_disputes WHERE provider_dispute_id = ?`)
    .bind(input.providerDisputeId)
    .first<PaymentDisputeLedgerRow>();
  if (!row) throw new Error(`Stripe Dispute ${input.providerDisputeId} was not persisted.`);
  assertImmutableIdentity(row, input);
  assertNoEventIdentityConflict(row, input);

  const statusDisposition = dispositionForStatus(
    row,
    input,
    input.providerStatus !== undefined && (insertedRow || statusChanged),
  );
  const fundsDisposition = dispositionForFunds(
    row,
    input,
    input.fundsState !== undefined && (insertedRow || fundsChanged),
  );
  const supplied = [statusDisposition, fundsDisposition].filter((value) => value !== 'not_supplied');
  const authoritative = supplied.every((value) => value === 'applied' || value === 'replay');
  return {
    row,
    statusDisposition,
    fundsDisposition,
    authoritative,
    applied: supplied.some((value) => value === 'applied'),
  };
}

export type DisputePaymentDecision =
  | 'no_disputes'
  | 'hold_disputed'
  | 'restore_refund_derived_status'
  | 'manual_reconciliation';

/**
 * Decide only the payment's economic latch. This helper never restores a
 * request, booking, slot, portal link, or capacity after a dispute.
 */
export function disputePaymentDecision(
  rows: ReadonlyArray<Pick<PaymentDisputeLedgerRow, 'provider_status' | 'funds_state'>>,
): DisputePaymentDecision {
  if (rows.length === 0) return 'no_disputes';

  let favorableWithoutFundsProof = false;
  for (const row of rows) {
    if (row.provider_status === 'lost' || row.funds_state === 'withdrawn') return 'hold_disputed';
    if (
      row.provider_status !== 'won'
      && row.provider_status !== 'prevented'
      && row.provider_status !== 'warning_closed'
    ) {
      return 'hold_disputed';
    }
    if (row.funds_state !== 'reinstated') favorableWithoutFundsProof = true;
  }

  return favorableWithoutFundsProof ? 'manual_reconciliation' : 'restore_refund_derived_status';
}

export interface DisputePaymentReconciliation {
  paymentId: string;
  requestId: string;
  previousStatus: string;
  status: string;
  refundedCents: number;
  decision: DisputePaymentDecision;
}

/**
 * Atomically derive the payment's dispute latch from every known Dispute and
 * its refunded balance from the Refund ledger. This deliberately never changes
 * request, booking, slot, link, or capacity state.
 */
export async function reconcilePaymentDisputeState(
  db: D1Database,
  paymentId: string,
): Promise<DisputePaymentReconciliation> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const payment = await db
      .prepare(`SELECT id, request_id, amount_cents, refunded_cents, status FROM payments WHERE id = ?`)
      .bind(paymentId)
      .first<{ id: string; request_id: string; amount_cents: number; refunded_cents: number; status: string }>();
    if (!payment) throw new Error(`Payment ${paymentId} was not found for dispute reconciliation.`);
    if (!['succeeded', 'partially_refunded', 'refunded', 'disputed'].includes(payment.status)) {
      throw new Error(`Payment ${paymentId} cannot enter dispute reconciliation from ${payment.status}.`);
    }

    const updated = await db
      .prepare(
        `WITH refund_total(cents) AS (
           SELECT
             COALESCE((SELECT legacy_refunded_cents FROM payment_refund_ledger_state WHERE payment_id = ?), 0)
             - COALESCE(SUM(legacy_claim_cents), 0)
             + COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END), 0)
           FROM provider_refunds WHERE payment_id = ?
         ),
         dispute_state(has_disputes, can_restore) AS (
           SELECT
             EXISTS (SELECT 1 FROM payment_disputes WHERE payment_id = ?),
             NOT EXISTS (
               SELECT 1 FROM payment_disputes
               WHERE payment_id = ?
                 AND (
                   provider_status NOT IN ('won', 'prevented', 'warning_closed')
                   OR funds_state != 'reinstated'
                 )
             )
         )
         UPDATE payments
         SET refunded_cents = (SELECT cents FROM refund_total),
             status = CASE
               WHEN NOT (SELECT has_disputes FROM dispute_state) THEN status
               WHEN NOT (SELECT can_restore FROM dispute_state) THEN 'disputed'
               WHEN (SELECT cents FROM refund_total) >= amount_cents THEN 'refunded'
               WHEN (SELECT cents FROM refund_total) > 0 THEN 'partially_refunded'
               ELSE 'succeeded'
             END,
             updated_at = ?
         WHERE id = ? AND status = ? AND refunded_cents = ?
           AND (SELECT cents FROM refund_total) BETWEEN 0 AND amount_cents`,
      )
      .bind(
        paymentId,
        paymentId,
        paymentId,
        paymentId,
        nowIso(),
        paymentId,
        payment.status,
        payment.refunded_cents,
      )
      .run();
    if ((updated.meta?.changes ?? 0) !== 1) continue;

    const [persisted, disputes] = await Promise.all([
      db
        .prepare(`SELECT request_id, refunded_cents, status FROM payments WHERE id = ?`)
        .bind(paymentId)
        .first<{ request_id: string; refunded_cents: number; status: string }>(),
      db
        .prepare(`SELECT provider_status, funds_state FROM payment_disputes WHERE payment_id = ?`)
        .bind(paymentId)
        .all<Pick<PaymentDisputeLedgerRow, 'provider_status' | 'funds_state'>>(),
    ]);
    if (!persisted) throw new Error(`Payment ${paymentId} disappeared after dispute reconciliation.`);
    return {
      paymentId,
      requestId: persisted.request_id,
      previousStatus: payment.status,
      status: persisted.status,
      refundedCents: persisted.refunded_cents,
      decision: disputePaymentDecision(disputes.results ?? []),
    };
  }
  throw new Error(`Payment ${paymentId} changed repeatedly during dispute reconciliation.`);
}
