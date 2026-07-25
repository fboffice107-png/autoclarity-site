// POST /api/stripe/webhook — the ONLY authority on payment state.
// Signature-verified, replay-proof (event ids recorded), idempotent handlers.
// Confirming a booking happens HERE, never on the browser success redirect.

import type { Env } from '../../lib/types.ts';
import { verifyStripeSignature, claimStripeEvent, markStripeEventProcessed, settledPaymentFilter } from '../../lib/stripe.ts';
import { applyStatus, isStatus, type Status } from '../../lib/status.ts';
import { getConfig } from '../../lib/config.ts';
import { sendTemplate } from '../../lib/email.ts';
import { errorJson, formatCents, json, newId, nowIso, sha256Hex } from '../../lib/util.ts';

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
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

  // Replay guard — first claim wins; replays acknowledge without reprocessing.
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
        await handlePaymentSucceeded(env, sessionId, String(obj['payment_intent'] ?? ''));
        break;
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const sessionId = String(obj['id'] ?? '');
        const outcome = event.type === 'checkout.session.expired' ? 'expired' : 'failed';
        const upd = await db
          .prepare(`UPDATE payments SET status = ?, updated_at = ? WHERE stripe_session_id = ? AND status IN ('created','pending')`)
          .bind(outcome, nowIso(), sessionId)
          .run();
        // Only the delivery that actually closed the attempt releases the slot,
        // so a replay or a late duplicate can never disturb a live booking.
        if ((upd.meta?.changes ?? 0) === 1) await releaseAfterFailedCheckout(env, sessionId, outcome);
        break;
      }
      case 'charge.refunded': {
        const paymentIntent = String(obj['payment_intent'] ?? '');
        const refundedCents = Number(obj['amount_refunded'] ?? 0);
        const fully = Boolean(obj['refunded']);
        const payment = await db
          .prepare(`SELECT id, request_id, amount_cents FROM payments WHERE stripe_payment_intent = ?`)
          .bind(paymentIntent)
          .first<{ id: string; request_id: string; amount_cents: number }>();
        if (!payment) {
          console.error('stripe_refund_unmatched_intent', paymentIntent.slice(0, 40));
          await alertOwner(env, null, 'UNKNOWN', 'REFUND FOR AN UNKNOWN PAYMENT', `Stripe reported a refund on ${paymentIntent}, which matches no payment row. Reconcile by hand.`, `owner_unmatched_refund:${paymentIntent}`);
          break;
        }
        await db
          .prepare(`UPDATE payments SET status = ?, refunded_cents = ?, updated_at = ? WHERE id = ?`)
          .bind(fully ? 'refunded' : 'partially_refunded', refundedCents, nowIso(), payment.id)
          .run();
        if (fully) {
          const req = await db
            .prepare(`SELECT status, ref FROM ppi_requests WHERE id = ?`)
            .bind(payment.request_id)
            .first<{ status: string; ref: string }>();
          if (req && isStatus(req.status) && (['confirmed', 'customer_cancelled', 'admin_cancelled', 'completed'] as Status[]).includes(req.status)) {
            await applyStatus(db, payment.request_id, req.status, 'refunded', 'system:stripe-webhook', 'Full refund confirmed by Stripe', payment.id);
          }
          const config = await getConfig(db);
          const customer = await db
            .prepare(`SELECT c.email FROM customers c JOIN ppi_requests r ON r.customer_id = c.id WHERE r.id = ?`)
            .bind(payment.request_id)
            .first<{ email: string }>();
          if (customer && req) {
            await sendTemplate(env, db, payment.request_id, 'refund_issued', customer.email, {
              ref: req.ref,
              supportEmail: config.supportEmail,
              extra: { amount: formatCents(refundedCents) },
            }, undefined, `refund_issued:${payment.id}`);
            if (env.ADMIN_NOTIFY_EMAIL) {
              await sendTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
                ref: req.ref,
                supportEmail: config.supportEmail,
                extra: {
                  kind: 'REFUND COMPLETED',
                  detail: `${formatCents(refundedCents)} refunded — Stripe confirmed`,
                  adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
                },
              }, undefined, `owner_refund:${payment.id}`);
            }
          }
        }
        break;
      }
      case 'charge.dispute.created': {
        const paymentIntent = String(obj['payment_intent'] ?? '');
        const payment = await db
          .prepare(`SELECT id, request_id FROM payments WHERE stripe_payment_intent = ?`)
          .bind(paymentIntent)
          .first<{ id: string; request_id: string }>();
        if (!payment) {
          console.error('stripe_dispute_unmatched_intent', paymentIntent.slice(0, 40));
          await alertOwner(env, null, 'UNKNOWN', 'DISPUTE ON AN UNKNOWN PAYMENT', `Stripe opened a dispute on ${paymentIntent}, which matches no payment row. Respond in the Stripe dashboard.`, `owner_unmatched_dispute:${paymentIntent}`);
          break;
        }
        await db.prepare(`UPDATE payments SET status = 'disputed', updated_at = ? WHERE id = ?`).bind(nowIso(), payment.id).run();
        const req = await db.prepare(`SELECT status FROM ppi_requests WHERE id = ?`).bind(payment.request_id).first<{ status: string }>();
        if (req && isStatus(req.status) && (['completed', 'refunded', 'customer_cancelled', 'admin_cancelled'] as Status[]).includes(req.status)) {
          await applyStatus(db, payment.request_id, req.status, 'disputed', 'system:stripe-webhook', 'Stripe dispute opened', payment.id);
        }
        break;
      }
      default:
        break; // acknowledged, unhandled type
    }
    await markStripeEventProcessed(db, event.id);
    return json({ received: true });
  } catch (e) {
    // Processing failure: report 500 so Stripe retries; the event id stays
    // claimed but unprocessed — retry path below re-enters via claimed=false…
    // so instead, release the claim to allow a clean retry.
    await db.prepare(`DELETE FROM stripe_events WHERE event_id = ? AND processed_at IS NULL`).bind(event.id).run();
    console.error('stripe_webhook_error', event.type, String(e).slice(0, 400));
    return errorJson('processing_failed', 'Event processing failed; Stripe should retry.', 500);
  }
};

/** One-line owner alert with a dedupe key, for states that need a human. */
async function alertOwner(
  env: Env,
  requestId: string | null,
  ref: string,
  kind: string,
  detail: string,
  dedupeKey: string,
): Promise<void> {
  if (!env.ADMIN_NOTIFY_EMAIL) return;
  const config = await getConfig(env.DB);
  await sendTemplate(
    env,
    env.DB,
    requestId,
    'owner_notify',
    env.ADMIN_NOTIFY_EMAIL,
    {
      ref,
      supportEmail: config.supportEmail,
      extra: { kind, detail, adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/` },
    },
    undefined,
    dedupeKey,
  );
}

/**
 * A checkout that expired or failed must not keep holding an appointment
 * window. Releases the held slot back to 'offered' and returns the request to
 * time selection so the portal shows the picker again. Never touches a request
 * that already has a successful payment.
 */
async function releaseAfterFailedCheckout(env: Env, sessionId: string, outcome: 'expired' | 'failed'): Promise<void> {
  const db = env.DB;
  const payment = await db
    .prepare(`SELECT id, request_id, booking_id FROM payments WHERE stripe_session_id = ?`)
    .bind(sessionId)
    .first<{ id: string; request_id: string; booking_id: string | null }>();
  if (!payment) return;

  const settled = settledPaymentFilter();
  const paid = await db
    .prepare(`SELECT id FROM payments WHERE request_id = ? AND status IN (${settled.sql}) LIMIT 1`)
    .bind(payment.request_id, ...settled.values)
    .first<{ id: string }>();
  if (paid) return; // the booking is already paid for — leave it alone

  const now = nowIso();
  if (payment.booking_id) {
    const booking = await db
      .prepare(`SELECT slot_id FROM bookings WHERE id = ?`)
      .bind(payment.booking_id)
      .first<{ slot_id: string | null }>();
    if (booking?.slot_id) {
      await db
        .prepare(`UPDATE appointment_slots SET status = 'offered', hold_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'held'`)
        .bind(now, booking.slot_id)
        .run();
    }
    await db.prepare(`UPDATE bookings SET status = 'pending_payment', updated_at = ? WHERE id = ?`).bind(now, payment.booking_id).run();
  }

  const req = await db.prepare(`SELECT status FROM ppi_requests WHERE id = ?`).bind(payment.request_id).first<{ status: string }>();
  if (req?.status !== 'awaiting_payment') return;
  const moved = await applyStatus(
    db,
    payment.request_id,
    'awaiting_payment',
    'awaiting_time_selection',
    'system:stripe-webhook',
    `Checkout ${outcome} — appointment window released`,
    payment.id,
  );
  if (!moved) return;
  await db
    .prepare(
      `INSERT INTO messages (id, request_id, direction, channel, body_text, status, created_at)
       VALUES (?, ?, 'outbound', 'portal', ?, 'recorded', ?)`,
    )
    .bind(
      newId('msg'),
      payment.request_id,
      outcome === 'expired'
        ? 'Your secure checkout expired before payment completed, so the appointment window was released. Nothing was charged — pick a time below whenever you are ready.'
        : 'Your payment did not complete, so the appointment window was released. Nothing was charged — pick a time below to try again.',
      now,
    )
    .run();
}

async function handlePaymentSucceeded(env: Env, sessionId: string, paymentIntent: string): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  const config = await getConfig(db);

  // Money has moved. It gets recorded even if this end had written the attempt
  // off locally — the one thing we must never do is acknowledge a real payment
  // and drop it.
  const before = await db
    .prepare(`SELECT id, status FROM payments WHERE stripe_session_id = ?`)
    .bind(sessionId)
    .first<{ id: string; status: string }>();
  if (!before) {
    console.error('stripe_payment_unmatched_session', sessionId.slice(0, 40));
    await alertOwner(env, null, 'UNKNOWN', 'PAYMENT WITH NO LOCAL RECORD — investigate', `Stripe reported a successful payment for session ${sessionId} that matches no payment row. Check Stripe and reconcile by hand.`, `owner_unmatched_payment:${sessionId}`);
    return;
  }

  // Idempotent claim of the payment row itself. 'expired'/'failed' are included
  // because those are OUR conclusions, and Stripe has just overruled them.
  const upd = await db
    .prepare(
      `UPDATE payments SET status = 'succeeded', stripe_payment_intent = ?, updated_at = ?
       WHERE stripe_session_id = ? AND status IN ('created','pending','expired','failed')`,
    )
    .bind(paymentIntent, now, sessionId)
    .run();
  if ((upd.meta?.changes ?? 0) !== 1) return; // already succeeded/refunded/disputed
  const writtenOff = before.status === 'expired' || before.status === 'failed';

  const payment = await db
    .prepare(`SELECT id, request_id, quote_id, booking_id, amount_cents FROM payments WHERE stripe_session_id = ?`)
    .bind(sessionId)
    .first<{ id: string; request_id: string; quote_id: string; booking_id: string; amount_cents: number }>();
  if (!payment) return;

  const requestRow = await db
    .prepare(
      `SELECT r.status, r.ref, c.email FROM ppi_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
    )
    .bind(payment.request_id)
    .first<{ status: string; ref: string; email: string }>();
  if (!requestRow) return;

  // Loud, deduped alerts for the two states that mean money needs a human.
  if (writtenOff) {
    await alertOwner(
      env,
      payment.request_id,
      requestRow.ref,
      'PAYMENT ARRIVED ON A CLOSED ATTEMPT',
      `${formatCents(payment.amount_cents)} succeeded on a checkout this system had marked ${before.status}. Confirm no second payment was taken.`,
      `owner_late_payment:${payment.id}`,
    );
  }
  const settled = await db
    .prepare(`SELECT COUNT(*) AS n FROM payments WHERE request_id = ? AND status IN ('succeeded','partially_refunded')`)
    .bind(payment.request_id)
    .first<{ n: number }>();
  if ((settled?.n ?? 0) > 1) {
    await alertOwner(
      env,
      payment.request_id,
      requestRow.ref,
      'DUPLICATE PAYMENT — refund needed',
      `This request now has ${settled?.n} settled payments. Refund the extra one from the admin dashboard.`,
      `owner_duplicate_payment:${payment.id}`,
    );
  }

  const booking = await db
    .prepare(`SELECT id, slot_id FROM bookings WHERE id = ?`)
    .bind(payment.booking_id)
    .first<{ id: string; slot_id: string | null }>();

  // Try to confirm the held slot. If the hold lapsed and someone else took the
  // time, the payment stands but scheduling reopens — admin is alerted.
  let slotConfirmed = false;
  let slotStartsAt: string | null = null;
  if (booking?.slot_id) {
    let slotUpd: D1Result | null = null;
    // Same overlap rule the portal enforces at selection time: the unique index
    // only covers identical start times, and an inspection lasts hours.
    const window = await db
      .prepare(`SELECT starts_at, ends_at FROM appointment_slots WHERE id = ?`)
      .bind(booking.slot_id)
      .first<{ starts_at: string; ends_at: string }>();
    const overlap = window
      ? await db
          .prepare(
            `SELECT id FROM appointment_slots
              WHERE id != ? AND request_id != ? AND status IN ('held','confirmed')
                AND starts_at < ? AND ends_at > ? LIMIT 1`,
          )
          .bind(booking.slot_id, payment.request_id, window.ends_at, window.starts_at)
          .first<{ id: string }>()
      : null;
    try {
      if (overlap) throw new Error('window overlaps another booking');
      slotUpd = await db
        .prepare(`UPDATE appointment_slots SET status = 'confirmed', hold_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('held','offered')`)
        .bind(now, booking.slot_id)
        .run();
    } catch {
      // The window now belongs to someone else — either the overlap check above
      // or the no-double-booking index refused it. Treat it exactly like a
      // lapsed hold: the payment stands, scheduling reopens, the owner is
      // alerted below, and nobody is double-booked.
      slotUpd = null;
    }
    slotConfirmed = (slotUpd?.meta?.changes ?? 0) === 1;
    if (slotConfirmed) {
      const slot = await db.prepare(`SELECT starts_at FROM appointment_slots WHERE id = ?`).bind(booking.slot_id).first<{ starts_at: string }>();
      slotStartsAt = slot?.starts_at ?? null;
    }
  }

  await db.prepare(`UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?`).bind(now, payment.quote_id).run();

  if (slotConfirmed && booking) {
    await db
      .prepare(`UPDATE bookings SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`)
      .bind(now, now, booking.id)
      .run();
    // Release every other proposed window for this request.
    await db
      .prepare(`UPDATE appointment_slots SET status = 'released', updated_at = ? WHERE request_id = ? AND id != ? AND status IN ('offered','held')`)
      .bind(now, payment.request_id, booking.slot_id)
      .run();
    // The status was read before the slot update; if it moved underneath us the
    // compare-and-swap fails and the request would silently disagree with the
    // confirmation emails we are about to send. Tell the owner instead.
    const confirmedRequest =
      requestRow.status === 'awaiting_payment' &&
      (await applyStatus(db, payment.request_id, 'awaiting_payment', 'confirmed', 'system:stripe-webhook', 'Payment succeeded — booking confirmed', payment.id));
    if (!confirmedRequest) {
      const current = await db.prepare(`SELECT status FROM ppi_requests WHERE id = ?`).bind(payment.request_id).first<{ status: string }>();
      if (current?.status !== 'confirmed') {
        await alertOwner(
          env,
          payment.request_id,
          requestRow.ref,
          'PAID AND SCHEDULED BUT STATUS DID NOT MOVE',
          `The window is confirmed and the customer was emailed, but the request is still "${current?.status ?? 'unknown'}". Set it to Confirmed by hand.`,
          `owner_status_divergence:${payment.id}`,
        );
      }
    }
    // Dedupe keys make these single-send even if a duplicate Stripe delivery
    // ever slipped past the event-id replay guard.
    await sendTemplate(env, db, payment.request_id, 'payment_received', requestRow.email, {
      ref: requestRow.ref,
      supportEmail: config.supportEmail,
      extra: { amount: formatCents(payment.amount_cents) },
    }, undefined, `payment_received:${payment.id}`);
    await sendTemplate(env, db, payment.request_id, 'appointment_confirmed', requestRow.email, {
      ref: requestRow.ref,
      portalUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/portal/`,
      supportEmail: config.supportEmail,
      extra: { slot: slotStartsAt ? fmtSlot(slotStartsAt, config.scheduling.timezone) : '' },
    }, undefined, `appointment_confirmed:${payment.id}`);
    if (env.ADMIN_NOTIFY_EMAIL) {
      await sendTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
        ref: requestRow.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind: 'BOOKING CONFIRMED',
          detail: `${formatCents(payment.amount_cents)} paid — ${slotStartsAt ? fmtSlot(slotStartsAt, config.scheduling.timezone) : ''}`,
          adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
        },
      }, undefined, `owner_booking_confirmed:${payment.id}`);
    }
  } else {
    // Paid but the held time was lost (expired hold taken by another request).
    if (isStatus(requestRow.status) && requestRow.status === 'awaiting_payment') {
      await applyStatus(db, payment.request_id, 'awaiting_payment', 'awaiting_time_selection', 'system:stripe-webhook', 'Payment succeeded but held time lapsed — rescheduling needed', payment.id);
    }
    await db
      .prepare(
        `INSERT INTO messages (id, request_id, direction, channel, body_text, status, created_at)
         VALUES (?, ?, 'outbound', 'portal', ?, 'recorded', ?)`,
      )
      .bind(
        newId('msg'),
        payment.request_id,
        'Your payment was received, but your held time lapsed before it completed. Nothing is lost — pick a new time from the options on this page, or AutoClarity will reach out with fresh windows.',
        now,
      )
      .run();
    if (env.ADMIN_NOTIFY_EMAIL) {
      await sendTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
        ref: requestRow.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind: 'PAID BUT SLOT LAPSED — action needed',
          detail: `Payment ${formatCents(payment.amount_cents)} succeeded but the window could not be confirmed (hold released or the time was taken). Offer new windows.`,
          adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
        },
      }, undefined, `owner_slot_lapsed:${payment.id}`);
    }
  }
}
