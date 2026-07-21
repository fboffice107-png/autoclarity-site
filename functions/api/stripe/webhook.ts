// POST /api/stripe/webhook — the ONLY authority on payment state.
// Signature-verified, replay-proof (event ids recorded), idempotent handlers.
// Confirming a booking happens HERE, never on the browser success redirect.

import type { Env } from '../../lib/types.ts';
import { verifyStripeSignature, claimStripeEvent, markStripeEventProcessed } from '../../lib/stripe.ts';
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
      case 'checkout.session.async_payment_failed': {
        const sessionId = String(obj['id'] ?? '');
        await db
          .prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE stripe_session_id = ? AND status IN ('created','pending')`)
          .bind(nowIso(), sessionId)
          .run();
        break;
      }
      case 'checkout.session.expired': {
        const sessionId = String(obj['id'] ?? '');
        await db
          .prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE stripe_session_id = ? AND status IN ('created','pending')`)
          .bind(nowIso(), sessionId)
          .run();
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
        if (!payment) break;
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
            });
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
        if (!payment) break;
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

async function handlePaymentSucceeded(env: Env, sessionId: string, paymentIntent: string): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  const config = await getConfig(db);

  // Idempotent claim of the payment row itself.
  const upd = await db
    .prepare(
      `UPDATE payments SET status = 'succeeded', stripe_payment_intent = ?, updated_at = ?
       WHERE stripe_session_id = ? AND status IN ('created','pending')`,
    )
    .bind(paymentIntent, now, sessionId)
    .run();
  if ((upd.meta?.changes ?? 0) !== 1) return; // already handled or unknown session

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

  const booking = await db
    .prepare(`SELECT id, slot_id FROM bookings WHERE id = ?`)
    .bind(payment.booking_id)
    .first<{ id: string; slot_id: string | null }>();

  // Try to confirm the held slot. If the hold lapsed and someone else took the
  // time, the payment stands but scheduling reopens — admin is alerted.
  let slotConfirmed = false;
  let slotStartsAt: string | null = null;
  if (booking?.slot_id) {
    const slotUpd = await db
      .prepare(`UPDATE appointment_slots SET status = 'confirmed', hold_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('held','offered')`)
      .bind(now, booking.slot_id)
      .run();
    slotConfirmed = (slotUpd.meta?.changes ?? 0) === 1;
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
    if (isStatus(requestRow.status) && requestRow.status === 'awaiting_payment') {
      await applyStatus(db, payment.request_id, 'awaiting_payment', 'confirmed', 'system:stripe-webhook', 'Payment succeeded — booking confirmed', payment.id);
    }
    await sendTemplate(env, db, payment.request_id, 'payment_received', requestRow.email, {
      ref: requestRow.ref,
      supportEmail: config.supportEmail,
      extra: { amount: formatCents(payment.amount_cents) },
    });
    await sendTemplate(env, db, payment.request_id, 'appointment_confirmed', requestRow.email, {
      ref: requestRow.ref,
      portalUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/portal/`,
      supportEmail: config.supportEmail,
      extra: { slot: slotStartsAt ? fmtSlot(slotStartsAt, config.scheduling.timezone) : '' },
    });
    if (env.ADMIN_NOTIFY_EMAIL) {
      await sendTemplate(env, db, payment.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
        ref: requestRow.ref,
        supportEmail: config.supportEmail,
        extra: {
          kind: 'BOOKING CONFIRMED',
          detail: `${formatCents(payment.amount_cents)} paid — ${slotStartsAt ? fmtSlot(slotStartsAt, config.scheduling.timezone) : ''}`,
          adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
        },
      });
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
          detail: `Payment ${formatCents(payment.amount_cents)} succeeded after the hold expired. Offer new windows.`,
          adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
        },
      });
    }
  }
}
