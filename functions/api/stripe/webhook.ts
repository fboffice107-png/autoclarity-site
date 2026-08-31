// POST /api/stripe/webhook — the ONLY authority on payment state.
// Signature-verified, replay-proof (event ids recorded), idempotent handlers.
// Confirming a booking happens HERE, never on the browser success redirect.

import type { Env } from '../../lib/types.ts';
import {
  classifyStripeRefundStatus,
  verifyStripeSignature,
  claimStripeEvent,
  markStripeEventProcessed,
  type StripeRefundProviderStatus,
} from '../../lib/stripe.ts';
import { applyStatus, isStatus, type Status } from '../../lib/status.ts';
import { getConfig } from '../../lib/config.ts';
import { queueTemplate, requireRecordedEmail } from '../../lib/email.ts';
import { issueMagicLink, portalUrl } from '../../lib/magic.ts';
import { applyTerminalLifecycle } from '../../lib/lifecycle.ts';
import { errorJson, formatCents, json, nowIso, sha256Hex } from '../../lib/util.ts';

interface StripeEvent {
  id: string;
  type: string;
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

/** Preserve definitive/confirmed states when Stripe delivers stale updates. */
export function reconcileRefundLifecycle(
  current: RefundLifecycleStatus,
  incoming: RefundLifecycleStatus,
): RefundLifecycleStatus {
  if (current === 'confirmed') return 'confirmed';
  if (current === 'provider_accepted') return 'provider_accepted';
  if (current === 'failed' || current === 'canceled') return current;
  return incoming;
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
  if (!event.id || !event.type) return errorJson('bad_event', 'Malformed event.', 400);

  const owns = await claimStripeEvent(db, event.id, event.type, await sha256Hex(payload));
  if (!owns) return json({ received: true, replay: true });

  const obj = event.data?.object ?? {};
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const sessionId = String(obj['id'] ?? '');
        const paymentStatus = String(obj['payment_status'] ?? '');
        if (event.type === 'checkout.session.completed' && paymentStatus !== 'paid') {
          break; // delayed method — wait for async_payment_succeeded
        }
        await handlePaymentSucceeded(env, sessionId, String(obj['payment_intent'] ?? ''), waitUntil, publicBase);
        break;
      }
      case 'checkout.session.async_payment_failed': {
        await db
          .prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE stripe_session_id = ? AND status IN ('created','pending')`)
          .bind(nowIso(), String(obj['id'] ?? ''))
          .run();
        break;
      }
      case 'checkout.session.expired': {
        await db
          .prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE stripe_session_id = ? AND status IN ('created','pending')`)
          .bind(nowIso(), String(obj['id'] ?? ''))
          .run();
        break;
      }
      case 'refund.updated':
      case 'refund.failed': {
        await handleRefundStatusEvent(env, event.id, event.type, obj, waitUntil, publicBase);
        break;
      }
      case 'charge.refunded': {
        const paymentIntent = String(obj['payment_intent'] ?? '');
        const refundedCents = Number(obj['amount_refunded'] ?? 0);
        const fully = Boolean(obj['refunded']);
        const payment = await db
          .prepare(`SELECT id, request_id, amount_cents, refunded_cents, status FROM payments WHERE stripe_payment_intent = ?`)
          .bind(paymentIntent)
          .first<{ id: string; request_id: string; amount_cents: number; refunded_cents: number; status: string }>();
        if (!payment) break;
        const reportedCents = fully
          ? payment.amount_cents
          : Math.min(payment.amount_cents, Math.max(0, Number.isFinite(refundedCents) ? Math.trunc(refundedCents) : 0));
        await db
          .prepare(
            `UPDATE payments
             SET refunded_cents = MAX(refunded_cents, ?),
                 status = CASE
                   WHEN MAX(refunded_cents, ?) >= amount_cents THEN 'refunded'
                   WHEN status IN ('refunded','disputed') THEN status
                   WHEN MAX(refunded_cents, ?) > 0 THEN 'partially_refunded'
                   ELSE status
                 END,
                 updated_at = ?
             WHERE id = ?`,
          )
          .bind(reportedCents, reportedCents, reportedCents, nowIso(), payment.id)
          .run();
        const persisted = await db
          .prepare(`SELECT refunded_cents, status FROM payments WHERE id = ?`)
          .bind(payment.id)
          .first<{ refunded_cents: number; status: string }>();
        if (!persisted) throw new Error(`Refunded payment ${payment.id} disappeared during reconciliation.`);
        const refundConfirmedAt = nowIso();
        await db.batch([
          db
            .prepare(
              `UPDATE refund_operations SET status = 'confirmed', last_provider_status = 'succeeded', updated_at = ?
               WHERE payment_id = ? AND status != 'confirmed'
                 AND starting_refunded_cents + requested_amount_cents <= ?`,
            )
            .bind(refundConfirmedAt, payment.id, persisted.refunded_cents),
          db
            .prepare(
              `UPDATE refund_operation_attempts
               SET outcome_status = 'confirmed', provider_status = COALESCE(provider_status, 'succeeded'), updated_at = ?
               WHERE outcome_status != 'confirmed'
                 AND EXISTS (
                   SELECT 1 FROM refund_operations o
                   WHERE o.id = refund_operation_attempts.operation_id
                     AND o.payment_id = ? AND o.status = 'confirmed'
                     AND o.attempt_count = refund_operation_attempts.attempt_no
                 )`,
            )
            .bind(refundConfirmedAt, payment.id),
        ]);

        const req = await db
          .prepare(
            `SELECT r.status, r.ref, c.email
             FROM ppi_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
          )
            .bind(payment.request_id)
            .first<{ status: string; ref: string; email: string }>();
        if (!req || !isStatus(req.status)) throw new Error(`Refunded payment ${payment.id} has no valid request.`);
        const isFullyRefunded = persisted.status === 'refunded' || persisted.refunded_cents >= payment.amount_cents;
        if (isFullyRefunded) {
          const lifecycle = await applyTerminalLifecycle(db, {
            requestId: payment.request_id,
            to: 'refunded',
            actor: 'system:stripe-webhook',
            reason: 'Full refund confirmed by Stripe',
            relatedId: payment.id,
          });
          if (!lifecycle.ok) {
            throw new Error(`Request ${payment.request_id} could not reconcile to refunded from ${req.status}.`);
          }
          const config = await getConfig(db);
          requireRecordedEmail(
            await queueTemplate(env, db, payment.request_id, 'refund_issued', req.email, {
              ref: req.ref,
              supportEmail: config.supportEmail,
              extra: { amount: formatCents(persisted.refunded_cents) },
            }, waitUntil, undefined, `refund_issued:${payment.id}:${persisted.refunded_cents}`),
            'refund_issued',
          );
        }
        if (env.ADMIN_NOTIFY_EMAIL) {
          const config = await getConfig(db);
          requireRecordedEmail(
            await queueTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
              ref: req.ref,
              supportEmail: config.supportEmail,
              extra: {
                kind: isFullyRefunded ? 'FULL REFUND CONFIRMED' : 'PARTIAL REFUND CONFIRMED',
                detail: `${formatCents(persisted.refunded_cents)} cumulative refund recorded by Stripe`,
                adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(payment.request_id)}`,
              },
            }, waitUntil, req.email, `owner_refund:${payment.id}:${persisted.refunded_cents}`),
            'owner_refund',
          );
        }
        break;
      }
      case 'charge.dispute.created': {
        const paymentIntent = String(obj['payment_intent'] ?? '');
        const payment = await db
          .prepare(`SELECT id, request_id, amount_cents FROM payments WHERE stripe_payment_intent = ?`)
          .bind(paymentIntent)
          .first<{ id: string; request_id: string; amount_cents: number }>();
        if (!payment) break;
        await db.prepare(`UPDATE payments SET status = 'disputed', updated_at = ? WHERE id = ?`).bind(nowIso(), payment.id).run();
        const req = await db
          .prepare(
            `SELECT r.status, r.ref, c.email
             FROM ppi_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
          )
          .bind(payment.request_id)
          .first<{ status: string; ref: string; email: string }>();
        if (!req || !isStatus(req.status)) throw new Error(`Disputed payment ${payment.id} has no valid request.`);
        const lifecycle = await applyTerminalLifecycle(db, {
          requestId: payment.request_id,
          to: 'disputed',
          actor: 'system:stripe-webhook',
          reason: 'Stripe dispute opened',
          relatedId: payment.id,
        });
        if (!lifecycle.ok) {
          throw new Error(`Request ${payment.request_id} could not reconcile to disputed from ${req.status}.`);
        }
        if (env.ADMIN_NOTIFY_EMAIL) {
          const config = await getConfig(db);
          requireRecordedEmail(
            await queueTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
              ref: req.ref,
              supportEmail: config.supportEmail,
              extra: {
                kind: 'PAYMENT DISPUTE OPENED',
                detail: `${formatCents(payment.amount_cents)} payment disputed; booking access was disabled`,
                adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(payment.request_id)}`,
              },
            }, waitUntil, req.email, `owner_dispute:${payment.id}`),
            'owner_dispute',
          );
        }
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

interface RefundEventRow {
  attempt_id: string;
  operation_id: string;
  attempt_no: number;
  attempt_status: RefundLifecycleStatus;
  attempt_error: string | null;
  attempt_provider_status: string | null;
  provider_refund_id: string | null;
  operation_status: RefundLifecycleStatus;
  operation_error: string | null;
  operation_provider_status: string | null;
  operation_attempt_count: number;
  request_id: string;
  payment_id: string;
  requested_amount_cents: number;
  ref: string;
  email: string;
}

async function handleRefundStatusEvent(
  env: Env,
  eventId: string,
  eventType: string,
  obj: Record<string, unknown>,
  waitUntil: WaitUntil,
  publicBase: string,
): Promise<void> {
  const db = env.DB;
  const providerRefundId = typeof obj['id'] === 'string' ? obj['id'] : '';
  if (!/^re_[A-Za-z0-9_]+$/.test(providerRefundId) || providerRefundId.length > 255) {
    throw new Error('Stripe refund status event omitted a valid Refund id.');
  }

  const metadataValue = obj['metadata'];
  const metadata = metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue)
    ? metadataValue as Record<string, unknown>
    : {};
  const metadataOperationId = String(metadata['refund_operation_id'] ?? '').slice(0, 80);
  const metadataAttemptNo = Number(metadata['refund_attempt_no'] ?? 0);

  const selectAttempt = `
    SELECT a.id AS attempt_id, a.operation_id, a.attempt_no,
           a.outcome_status AS attempt_status, a.error AS attempt_error,
           a.provider_status AS attempt_provider_status, a.provider_refund_id,
           o.status AS operation_status, o.last_error AS operation_error,
           o.last_provider_status AS operation_provider_status,
           o.attempt_count AS operation_attempt_count,
           o.request_id, o.payment_id, o.requested_amount_cents,
           r.ref, c.email
    FROM refund_operation_attempts a
    JOIN refund_operations o ON o.id = a.operation_id
    JOIN ppi_requests r ON r.id = o.request_id
    JOIN customers c ON c.id = r.customer_id`;

  let row = await db
    .prepare(`${selectAttempt} WHERE a.provider_refund_id = ? LIMIT 1`)
    .bind(providerRefundId)
    .first<RefundEventRow>();
  if (!row && metadataOperationId && Number.isInteger(metadataAttemptNo) && metadataAttemptNo > 0) {
    row = await db
      .prepare(`${selectAttempt} WHERE a.operation_id = ? AND a.attempt_no = ? LIMIT 1`)
      .bind(metadataOperationId, metadataAttemptNo)
      .first<RefundEventRow>();
  }

  const providerStatus = eventType === 'refund.failed' ? 'failed' : classifyStripeRefundStatus(obj);
  const incoming = refundWebhookOutcome(providerStatus);
  const failure = incoming === 'failed' || incoming === 'canceled' || incoming === 'requires_action' || incoming === 'reconciliation_required'
    ? String(obj['failure_reason'] ?? obj['failure_message'] ?? `provider_status:${providerStatus}`).slice(0, 240)
    : null;

  // A refund created outside this app has no local operation claim. It must not
  // mutate an unrelated operation, but a matched payment still gets a durable
  // owner alert so the provider-side action is visible.
  if (!row) {
    const paymentIntent = String(obj['payment_intent'] ?? '');
    const unmatched = paymentIntent
      ? await db
          .prepare(
            `SELECT p.id AS payment_id, p.request_id, p.amount_cents, r.ref, c.email
             FROM payments p
             JOIN ppi_requests r ON r.id = p.request_id
             JOIN customers c ON c.id = r.customer_id
             WHERE p.stripe_payment_intent = ? LIMIT 1`,
          )
          .bind(paymentIntent)
          .first<{ payment_id: string; request_id: string; amount_cents: number; ref: string; email: string }>()
      : null;
    if (!unmatched) {
      console.warn('stripe_refund_status_unmatched', eventId, providerRefundId, providerStatus);
      return;
    }

    await db
      .prepare(
        `INSERT OR IGNORE INTO admin_audit_log
           (id, actor, action, entity, entity_id, details_json, created_at)
         VALUES (?, 'system:stripe-webhook', 'refund_status_unmatched', 'payment', ?, ?, ?)`,
      )
      .bind(
        `al_refund_${eventId}`,
        unmatched.payment_id,
        JSON.stringify({ providerRefundId, providerStatus, eventType }),
        nowIso(),
      )
      .run();
    if (env.ADMIN_NOTIFY_EMAIL) {
      const config = await getConfig(db);
      requireRecordedEmail(
        await queueTemplate(env, db, unmatched.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
          ref: unmatched.ref,
          supportEmail: config.supportEmail,
          extra: {
            kind: 'UNMATCHED STRIPE REFUND STATUS — review required',
            detail: `${formatCents(unmatched.amount_cents)} payment has provider refund status ${providerStatus}; no local refund operation matched`,
            adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(unmatched.request_id)}`,
          },
        }, waitUntil, unmatched.email, `owner_refund_unmatched:${providerRefundId}:${providerStatus}`),
        'owner_refund_unmatched',
      );
    }
    return;
  }

  if (row.provider_refund_id && row.provider_refund_id !== providerRefundId) {
    throw new Error(`Refund attempt ${row.attempt_id} is already bound to a different provider Refund.`);
  }
  const attemptStatus = reconcileRefundLifecycle(row.attempt_status, incoming);
  const isCurrentAttempt = row.attempt_no === row.operation_attempt_count;
  const operationStatus = isCurrentAttempt
    ? reconcileRefundLifecycle(row.operation_status, incoming)
    : row.operation_status;
  const attemptFailure = attemptStatus === row.attempt_status ? row.attempt_error : failure;
  const operationFailure = operationStatus === row.operation_status ? row.operation_error : failure;
  const attemptProviderStatus = attemptStatus === row.attempt_status
    ? (row.attempt_provider_status ?? providerStatus)
    : providerStatus;
  const operationProviderStatus = operationStatus === row.operation_status
    ? (row.operation_provider_status ?? providerStatus)
    : providerStatus;
  const reconciledAt = nowIso();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE refund_operation_attempts
         SET provider_refund_id = COALESCE(provider_refund_id, ?), provider_status = ?,
             outcome_status = ?, error = ?, updated_at = ?
         WHERE id = ? AND outcome_status = ?
           AND (provider_refund_id IS NULL OR provider_refund_id = ?)`,
      )
      .bind(
        providerRefundId,
        attemptProviderStatus,
        attemptStatus,
        attemptFailure,
        reconciledAt,
        row.attempt_id,
        row.attempt_status,
        providerRefundId,
      ),
  ];
  if (isCurrentAttempt) {
    statements.push(
      db
        .prepare(
          `UPDATE refund_operations
           SET provider_refund_id = COALESCE(provider_refund_id, ?), last_provider_status = ?,
               last_error = ?, status = ?, updated_at = ?
           WHERE id = ? AND attempt_count = ? AND status = ?`,
        )
        .bind(
          providerRefundId,
          operationProviderStatus,
          operationFailure,
          operationStatus,
          reconciledAt,
          row.operation_id,
          row.attempt_no,
          row.operation_status,
        ),
    );
  }
  await db.batch(statements);

  // Re-read after the conditional batch. If charge.refunded or another refund
  // event won the race, its newer/terminal values are authoritative. This is a
  // monotonic CAS: stale snapshots can no longer overwrite confirmed rows.
  const persisted = await db
    .prepare(`${selectAttempt} WHERE a.id = ? LIMIT 1`)
    .bind(row.attempt_id)
    .first<RefundEventRow>();
  if (!persisted) throw new Error(`Refund attempt ${row.attempt_id} disappeared during reconciliation.`);
  if (persisted.provider_refund_id && persisted.provider_refund_id !== providerRefundId) {
    throw new Error(`Refund attempt ${row.attempt_id} changed to a different provider Refund.`);
  }

  const persistedIsCurrentAttempt = persisted.attempt_no === persisted.operation_attempt_count;
  const persistedOperationStatus = persisted.operation_status;
  const persistedOperationFailure = persisted.operation_error;
  await db
    .prepare(
      `INSERT OR IGNORE INTO admin_audit_log
         (id, actor, action, entity, entity_id, details_json, created_at)
       VALUES (?, 'system:stripe-webhook', 'refund_provider_status', 'refund_operation', ?, ?, ?)`,
    )
    .bind(
      `al_refund_${eventId}`,
      row.operation_id,
      JSON.stringify({
        providerRefundId,
        providerStatus,
        attemptNo: persisted.attempt_no,
        isCurrentAttempt: persistedIsCurrentAttempt,
        operationStatus: persistedOperationStatus,
      }),
      reconciledAt,
    )
    .run();

  if (
    persistedIsCurrentAttempt
    && persistedOperationStatus !== 'provider_accepted'
    && persistedOperationStatus !== 'confirmed'
    && env.ADMIN_NOTIFY_EMAIL
  ) {
    const config = await getConfig(db);
    const kind = persistedOperationStatus === 'pending'
      ? 'REFUND PENDING'
      : persistedOperationStatus === 'requires_action'
        ? 'REFUND REQUIRES ACTION'
        : persistedOperationStatus === 'failed' || persistedOperationStatus === 'canceled'
          ? 'REFUND FAILED — explicit retry available'
          : 'REFUND RECONCILIATION REQUIRED';
    requireRecordedEmail(
      await queueTemplate(env, db, row.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
        ref: row.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind,
          detail: `${formatCents(row.requested_amount_cents)} refund attempt ${persisted.attempt_no}: ${providerStatus}${persistedOperationFailure ? ` (${persistedOperationFailure})` : ''}`,
          adminUrl: `${publicBase}/ppi/admin/?request=${encodeURIComponent(row.request_id)}`,
        },
      }, waitUntil, row.email, `owner_refund_status:${row.operation_id}:${persisted.attempt_no}:${persistedOperationStatus}`),
      'owner_refund_status',
    );
  }
}

async function handlePaymentSucceeded(
  env: Env,
  sessionId: string,
  paymentIntent: string,
  waitUntil: WaitUntil,
  publicBase: string,
): Promise<void> {
  if (!sessionId) throw new Error('Stripe success event omitted the Checkout Session id.');
  const db = env.DB;
  const now = nowIso();

  const payment = await db
    .prepare(`SELECT id, request_id, quote_id, booking_id, amount_cents, status FROM payments WHERE stripe_session_id = ?`)
    .bind(sessionId)
    .first<{ id: string; request_id: string; quote_id: string; booking_id: string | null; amount_cents: number; status: string }>();
  if (!payment) throw new Error(`Unknown Stripe Checkout Session ${sessionId.slice(0, 48)}.`);

  if (payment.status !== 'succeeded') {
    const updated = await db
      .prepare(
        `UPDATE payments SET status = 'succeeded', stripe_payment_intent = ?, updated_at = ?
         WHERE id = ? AND status IN ('created','pending','failed','expired')`,
      )
      .bind(paymentIntent, now, payment.id)
      .run();
    if ((updated.meta?.changes ?? 0) !== 1) {
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
  if (!payment.booking_id) throw new Error(`Payment ${payment.id} has no booking.`);

  const booking = await db
    .prepare(`SELECT id, slot_id, status FROM bookings WHERE id = ?`)
    .bind(payment.booking_id)
    .first<{ id: string; slot_id: string | null; status: string }>();
  if (!booking) throw new Error(`Payment ${payment.id} references a missing booking.`);

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
