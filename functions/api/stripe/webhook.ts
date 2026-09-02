// POST /api/stripe/webhook — the ONLY authority on payment state.
// Signature-verified, replay-proof (event ids recorded), idempotent handlers.
// Confirming a booking happens HERE, never on the browser success redirect.

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import {
  classifyStripeRefundStatus,
  verifyStripeSignature,
  claimStripeEvent,
  markStripeEventProcessed,
  STRIPE_CHECKOUT_CURRENCY,
  type StripeRefundProviderStatus,
} from '../../lib/stripe.ts';
import { applyStatus, isStatus, type Status } from '../../lib/status.ts';
import { getConfig } from '../../lib/config.ts';
import { queueTemplate, requireRecordedEmail } from '../../lib/email.ts';
import { issueMagicLink, portalUrl } from '../../lib/magic.ts';
import { applyTerminalLifecycle } from '../../lib/lifecycle.ts';
import {
  recomputePaymentRefundBalance,
  upsertProviderRefund,
  type ProviderRefundLedgerRow,
} from '../../lib/refunds.ts';
import {
  classifyProviderDisputeStatus,
  disputeFundsStateForEvent,
  reconcilePaymentDisputeState,
  recordPaymentDisputeEvent,
} from '../../lib/disputes.ts';
import { errorJson, formatCents, json, nowIso, sha256Hex } from '../../lib/util.ts';

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  created?: number;
  data: { object: Record<string, unknown> };
}

type WaitUntil = (promise: Promise<unknown>) => void;

type RefundLifecycleStatus =
  | 'requested'
  | 'pending'
  | 'provider_accepted'
  | 'requires_action'
  | 'confirmed'
  | 'failed'
  | 'canceled'
  | 'reconciliation_required';

function refundWebhookOutcome(providerStatus: StripeRefundProviderStatus): RefundLifecycleStatus {
  switch (providerStatus) {
    case 'succeeded': return 'provider_accepted';
    case 'pending':
    case 'requires_action':
    case 'failed':
    case 'canceled':
      return providerStatus;
    default:
      return 'reconciliation_required';
  }
}

/**
 * Local lifecycle mapping only. Event ordering is enforced by provider_refunds;
 * an authoritative later failure is therefore allowed to replace success.
 */
export function reconcileRefundLifecycle(
  _current: RefundLifecycleStatus,
  incoming: RefundLifecycleStatus,
): RefundLifecycleStatus {
  return incoming;
}

function stripeEventCreated(event: StripeEvent): number {
  const value = Number(event.created);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Stripe commerce event omitted a valid top-level created timestamp.');
  }
  return value;
}

export function stripeWebhookBase(requestUrl: string, configuredBase?: string): string {
  return (configuredBase || new URL(requestUrl).origin).replace(/\/$/, '');
}

function fmtSlot(startsAt: string, timezone: string): string {
  return new Date(startsAt).toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const db = env.DB;
  const waitUntil: WaitUntil = (promise) => context.waitUntil(promise);
  const publicBase = stripeWebhookBase(request.url, env.PUBLIC_BASE_URL);

  const payload = await request.text();
  const signature = request.headers.get('stripe-signature');
  const verified = await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!verified.ok) {
    console.error('stripe_webhook_rejected', verified.reason);
    return errorJson('bad_signature', 'Webhook signature verification failed.', 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return errorJson('bad_json', 'Invalid JSON payload.', 400);
  }
  if (!event.id || !event.type || typeof event.livemode !== 'boolean') {
    return errorJson('bad_event', 'Malformed event.', 400);
  }

  // This check is independent of PAYMENTS_ENABLED so a late, authentic event
  // can still reconcile an existing payment after Checkout has been disabled.
  // It must happen before the event is claimed or any commerce row is mutated.
  const expectedLivemode = modeFlags(env).stripeEnv === 'live';
  if (event.livemode !== expectedLivemode) {
    console.error('stripe_webhook_mode_mismatch', event.id, event.livemode ? 'live' : 'test');
    return errorJson('stripe_mode_mismatch', 'Webhook mode does not match this environment.', 400);
  }

  const claim = await claimStripeEvent(db, event.id, event.type, await sha256Hex(payload));
  if (claim === 'processed') return json({ received: true, replay: true });
  if (claim === 'in_progress') {
    return json(
      { error: { code: 'event_in_progress', message: 'Event processing is already in progress; retry later.' } },
      409,
      { 'retry-after': '5' },
    );
  }

  const obj = event.data?.object ?? {};
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj['payment_status'] === 'unpaid') {
          // Delayed-notification methods complete Checkout before funds are
          // available. Authenticate the complete commerce identity, then leave
          // the active payment/booking untouched for the later async outcome.
          await validateCheckoutSessionIdentity(env, obj, 'unpaid');
        } else {
          await handlePaymentSucceeded(env, obj, waitUntil, publicBase);
        }
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        await handlePaymentSucceeded(env, obj, waitUntil, publicBase);
        break;
      }
      case 'checkout.session.async_payment_failed': {
        await handlePaymentFailed(env, obj);
        break;
      }
      case 'checkout.session.expired': {
        await db
          .prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE stripe_session_id = ? AND status IN ('created','pending')`)
          .bind(nowIso(), String(obj['id'] ?? ''))
          .run();
        break;
      }
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed': {
        await handleRefundStatusEvent(env, event.id, stripeEventCreated(event), event.type, obj, waitUntil, publicBase);
        break;
      }
      case 'charge.refunded': {
        await handleChargeRefunded(env, event.id, stripeEventCreated(event), obj, waitUntil, publicBase);
        break;
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_reinstated':
      case 'charge.dispute.funds_withdrawn': {
        await handleDisputeEvent(
          env,
          event.id,
          stripeEventCreated(event),
          event.type,
          obj,
          waitUntil,
          publicBase,
        );
        break;
      }
      default:
        break;
    }
    await markStripeEventProcessed(db, event.id);
    return json({ received: true });
  } catch (e) {
    // A failed reconciliation releases only its unprocessed event claim. Stripe
    // can retry, and the payment handler resumes even when status is succeeded.
    try {
      await db.prepare(`DELETE FROM stripe_events WHERE event_id = ? AND processed_at IS NULL`).bind(event.id).run();
    } catch (releaseError) {
      console.error('stripe_event_claim_release_failed', event.id, String(releaseError).slice(0, 240));
    }
    console.error('stripe_webhook_error', event.type, String(e).slice(0, 400));
    return errorJson('processing_failed', 'Event processing failed; Stripe should retry.', 500);
  }
};

interface DisputedPaymentLink {
  payment_id: string;
  request_id: string;
  payment_amount_cents: number;
  payment_currency: string;
  payment_status: string;
  request_status: string;
  ref: string;
  email: string;
}

function disputeNotificationKind(eventType: string, status: string, fundsState: string): string {
  if (eventType === 'charge.dispute.created') return 'PAYMENT DISPUTE OPENED';
  if (eventType === 'charge.dispute.closed') return `PAYMENT DISPUTE CLOSED — ${status.toUpperCase()}`;
  if (eventType === 'charge.dispute.funds_reinstated') return 'DISPUTE FUNDS REINSTATED';
  if (eventType === 'charge.dispute.funds_withdrawn') return 'DISPUTE FUNDS WITHDRAWN';
  return `PAYMENT DISPUTE UPDATED — ${status.toUpperCase()} / ${fundsState.toUpperCase()}`;
}

/**
 * Reconcile Stripe's independent dispute-status and funds-movement streams.
 * A favorable provider outcome may release only the payment's economic latch;
 * request, booking, slot, portal-link, and capacity state remain closed.
 */
async function handleDisputeEvent(
  env: Env,
  eventId: string,
  eventCreated: number,
  eventType: string,
  obj: Record<string, unknown>,
  waitUntil: WaitUntil,
  publicBase: string,
): Promise<void> {
  const db = env.DB;
  const providerDisputeId = String(obj['id'] ?? '');
  const paymentIntent = String(obj['payment_intent'] ?? '');
  const providerChargeId = String(obj['charge'] ?? '');
  const amountCents = Number(obj['amount']);
  const currency = String(obj['currency'] ?? '').toLowerCase();
  const providerCreated = Number(obj['created']);
  const providerStatus = classifyProviderDisputeStatus(obj['status']);
  const fundsState = disputeFundsStateForEvent(eventType) ?? undefined;

  if (!/^du_[A-Za-z0-9_]+$/.test(providerDisputeId) || providerDisputeId.length > 255) {
    throw new Error('Stripe dispute event omitted a valid Dispute id.');
  }
  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntent) || paymentIntent.length > 255) {
    throw new Error(`Stripe Dispute ${providerDisputeId} omitted a valid PaymentIntent id.`);
  }
  if (!/^ch_[A-Za-z0-9_]+$/.test(providerChargeId) || providerChargeId.length > 255) {
    throw new Error(`Stripe Dispute ${providerDisputeId} omitted a valid Charge id.`);
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error(`Stripe Dispute ${providerDisputeId} omitted a valid amount.`);
  }
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error(`Stripe Dispute ${providerDisputeId} omitted a valid currency.`);
  }
  if (!Number.isSafeInteger(providerCreated) || providerCreated < 0) {
    throw new Error(`Stripe Dispute ${providerDisputeId} omitted a valid created timestamp.`);
  }
  if (
    eventType === 'charge.dispute.closed'
    && !['won', 'lost', 'prevented', 'warning_closed'].includes(providerStatus)
  ) {
    throw new Error(`Closed Stripe Dispute ${providerDisputeId} has non-terminal status ${providerStatus}.`);
  }

  const matches = await db
    .prepare(
      `SELECT p.id AS payment_id, p.request_id,
              p.amount_cents AS payment_amount_cents,
              p.currency AS payment_currency, p.status AS payment_status,
              r.status AS request_status, r.ref, c.email
       FROM payments p
       JOIN ppi_requests r ON r.id = p.request_id
       JOIN customers c ON c.id = r.customer_id
       WHERE p.stripe_payment_intent = ? AND r.deleted_at IS NULL
       LIMIT 2`,
    )
    .bind(paymentIntent)
    .all<DisputedPaymentLink>();
  const paymentLinks = matches.results ?? [];
  if (paymentLinks.length !== 1) {
    throw new Error(
      paymentLinks.length === 0
        ? `Stripe Dispute ${providerDisputeId} cannot yet be linked to its local payment; retry after Checkout reconciliation.`
        : `Stripe Dispute ${providerDisputeId} PaymentIntent maps to multiple local payments.`,
    );
  }
  const payment = paymentLinks[0]!;
  if (!isStatus(payment.request_status)) {
    throw new Error(`Disputed payment ${payment.payment_id} has no valid request.`);
  }

  const recorded = await recordPaymentDisputeEvent(db, {
    providerDisputeId,
    paymentId: payment.payment_id,
    paymentIntent,
    providerChargeId,
    amountCents,
    currency,
    providerCreated,
    eventCreated,
    eventId,
    providerStatus,
    fundsState,
  });
  const reconciliation = await reconcilePaymentDisputeState(db, payment.payment_id);

  // This is deliberately re-run for exact authoritative retries: if a prior
  // attempt stopped after recording the event, the same delivery repairs all
  // terminal request/capacity effects before Stripe receives a 2xx response.
  const lifecycle = await applyTerminalLifecycle(db, {
    requestId: payment.request_id,
    to: 'disputed',
    actor: 'system:stripe-webhook',
    reason: `Stripe dispute ${providerDisputeId}: ${recorded.row.provider_status}; funds ${recorded.row.funds_state}`,
    relatedId: providerDisputeId,
  });
  if (!lifecycle.ok) {
    throw new Error(`Request ${payment.request_id} could not reconcile to disputed from ${payment.request_status}.`);
  }

  await db
    .prepare(
      `INSERT OR IGNORE INTO admin_audit_log
         (id, actor, action, entity, entity_id, details_json, created_at)
       VALUES (?, 'system:stripe-webhook', 'dispute_reconciled', 'payment_dispute', ?, ?, ?)`,
    )
    .bind(
      `al_dispute_${eventId}_${providerDisputeId}`,
      providerDisputeId,
      JSON.stringify({
        eventType,
        eventId,
        providerDisputeId,
        providerStatus: recorded.row.provider_status,
        fundsState: recorded.row.funds_state,
        statusDisposition: recorded.statusDisposition,
        fundsDisposition: recorded.fundsDisposition,
        paymentDecision: reconciliation.decision,
        paymentStatus: reconciliation.status,
      }),
      nowIso(),
    )
    .run();

  if ((recorded.applied || recorded.authoritative) && env.ADMIN_NOTIFY_EMAIL) {
    const config = await getConfig(db);
    requireRecordedEmail(
      await queueTemplate(env, db, payment.request_id, 'owner_dispute_update', env.ADMIN_NOTIFY_EMAIL, {
        ref: payment.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind: disputeNotificationKind(eventType, recorded.row.provider_status, recorded.row.funds_state),
          disputeId: providerDisputeId,
          amount: formatCents(recorded.row.amount_cents),
          status: recorded.row.provider_status,
          fundsState: recorded.row.funds_state,
          paymentStatus: reconciliation.status,
          adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(payment.request_id)}`,
        },
      }, waitUntil, payment.email, `owner_dispute:${providerDisputeId}:${eventId}`),
      'owner_dispute_update',
    );
  }
}

interface RefundLinkRow {
  attempt_id: string | null;
  operation_id: string | null;
  attempt_no: number | null;
  attempt_status: RefundLifecycleStatus | null;
  operation_status: RefundLifecycleStatus | null;
  operation_attempt_count: number | null;
  request_id: string;
  payment_id: string;
  requested_amount_cents: number | null;
  amount_cents: number;
  currency: string;
  request_status: string;
  ref: string;
  email: string;
}

interface RecordedRefund {
  link: RefundLinkRow;
  ledger: ProviderRefundLedgerRow;
  applied: boolean;
  authoritative: boolean;
  providerStatus: StripeRefundProviderStatus;
  failure: string | null;
}

const REFUND_ATTEMPT_SELECT = `
  SELECT a.id AS attempt_id, a.operation_id, a.attempt_no,
         a.outcome_status AS attempt_status,
         o.status AS operation_status, o.attempt_count AS operation_attempt_count,
         o.request_id, o.payment_id, o.requested_amount_cents,
         p.amount_cents, p.currency, r.status AS request_status, r.ref, c.email
  FROM refund_operation_attempts a
  JOIN refund_operations o ON o.id = a.operation_id
  JOIN payments p ON p.id = o.payment_id
  JOIN ppi_requests r ON r.id = o.request_id
  JOIN customers c ON c.id = r.customer_id`;

async function uniqueRefundLink(
  statement: D1PreparedStatement,
  ambiguousMessage: string,
): Promise<RefundLinkRow | null> {
  const result = await statement.all<RefundLinkRow>();
  const rows = result.results ?? [];
  if (rows.length > 1) throw new Error(ambiguousMessage);
  return rows[0] ?? null;
}

function mergeRefundLink(
  providerRefundId: string,
  current: RefundLinkRow | null,
  candidate: RefundLinkRow | null,
  source: string,
): RefundLinkRow | null {
  if (!candidate) return current;
  if (current && (
    current.payment_id !== candidate.payment_id
    || (current.operation_id && candidate.operation_id && current.operation_id !== candidate.operation_id)
    || (current.attempt_id && candidate.attempt_id && current.attempt_id !== candidate.attempt_id)
  )) {
    throw new Error(`Stripe Refund ${providerRefundId} ${source} conflicts with another local link.`);
  }
  if (!current || (!current.attempt_id && candidate.attempt_id)) return candidate;
  return current;
}

async function resolveRefundLink(
  db: D1Database,
  providerRefundId: string,
  metadataOperationId: string | null,
  metadataAttemptNo: number | null,
  paymentIntent: string,
): Promise<RefundLinkRow | null> {
  const paymentRows = await db
    .prepare(
      `SELECT NULL AS attempt_id, NULL AS operation_id, NULL AS attempt_no,
              NULL AS attempt_status, NULL AS operation_status,
              NULL AS operation_attempt_count, p.request_id, p.id AS payment_id,
              NULL AS requested_amount_cents, p.amount_cents, p.currency,
              r.status AS request_status, r.ref, c.email
       FROM payments p
       JOIN ppi_requests r ON r.id = p.request_id
       JOIN customers c ON c.id = r.customer_id
       WHERE p.stripe_payment_intent = ?
       LIMIT 2`,
    )
    .bind(paymentIntent)
    .all<RefundLinkRow>();
  const paymentLinks = paymentRows.results ?? [];
  if (paymentLinks.length !== 1) {
    throw new Error(
      paymentLinks.length === 0
        ? `Stripe Refund ${providerRefundId} cannot yet be linked to its PaymentIntent; retry after Checkout reconciliation.`
        : `Stripe Refund ${providerRefundId} PaymentIntent maps to multiple local payments.`,
    );
  }
  const paymentRow = paymentLinks[0]!;

  let row = await uniqueRefundLink(
    db.prepare(
      `SELECT pr.attempt_id, pr.operation_id, a.attempt_no,
              a.outcome_status AS attempt_status,
              o.status AS operation_status, o.attempt_count AS operation_attempt_count,
              p.request_id, p.id AS payment_id, o.requested_amount_cents,
              p.amount_cents, p.currency, r.status AS request_status, r.ref, c.email
       FROM provider_refunds pr
       JOIN payments p ON p.id = pr.payment_id
       JOIN ppi_requests r ON r.id = p.request_id
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN refund_operations o ON o.id = pr.operation_id
       LEFT JOIN refund_operation_attempts a ON a.id = pr.attempt_id
       WHERE pr.provider_refund_id = ? LIMIT 2`,
    )
    .bind(providerRefundId),
    `Stripe Refund ${providerRefundId} maps to multiple provider-refund ledger rows.`,
  );
  const attemptProviderRow = await uniqueRefundLink(
    db.prepare(`${REFUND_ATTEMPT_SELECT} WHERE a.provider_refund_id = ? LIMIT 2`)
      .bind(providerRefundId),
    `Stripe Refund ${providerRefundId} maps to multiple local refund attempts.`,
  );
  row = mergeRefundLink(providerRefundId, row, attemptProviderRow, 'provider-id link');

  let metadataRow: RefundLinkRow | null = null;
  if (metadataOperationId !== null && metadataAttemptNo !== null) {
    metadataRow = await uniqueRefundLink(
      db.prepare(`${REFUND_ATTEMPT_SELECT} WHERE a.operation_id = ? AND a.attempt_no = ? LIMIT 2`)
        .bind(metadataOperationId, metadataAttemptNo),
      `Stripe Refund ${providerRefundId} metadata maps to multiple local refund attempts.`,
    );
    if (!metadataRow) {
      throw new Error(`Stripe Refund ${providerRefundId} metadata does not map to a local refund attempt.`);
    }
    row = mergeRefundLink(providerRefundId, row, metadataRow, 'metadata');
  }

  if (row && row.payment_id !== paymentRow.payment_id) {
    throw new Error(`Stripe Refund ${providerRefundId} PaymentIntent conflicts with its local refund link.`);
  }
  return row ?? paymentRow;
}

function refundFailure(
  status: StripeRefundProviderStatus,
  obj: Record<string, unknown>,
): string | null {
  return status === 'failed' || status === 'canceled' || status === 'requires_action' || status === 'unknown'
    ? String(obj['failure_reason'] ?? obj['failure_message'] ?? `provider_status:${status}`).slice(0, 240)
    : null;
}

async function refundIdHasLocalLink(db: D1Database, providerRefundId: string): Promise<boolean> {
  const providerLink = await db
    .prepare(`SELECT provider_refund_id FROM provider_refunds WHERE provider_refund_id = ? LIMIT 1`)
    .bind(providerRefundId)
    .first<{ provider_refund_id: string }>();
  if (providerLink) return true;
  const attemptLink = await db
    .prepare(`SELECT id FROM refund_operation_attempts WHERE provider_refund_id = ? LIMIT 1`)
    .bind(providerRefundId)
    .first<{ id: string }>();
  return Boolean(attemptLink);
}

async function syncRefundOperation(
  db: D1Database,
  recorded: RecordedRefund,
  confirmedByCharge: boolean,
): Promise<void> {
  const { link, ledger, failure } = recorded;
  if (!recorded.authoritative || !link.attempt_id || !link.operation_id || link.attempt_no == null) return;

  const providerOutcome = refundWebhookOutcome(ledger.status);
  const succeededOutcome = confirmedByCharge || link.attempt_status === 'confirmed'
    ? 'confirmed'
    : 'provider_accepted';
  const attemptOutcome = ledger.status === 'succeeded' ? succeededOutcome : providerOutcome;
  const operationOutcome = ledger.status === 'succeeded'
    && !confirmedByCharge
    && link.operation_status === 'confirmed'
    ? 'confirmed'
    : attemptOutcome;
  const reconciledAt = nowIso();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE refund_operation_attempts
         SET provider_refund_id = COALESCE(provider_refund_id, ?), provider_status = ?,
             outcome_status = ?, error = ?, updated_at = ?
         WHERE id = ? AND (provider_refund_id IS NULL OR provider_refund_id = ?)`,
      )
      .bind(
        ledger.provider_refund_id,
        ledger.status,
        attemptOutcome,
        failure,
        reconciledAt,
        link.attempt_id,
        ledger.provider_refund_id,
      ),
  ];
  if (link.attempt_no === link.operation_attempt_count) {
    statements.push(
      db
        .prepare(
          `UPDATE refund_operations
           SET provider_refund_id = COALESCE(provider_refund_id, ?),
               last_provider_status = ?, last_error = ?, status = ?, updated_at = ?
           WHERE id = ? AND attempt_count = ?`,
        )
        .bind(
          ledger.provider_refund_id,
          ledger.status,
          failure,
          operationOutcome,
          reconciledAt,
          link.operation_id,
          link.attempt_no,
        ),
    );
  }
  await db.batch(statements);
}

async function recordProviderRefund(
  env: Env,
  eventId: string,
  eventCreated: number,
  eventType: string,
  obj: Record<string, unknown>,
  waitUntil: WaitUntil,
  publicBase: string,
  confirmedByCharge = false,
): Promise<RecordedRefund | null> {
  const db = env.DB;
  const providerRefundId = typeof obj['id'] === 'string' ? obj['id'] : '';
  if (!/^re_[A-Za-z0-9_]+$/.test(providerRefundId) || providerRefundId.length > 255) {
    throw new Error('Stripe refund event omitted a valid Refund id.');
  }
  const metadataValue = obj['metadata'];
  const metadata = metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue)
    ? metadataValue as Record<string, unknown>
    : {};
  const hasMetadataOperationId = Object.prototype.hasOwnProperty.call(metadata, 'refund_operation_id');
  const hasMetadataAttemptNo = Object.prototype.hasOwnProperty.call(metadata, 'refund_attempt_no');
  let metadataOperationId: string | null = null;
  let metadataAttemptNo: number | null = null;
  if (hasMetadataOperationId || hasMetadataAttemptNo) {
    const rawOperationId = metadata['refund_operation_id'];
    const rawAttemptNo = Number(metadata['refund_attempt_no']);
    if (!hasMetadataOperationId
      || !hasMetadataAttemptNo
      || typeof rawOperationId !== 'string'
      || rawOperationId.length === 0
      || rawOperationId.length > 255
      || !Number.isSafeInteger(rawAttemptNo)
      || rawAttemptNo <= 0) {
      throw new Error(`Stripe Refund ${providerRefundId} contains invalid local refund metadata.`);
    }
    metadataOperationId = rawOperationId;
    metadataAttemptNo = rawAttemptNo;
  }
  const paymentIntent = typeof obj['payment_intent'] === 'string' ? obj['payment_intent'] : '';
  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntent) || paymentIntent.length > 255) {
    // A connected Stripe account can legitimately send signed Refund events
    // for payments outside this PPI system. A Refund with no PaymentIntent can
    // be acknowledged only when it carries no local metadata and its Refund id
    // has never been linked locally. Any local hint remains retryable/fail-closed.
    if (metadataOperationId === null && !(await refundIdHasLocalLink(db, providerRefundId))) {
      return null;
    }
    throw new Error(`Stripe Refund ${providerRefundId} omitted a valid PaymentIntent id.`);
  }
  const providerStatus = eventType === 'refund.failed' ? 'failed' : classifyStripeRefundStatus(obj);
  const link = await resolveRefundLink(db, providerRefundId, metadataOperationId, metadataAttemptNo, paymentIntent);
  if (!link) {
    throw new Error(`Stripe Refund ${providerRefundId} cannot be linked to a local payment.`);
  }

  const rawAmount = Number(obj['amount']);
  if (!Number.isSafeInteger(rawAmount) || rawAmount <= 0) {
    throw new Error(`Stripe Refund ${providerRefundId} omitted a valid amount.`);
  }
  const amountCents = rawAmount;
  if (link.requested_amount_cents != null && amountCents !== link.requested_amount_cents) {
    throw new Error(`Stripe Refund ${providerRefundId} amount does not match its local operation.`);
  }
  const currency = String(obj['currency'] ?? '').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency) || currency !== link.currency.toLowerCase()) {
    throw new Error(`Stripe Refund ${providerRefundId} currency does not match its local payment.`);
  }
  const rawProviderCreated = Number(obj['created']);
  if (!Number.isSafeInteger(rawProviderCreated) || rawProviderCreated < 0) {
    throw new Error(`Stripe Refund ${providerRefundId} omitted a valid created timestamp.`);
  }
  const providerCreated = rawProviderCreated;
  const failure = refundFailure(providerStatus, obj);
  const result = await upsertProviderRefund(db, {
    providerRefundId,
    paymentId: link.payment_id,
    operationId: link.operation_id,
    attemptId: link.attempt_id,
    amountCents,
    currency,
    providerCreated,
    status: providerStatus,
    eventCreated,
    eventId,
  });
  const recorded: RecordedRefund = {
    link,
    ledger: result.row,
    applied: result.applied,
    authoritative: result.authoritative,
    providerStatus,
    failure,
  };
  await syncRefundOperation(db, recorded, confirmedByCharge);

  const auditEntity = link.operation_id ? 'refund_operation' : 'payment';
  const auditEntityId = link.operation_id ?? link.payment_id;
  await db
    .prepare(
      `INSERT OR IGNORE INTO admin_audit_log
         (id, actor, action, entity, entity_id, details_json, created_at)
       VALUES (?, 'system:stripe-webhook', ?, ?, ?, ?, ?)`,
    )
    .bind(
      `al_refund_${eventId}_${providerRefundId}`,
      link.operation_id ? 'refund_provider_status' : 'refund_status_unmatched_operation',
      auditEntity,
      auditEntityId,
      JSON.stringify({
        providerRefundId,
        providerStatus: result.row.status,
        eventType,
        eventCreated,
        applied: result.applied,
        attemptNo: link.attempt_no,
      }),
      nowIso(),
    )
    .run();

  if (result.authoritative && result.row.status !== 'succeeded' && env.ADMIN_NOTIFY_EMAIL) {
    const config = await getConfig(db);
    const lifecycle = refundWebhookOutcome(result.row.status);
    const kind = lifecycle === 'pending'
      ? 'REFUND PENDING'
      : lifecycle === 'requires_action'
        ? 'REFUND REQUIRES ACTION'
        : lifecycle === 'failed' || lifecycle === 'canceled'
          ? 'REFUND FAILED — review before retrying'
          : 'REFUND RECONCILIATION REQUIRED';
    requireRecordedEmail(
      await queueTemplate(env, db, link.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
        ref: link.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind,
          detail: `${formatCents(result.row.amount_cents)} Stripe refund ${providerRefundId}: ${result.row.status}${failure ? ` (${failure})` : ''}`,
          adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(link.request_id)}`,
        },
      }, waitUntil, link.email, link.operation_id && link.attempt_no != null
        ? `owner_refund_status:${link.operation_id}:${link.attempt_no}:${result.row.status}`
        : `owner_refund_status:${providerRefundId}:${result.row.last_event_created}:${result.row.status}`),
      'owner_refund_status',
    );
  }
  return recorded;
}

async function reconcileRefundBalanceEffects(
  env: Env,
  paymentId: string,
  eventId: string,
  providerRefundId: string,
  waitUntil: WaitUntil,
  publicBase: string,
): Promise<Awaited<ReturnType<typeof recomputePaymentRefundBalance>>> {
  const db = env.DB;
  const balance = await recomputePaymentRefundBalance(db, paymentId, { eventId, providerRefundId });
  const req = await db
    .prepare(
      `SELECT r.status, r.ref, c.email
       FROM ppi_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
    )
    .bind(balance.requestId)
    .first<{ status: string; ref: string; email: string }>();
  if (!req || !isStatus(req.status)) throw new Error(`Refunded payment ${paymentId} has no valid request.`);

  const config = await getConfig(db);
  if (!balance.isFullyRefunded
    && (
      balance.wasFullyRefunded
      || balance.refundRegressionLatched
      || req.status === 'refunded'
      || req.status === 'refund_reconciliation_needed'
    )) {
    const changedAt = nowIso();
    await db.batch([
      db
        .prepare(
          `UPDATE ppi_requests SET status = 'refund_reconciliation_needed', updated_at = ?
           WHERE id = ? AND status = ? AND deleted_at IS NULL
             AND ? NOT IN ('refund_reconciliation_needed','disputed')`,
        )
        .bind(changedAt, balance.requestId, req.status, req.status),
      db
        .prepare(
          `INSERT OR IGNORE INTO status_history
             (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
           SELECT ?, ?, ?, 'refund_reconciliation_needed', 'system:stripe-webhook',
                  'Stripe changed a previously successful refund to a non-success state', ?, ?
           WHERE changes() = 1`,
        )
        .bind(`sh_refund_reconcile_${eventId}`, balance.requestId, req.status, providerRefundId, changedAt),
      db
        .prepare(
          `INSERT OR IGNORE INTO messages
             (id, request_id, direction, channel, body_text, status, created_at, dedupe_key)
           SELECT ?, ?, 'outbound', 'portal', ?, 'recorded', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM ppi_requests
             WHERE id = ? AND status IN ('refund_reconciliation_needed','disputed')
           )`,
        )
        .bind(
          `msg_refund_reconcile_${eventId}`,
          balance.requestId,
          `Stripe changed the status of a previously completed refund. The currently confirmed refunded amount is ${formatCents(balance.refundedCents)}. Your appointment remains closed and has not been restored. You do not need to pay again while AutoClarity reviews the record.`,
          changedAt,
          `portal_refund_reconcile:${paymentId}:${providerRefundId}`,
          balance.requestId,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO admin_audit_log
             (id, actor, action, entity, entity_id, details_json, created_at)
           VALUES (?, 'system:stripe-webhook', 'refund_reconciliation_needed', 'payment', ?, ?, ?)`,
        )
        .bind(
          `al_refund_reconcile_${eventId}`,
          paymentId,
          JSON.stringify({
            providerRefundId,
            previousRefundedCents: balance.previousRefundedCents,
            refundedCents: balance.refundedCents,
            capacityRestored: false,
          }),
          changedAt,
        ),
    ]);
    const safeRequest = await db
      .prepare(`SELECT status FROM ppi_requests WHERE id = ? AND deleted_at IS NULL`)
      .bind(balance.requestId)
      .first<{ status: string }>();
    if (!safeRequest || !['refund_reconciliation_needed', 'disputed'].includes(safeRequest.status)) {
      throw new Error(`Request ${balance.requestId} could not enter a safe refund-reconciliation state.`);
    }
    requireRecordedEmail(
      await queueTemplate(env, db, balance.requestId, 'refund_reconciliation_needed', req.email, {
        ref: req.ref,
        supportEmail: config.supportEmail,
        extra: { amount: formatCents(balance.refundedCents) },
      }, waitUntil, undefined, `refund_reconciliation_customer:${paymentId}:${providerRefundId}`),
      'refund_reconciliation_needed',
    );
    if (env.ADMIN_NOTIFY_EMAIL) {
      requireRecordedEmail(
        await queueTemplate(env, db, balance.requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
          ref: req.ref,
          supportEmail: config.supportEmail,
          extra: {
            kind: 'REFUND REGRESSION — reconciliation required',
            detail: `Previously full refund fell to ${formatCents(balance.refundedCents)}. Booking and capacity remain closed; review Stripe before any customer action.`,
            adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(balance.requestId)}`,
          },
        }, waitUntil, req.email, `owner_refund_reconciliation:${paymentId}:${providerRefundId}`),
        'owner_refund_reconciliation',
      );
    }
    return balance;
  }

  const disputeOpen = balance.status === 'disputed' || req.status === 'disputed';
  if (balance.isFullyRefunded && !disputeOpen) {
    const lifecycle = await applyTerminalLifecycle(db, {
      requestId: balance.requestId,
      to: 'refunded',
      actor: 'system:stripe-webhook',
      reason: 'Full refund confirmed by Stripe Refund ledger',
      relatedId: paymentId,
    });
    if (!lifecycle.ok) {
      throw new Error(`Request ${balance.requestId} could not reconcile to refunded from ${req.status}.`);
    }
    requireRecordedEmail(
      await queueTemplate(env, db, balance.requestId, 'refund_issued', req.email, {
        ref: req.ref,
        supportEmail: config.supportEmail,
        extra: { amount: formatCents(balance.refundedCents) },
      }, waitUntil, undefined, `refund_issued:${paymentId}:${balance.refundedCents}`),
      'refund_issued',
    );
  }
  if (env.ADMIN_NOTIFY_EMAIL && balance.refundedCents > 0) {
    requireRecordedEmail(
      await queueTemplate(env, db, balance.requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
        ref: req.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind: disputeOpen
            ? 'REFUND BALANCE UPDATED DURING DISPUTE'
            : balance.isFullyRefunded
              ? 'FULL REFUND CONFIRMED'
              : 'REFUND BALANCE UPDATED',
          detail: `${formatCents(balance.refundedCents)} currently succeeded in Stripe's Refund ledger`,
          adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(balance.requestId)}`,
        },
      }, waitUntil, req.email, disputeOpen
        ? `owner_refund_disputed:${paymentId}:${balance.refundedCents}`
        : `owner_refund:${paymentId}:${balance.refundedCents}`),
      'owner_refund',
    );
  }
  return balance;
}

async function handleRefundStatusEvent(
  env: Env,
  eventId: string,
  eventCreated: number,
  eventType: string,
  obj: Record<string, unknown>,
  waitUntil: WaitUntil,
  publicBase: string,
): Promise<void> {
  const recorded = await recordProviderRefund(
    env,
    eventId,
    eventCreated,
    eventType,
    obj,
    waitUntil,
    publicBase,
  );
  if (!recorded || !recorded.authoritative) return;
  await reconcileRefundBalanceEffects(
    env,
    recorded.link.payment_id,
    eventId,
    recorded.ledger.provider_refund_id,
    waitUntil,
    publicBase,
  );
}

async function handleChargeRefunded(
  env: Env,
  eventId: string,
  eventCreated: number,
  obj: Record<string, unknown>,
  waitUntil: WaitUntil,
  publicBase: string,
): Promise<void> {
  const db = env.DB;
  const paymentIntent = String(obj['payment_intent'] ?? '');
  const paymentMatches = await db
    .prepare(`SELECT id, request_id, amount_cents, currency FROM payments WHERE stripe_payment_intent = ? LIMIT 2`)
    .bind(paymentIntent)
    .all<{ id: string; request_id: string; amount_cents: number; currency: string }>();
  const payments = paymentMatches.results ?? [];
  if (payments.length > 1) {
    throw new Error(`Stripe charge.refunded ${eventId} PaymentIntent maps to multiple local payments.`);
  }
  const payment = payments[0];
  if (!payment) return;
  const rawReported = Number(obj['amount_refunded']);
  if (!Boolean(obj['refunded'])
    && (!Number.isSafeInteger(rawReported) || rawReported < 0 || rawReported > payment.amount_cents)) {
    throw new Error(`Stripe charge.refunded ${eventId} reported an invalid cumulative amount.`);
  }
  const reportedCents = Boolean(obj['refunded'])
    ? payment.amount_cents
    : rawReported;
  let lastProviderRefundId = `charge:${eventId}`;

  const refundsValue = obj['refunds'];
  const refundData = refundsValue && typeof refundsValue === 'object' && !Array.isArray(refundsValue)
    && Array.isArray((refundsValue as { data?: unknown }).data)
    ? (refundsValue as { data: unknown[] }).data
    : [];
  for (const value of refundData) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const refund = value as Record<string, unknown>;
    const providerRefundId = String(refund['id'] ?? '');
    if (!/^re_[A-Za-z0-9_]+$/.test(providerRefundId)) continue;
    lastProviderRefundId = providerRefundId;
    await recordProviderRefund(
      env,
      eventId,
      eventCreated,
      'charge.refunded',
      { payment_intent: paymentIntent, currency: payment.currency, ...refund },
      waitUntil,
      publicBase,
      classifyStripeRefundStatus(refund) === 'succeeded',
    );
  }

  // A compact Charge contains only a cumulative amount, not enough identity
  // to assign success to any particular Refund. It remains a cross-check;
  // only actual Refund objects above can mutate the per-refund ledger.
  const balance = await reconcileRefundBalanceEffects(
    env,
    payment.id,
    eventId,
    lastProviderRefundId,
    waitUntil,
    publicBase,
  );
  if (balance.refundedCents !== reportedCents) {
    const req = await db
      .prepare(
        `SELECT r.ref, c.email FROM ppi_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
      )
      .bind(payment.request_id)
      .first<{ ref: string; email: string }>();
    await db
      .prepare(
        `INSERT OR IGNORE INTO admin_audit_log
           (id, actor, action, entity, entity_id, details_json, created_at)
         VALUES (?, 'system:stripe-webhook', 'charge_refund_balance_mismatch', 'payment', ?, ?, ?)`,
      )
      .bind(
        `al_charge_refund_mismatch_${eventId}`,
        payment.id,
        JSON.stringify({ reportedCents, ledgerCents: balance.refundedCents, eventCreated }),
        nowIso(),
      )
      .run();
    if (req && env.ADMIN_NOTIFY_EMAIL) {
      const config = await getConfig(db);
      requireRecordedEmail(
        await queueTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
          ref: req.ref,
          supportEmail: config.supportEmail,
          extra: {
            kind: 'STRIPE REFUND BALANCE MISMATCH — review required',
            detail: `Charge reports ${formatCents(reportedCents)} refunded; identified Refund objects total ${formatCents(balance.refundedCents)}. The older charge event did not override newer Refund states.`,
            adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(payment.request_id)}`,
          },
        }, waitUntil, req.email, `owner_charge_refund_mismatch:${eventId}`),
        'owner_charge_refund_mismatch',
      );
    }
  }
}

interface CheckoutPaymentRow {
  id: string;
  request_id: string;
  quote_id: string;
  booking_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  stripe_payment_intent: string | null;
  quote_request_id: string;
  quote_status: string;
  quote_total_cents: number;
  quote_currency: string;
  quote_subtotal_cents: number;
  quote_travel_cents: number;
  quote_addons_cents: number;
  quote_discount_cents: number;
  quote_base_line_cents: number;
  quote_travel_line_cents: number;
  quote_addon_line_cents: number;
  quote_discount_line_cents: number;
  quote_line_total_cents: number;
  quote_invalid_line_count: number;
}

interface CheckoutBookingRow {
  id: string;
  request_id: string;
  quote_id: string;
  slot_id: string | null;
  status: string;
}

interface ValidatedCheckoutSession {
  paymentIntent: string;
  payment: CheckoutPaymentRow;
  booking: CheckoutBookingRow;
}

const POST_PAYMENT_TERMINAL_STATUSES = new Set(['partially_refunded', 'refunded', 'disputed']);

async function validateCheckoutSessionIdentity(
  env: Env,
  obj: Record<string, unknown>,
  expectedPaymentStatus: 'paid' | 'unpaid',
): Promise<ValidatedCheckoutSession> {
  const sessionId = typeof obj['id'] === 'string' ? obj['id'] : '';
  const paymentIntent = typeof obj['payment_intent'] === 'string' ? obj['payment_intent'] : '';
  const paymentStatus = typeof obj['payment_status'] === 'string' ? obj['payment_status'] : '';
  const amountTotal = obj['amount_total'];
  const currency = typeof obj['currency'] === 'string' ? obj['currency'] : '';
  const clientReferenceId = typeof obj['client_reference_id'] === 'string' ? obj['client_reference_id'] : '';
  const metadataValue = obj['metadata'];
  const metadata = metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue)
    ? metadataValue as Record<string, unknown>
    : null;
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255) {
    throw new Error('Stripe event omitted a valid Checkout Session id.');
  }
  if (paymentStatus !== expectedPaymentStatus) {
    throw new Error(`Stripe Checkout Session ${sessionId} has unexpected payment status ${paymentStatus || '(missing)'}.`);
  }
  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntent) || paymentIntent.length > 255) {
    throw new Error(`Stripe Checkout Session ${sessionId} omitted a valid PaymentIntent id.`);
  }
  if (!Number.isSafeInteger(amountTotal) || Number(amountTotal) <= 0) {
    throw new Error(`Stripe Checkout Session ${sessionId} omitted a valid amount_total.`);
  }
  if (!currency || !clientReferenceId || !metadata) {
    throw new Error(`Stripe Checkout Session ${sessionId} omitted required commerce identity fields.`);
  }

  const db = env.DB;

  const payment = await db
    .prepare(
      `SELECT p.id, p.request_id, p.quote_id, p.booking_id, p.amount_cents, p.currency,
              p.status, p.stripe_payment_intent,
              q.request_id AS quote_request_id, q.status AS quote_status,
              q.total_cents AS quote_total_cents, q.currency AS quote_currency,
              q.subtotal_cents AS quote_subtotal_cents,
              q.travel_cents AS quote_travel_cents,
              q.addons_cents AS quote_addons_cents,
              q.discount_cents AS quote_discount_cents,
              COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'base'), 0) AS quote_base_line_cents,
              COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'travel'), 0) AS quote_travel_line_cents,
              COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'addon'), 0) AS quote_addon_line_cents,
              COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'discount'), 0) AS quote_discount_line_cents,
              COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id), 0) AS quote_line_total_cents,
              (SELECT COUNT(*) FROM quote_line_items li
               WHERE li.quote_id = q.id
                 AND ((li.kind IN ('base','travel','addon') AND li.amount_cents <= 0)
                   OR (li.kind = 'discount' AND li.amount_cents >= 0))) AS quote_invalid_line_count
       FROM payments p
       JOIN quotes q ON q.id = p.quote_id
       WHERE p.stripe_session_id = ?`,
    )
    .bind(sessionId)
    .first<CheckoutPaymentRow>();
  if (!payment) throw new Error(`Unknown Stripe Checkout Session ${sessionId.slice(0, 48)}.`);
  if (!payment.booking_id) throw new Error(`Payment ${payment.id} has no booking.`);

  const booking = await db
    .prepare(`SELECT id, request_id, quote_id, slot_id, status FROM bookings WHERE id = ?`)
    .bind(payment.booking_id)
    .first<CheckoutBookingRow>();
  const harmlessHistoricalFailureAfterRequote = expectedPaymentStatus === 'unpaid'
    && (payment.status === 'failed' || payment.status === 'expired')
    && payment.quote_status === 'superseded'
    && booking?.request_id === payment.request_id
    && booking.quote_id !== payment.quote_id;
  if (
    !Number.isSafeInteger(payment.amount_cents)
    || payment.amount_cents <= 0
    || amountTotal !== payment.amount_cents
    || payment.currency !== STRIPE_CHECKOUT_CURRENCY
    || currency !== STRIPE_CHECKOUT_CURRENCY
    || payment.quote_request_id !== payment.request_id
    || (!['sent', 'accepted'].includes(payment.quote_status) && !harmlessHistoricalFailureAfterRequote)
    || !Number.isSafeInteger(payment.quote_total_cents)
    || payment.quote_total_cents <= 0
    || payment.quote_currency !== STRIPE_CHECKOUT_CURRENCY
    || payment.quote_total_cents !== payment.amount_cents
    || !Number.isSafeInteger(payment.quote_subtotal_cents)
    || !Number.isSafeInteger(payment.quote_travel_cents)
    || !Number.isSafeInteger(payment.quote_addons_cents)
    || !Number.isSafeInteger(payment.quote_discount_cents)
    || !Number.isSafeInteger(payment.quote_base_line_cents)
    || !Number.isSafeInteger(payment.quote_travel_line_cents)
    || !Number.isSafeInteger(payment.quote_addon_line_cents)
    || !Number.isSafeInteger(payment.quote_discount_line_cents)
    || !Number.isSafeInteger(payment.quote_line_total_cents)
    || payment.quote_subtotal_cents <= 0
    || payment.quote_travel_cents < 0
    || payment.quote_addons_cents < 0
    || payment.quote_discount_cents < 0
    || payment.quote_total_cents !== payment.quote_subtotal_cents
      + payment.quote_travel_cents + payment.quote_addons_cents - payment.quote_discount_cents
    || payment.quote_base_line_cents !== payment.quote_subtotal_cents
    || payment.quote_travel_line_cents !== payment.quote_travel_cents
    || payment.quote_addon_line_cents !== payment.quote_addons_cents
    || payment.quote_discount_line_cents !== -payment.quote_discount_cents
    || payment.quote_line_total_cents !== payment.quote_total_cents
    || payment.quote_invalid_line_count !== 0
    || clientReferenceId !== payment.booking_id
    || metadata['request_id'] !== payment.request_id
    || metadata['quote_id'] !== payment.quote_id
    || metadata['booking_id'] !== payment.booking_id
    || (payment.stripe_payment_intent !== null && payment.stripe_payment_intent !== paymentIntent)
  ) {
    throw new Error(`Stripe Checkout Session ${sessionId} does not match its stored payment identity.`);
  }

  if (!booking
    || booking.request_id !== payment.request_id
    || (booking.quote_id !== payment.quote_id && !harmlessHistoricalFailureAfterRequote)) {
    throw new Error(`Payment ${payment.id} does not match its stored booking identity.`);
  }

  return { paymentIntent, payment, booking };
}

async function handlePaymentFailed(env: Env, obj: Record<string, unknown>): Promise<void> {
  const { payment } = await validateCheckoutSessionIdentity(env, obj, 'unpaid');
  if (payment.status === 'succeeded'
    || payment.status === 'failed'
    || payment.status === 'expired'
    || POST_PAYMENT_TERMINAL_STATUSES.has(payment.status)) return;
  await env.DB
    .prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('created','pending')`)
    .bind(nowIso(), payment.id)
    .run();
}

async function handlePaymentSucceeded(
  env: Env,
  obj: Record<string, unknown>,
  waitUntil: WaitUntil,
  publicBase: string,
): Promise<void> {
  const { paymentIntent, payment, booking } = await validateCheckoutSessionIdentity(env, obj, 'paid');
  const db = env.DB;
  const now = nowIso();

  // A success event that arrives after refund/dispute reconciliation is valid
  // historical evidence, but must never regress payment state or reopen the
  // request, booking, or slot.
  if (POST_PAYMENT_TERMINAL_STATUSES.has(payment.status)) return;

  if (payment.status !== 'succeeded') {
    const updated = await db
      .prepare(
        `UPDATE payments SET status = 'succeeded', stripe_payment_intent = ?, updated_at = ?
         WHERE id = ? AND status IN ('created','pending','failed','expired')`,
      )
      .bind(paymentIntent, now, payment.id)
      .run();
    if ((updated.meta?.changes ?? 0) !== 1) {
      const current = await db
        .prepare(`SELECT status FROM payments WHERE id = ?`)
        .bind(payment.id)
        .first<{ status: string }>();
      if (current && POST_PAYMENT_TERMINAL_STATUSES.has(current.status)) return;
      throw new Error(`Payment ${payment.id} could not transition from ${payment.status} to succeeded.`);
    }
  } else if (paymentIntent) {
    await db
      .prepare(`UPDATE payments SET stripe_payment_intent = COALESCE(stripe_payment_intent, ?), updated_at = ? WHERE id = ?`)
      .bind(paymentIntent, now, payment.id)
      .run();
  }

  const requestRow = await db
    .prepare(`SELECT r.status, r.ref, c.email FROM ppi_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`)
    .bind(payment.request_id)
    .first<{ status: string; ref: string; email: string }>();
  if (!requestRow) throw new Error(`Payment ${payment.id} has no request.`);

  // A favorable dispute outcome or a failed full-refund reconciliation may
  // restore the payment's economic status to succeeded, but the request
  // lifecycle deliberately remains closed. A late Checkout snapshot is valid
  // historical evidence only: it must not create a new portal link, send
  // paid-lapsed notices, or touch booking/capacity state.
  if (requestRow.status === 'disputed' || requestRow.status === 'refund_reconciliation_needed') return;

  const slot = booking.slot_id
    ? await db
        .prepare(`SELECT id, status, starts_at, hold_expires_at FROM appointment_slots WHERE id = ?`)
        .bind(booking.slot_id)
        .first<{ id: string; status: string; starts_at: string; hold_expires_at: string | null }>()
    : null;

  const candidateNotificationKeys = [
    `payment_received:${payment.id}`,
    `payment_slot_lapsed:${payment.id}`,
    `appointment_confirmed:${payment.id}`,
    ...(env.ADMIN_NOTIFY_EMAIL ? [`owner_booking_confirmed:${payment.id}`] : []),
  ];
  const notificationPlaceholders = candidateNotificationKeys.map(() => '?').join(',');
  const notificationRows = await db
    .prepare(`SELECT dedupe_key FROM messages WHERE dedupe_key IN (${notificationPlaceholders})`)
    .bind(...candidateNotificationKeys)
    .all<{ dedupe_key: string }>();
  const recordedNotificationKeys = new Set((notificationRows.results ?? []).map((row) => row.dedupe_key));
  const paymentNoticeRecorded = recordedNotificationKeys.has(`payment_received:${payment.id}`)
    || recordedNotificationKeys.has(`payment_slot_lapsed:${payment.id}`);
  const notificationsRecorded = paymentNoticeRecorded
    && recordedNotificationKeys.has(`appointment_confirmed:${payment.id}`)
    && (!env.ADMIN_NOTIFY_EMAIL || recordedNotificationKeys.has(`owner_booking_confirmed:${payment.id}`));

  // A second success event for an already complete reconciliation is harmless.
  // Message dedupe rows are part of "complete" so a retry can repair a crash
  // after state confirmation but before notification recording.
  if (
    payment.status === 'succeeded' &&
    requestRow.status === 'confirmed' &&
    booking.status === 'confirmed' &&
    slot?.status === 'confirmed' &&
    notificationsRecorded
  ) {
    return;
  }

  let slotConfirmed = slot?.status === 'confirmed';
  if (slot && !slotConfirmed && slot.status === 'held' && slot.hold_expires_at && slot.hold_expires_at >= now) {
    const slotUpdate = await db
      .prepare(
        `UPDATE appointment_slots SET status = 'confirmed', hold_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'held' AND hold_expires_at >= ?`,
      )
      .bind(now, slot.id, now)
      .run();
    slotConfirmed = (slotUpdate.meta?.changes ?? 0) === 1;
  }

  await db.prepare(`UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?`).bind(now, payment.quote_id).run();
  const config = await getConfig(db);

  if (slotConfirmed && slot) {
    await db
      .prepare(`UPDATE bookings SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), updated_at = ? WHERE id = ?`)
      .bind(now, now, booking.id)
      .run();
    await db
      .prepare(`UPDATE appointment_slots SET status = 'released', updated_at = ? WHERE request_id = ? AND id != ? AND status IN ('offered','held')`)
      .bind(now, payment.request_id, slot.id)
      .run();
    if (isStatus(requestRow.status) && requestRow.status === 'awaiting_payment') {
      await applyStatus(db, payment.request_id, 'awaiting_payment', 'confirmed', 'system:stripe-webhook', 'Payment succeeded — booking confirmed', payment.id);
    }

    let securePortalUrl: string | undefined;
    if (!recordedNotificationKeys.has(`appointment_confirmed:${payment.id}`)) {
      try {
        const magic = await issueMagicLink(db, payment.request_id, config, false);
        securePortalUrl = portalUrl(publicBase, magic.token);
      } catch (e) {
        // The confirmation template has accurate support copy when a secure
        // link cannot be created; it never exposes a bare unauthenticated URL.
        console.error('confirmation_magic_link_failed', payment.request_id, String(e).slice(0, 240));
      }
    }
    requireRecordedEmail(
      await queueTemplate(env, db, payment.request_id, 'payment_received', requestRow.email, {
        ref: requestRow.ref,
        supportEmail: config.supportEmail,
        extra: { amount: formatCents(payment.amount_cents) },
      }, waitUntil, undefined, `payment_received:${payment.id}`),
      'payment_received',
    );
    requireRecordedEmail(
      await queueTemplate(env, db, payment.request_id, 'appointment_confirmed', requestRow.email, {
        ref: requestRow.ref,
        portalUrl: securePortalUrl,
        supportEmail: config.supportEmail,
        extra: { slot: fmtSlot(slot.starts_at, config.scheduling.timezone) },
      }, waitUntil, undefined, `appointment_confirmed:${payment.id}`),
      'appointment_confirmed',
    );
    if (env.ADMIN_NOTIFY_EMAIL) {
      requireRecordedEmail(
        await queueTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
          ref: requestRow.ref,
          supportEmail: config.supportEmail,
          extra: {
            kind: 'BOOKING CONFIRMED',
            detail: `${formatCents(payment.amount_cents)} paid — ${fmtSlot(slot.starts_at, config.scheduling.timezone)}`,
            adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(payment.request_id)}`,
          },
        }, waitUntil, requestRow.email, `owner_booking_confirmed:${payment.id}`),
        'owner_booking_confirmed',
      );
    }
    return;
  }

  // Paid but the held time was lost. Return the booking to a selectable state;
  // the deterministic portal row and email dedupe keys make every retry safe.
  await db.batch([
    ...(slot
      ? [
          db
            .prepare(
              `UPDATE appointment_slots SET status = 'offered', hold_expires_at = NULL, updated_at = ?
               WHERE id = ? AND request_id = ? AND status = 'held'`,
            )
            .bind(now, slot.id, payment.request_id),
        ]
      : []),
    db
      .prepare(
        `UPDATE bookings SET slot_id = NULL, status = 'pending_payment', updated_at = ?
         WHERE id = ? AND status = 'pending_payment'`,
      )
      .bind(now, booking.id),
  ]);
  if (isStatus(requestRow.status) && requestRow.status === 'awaiting_payment') {
    await applyStatus(db, payment.request_id, 'awaiting_payment', 'awaiting_time_selection', 'system:stripe-webhook', 'Payment succeeded but held time lapsed — rescheduling needed', payment.id);
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO messages (id, request_id, direction, channel, body_text, status, created_at)
       VALUES (?, ?, 'outbound', 'portal', ?, 'recorded', ?)`,
    )
    .bind(
      `msg_slot_lapsed_${payment.id}`,
      payment.request_id,
      `Your payment was received, but the temporary appointment hold had ended, so no time was booked. Pick another available time on this page; you will not be charged again for this request. If no times work, contact ${config.supportEmail}.`,
      now,
    )
    .run();

  let reselectionUrl: string | undefined;
  if (!recordedNotificationKeys.has(`payment_slot_lapsed:${payment.id}`)) {
    try {
      const magic = await issueMagicLink(db, payment.request_id, config, false);
      reselectionUrl = portalUrl(publicBase, magic.token);
    } catch (e) {
      console.error('slot_lapsed_magic_link_failed', payment.request_id, String(e).slice(0, 240));
    }
  }
  requireRecordedEmail(
    await queueTemplate(env, db, payment.request_id, 'payment_slot_lapsed', requestRow.email, {
      ref: requestRow.ref,
      portalUrl: reselectionUrl,
      supportEmail: config.supportEmail,
      extra: { amount: formatCents(payment.amount_cents) },
    }, waitUntil, undefined, `payment_slot_lapsed:${payment.id}`),
    'payment_slot_lapsed',
  );
  if (env.ADMIN_NOTIFY_EMAIL) {
    requireRecordedEmail(
      await queueTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
        ref: requestRow.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind: 'PAID BUT SLOT LAPSED — action needed',
          detail: `Payment ${formatCents(payment.amount_cents)} succeeded after the hold expired. The customer can choose another offered time without paying again.`,
          adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(payment.request_id)}`,
        },
      }, waitUntil, requestRow.email, `owner_slot_lapsed:${payment.id}`),
      'owner_slot_lapsed',
    );
  }
}
