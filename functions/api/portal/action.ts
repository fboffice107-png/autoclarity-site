// POST /api/portal/action — customer actions on their own request:
//   select_slot        — atomically hold an offered appointment window
//   accept_agreements  — record consent for every required document
//   checkout           — create a Stripe test/live Checkout Session (guarded)
//   message            — send a note to AutoClarity
//   cancel             — request cancellation (auto only before payment)

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { getConfig } from '../../lib/config.ts';
import { requirePortal, releaseExpiredHolds } from '../../lib/portal.ts';
import { applyStatus, isStatus, type Status } from '../../lib/status.ts';
import { quoteExpired, cancellationOutcome } from '../../lib/pricing.ts';
import { latestAgreements } from '../../lib/agreements.ts';
import { createCheckoutSession, StripeConfigError } from '../../lib/stripe.ts';
import { sendTemplate } from '../../lib/email.ts';
import { clampStr, clientIp, errorJson, formatCents, json, newId, nowIso, originAllowed } from '../../lib/util.ts';
import { rateLimit } from '../../lib/ratelimit.ts';

interface ActionBody {
  action?: string;
  slotId?: string;
  typedName?: string;
  versionIds?: string[];
  message?: string;
  reason?: string;
}

function fmtSlot(startsAt: string, timezone: string): string {
  return new Date(startsAt).toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!originAllowed(request, env.PUBLIC_BASE_URL)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  const auth = await requirePortal(request, env);
  if (!auth.ok) return auth.response;
  const requestId = auth.requestId;
  const db = env.DB;
  const config = await getConfig(db);
  const flags = modeFlags(env);

  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }

  const req = await db
    .prepare(
      `SELECT r.id, r.ref, r.status, c.email, c.full_name FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(requestId)
    .first<{ id: string; ref: string; status: string; email: string; full_name: string }>();
  if (!req || !isStatus(req.status)) return errorJson('not_found', 'This request no longer exists.', 404);
  const status = req.status as Status;

  switch (body.action) {
    // ------------------------------------------------------------ select_slot
    case 'select_slot': {
      if (!flags.bookingEnabled) return errorJson('booking_disabled', 'Scheduling is not enabled right now.', 409);
      if (status !== 'quote_sent' && status !== 'awaiting_time_selection') {
        return errorJson('wrong_state', 'Appointment selection is not available for this request right now.', 409);
      }
      await releaseExpiredHolds(db);

      const quote = await db
        .prepare(`SELECT id, expires_at FROM quotes WHERE request_id = ? AND status = 'sent' ORDER BY version DESC LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; expires_at: string }>();
      if (!quote) return errorJson('no_quote', 'There is no active quote for this request.', 409);
      if (quoteExpired(quote.expires_at)) {
        return errorJson('quote_expired', 'This quote has expired. AutoClarity will send you a refreshed quote.', 409);
      }

      const slotId = clampStr(body.slotId, 60);
      const holdUntil = new Date(Date.now() + config.scheduling.holdMinutes * 60_000).toISOString();
      try {
        const upd = await db
          .prepare(
            `UPDATE appointment_slots SET status = 'held', hold_expires_at = ?, updated_at = ?
             WHERE id = ? AND request_id = ? AND status = 'offered'`,
          )
          .bind(holdUntil, nowIso(), slotId, requestId)
          .run();
        if ((upd.meta?.changes ?? 0) !== 1) {
          return errorJson('slot_unavailable', 'That time is no longer available. Please pick another window.', 409);
        }
      } catch {
        // Partial unique index tripped: same start time already held/confirmed.
        return errorJson('slot_taken', 'That time was just taken. Please pick another window.', 409);
      }

      if (status === 'quote_sent') {
        await applyStatus(db, requestId, 'quote_sent', 'awaiting_time_selection', 'customer', 'Customer opened scheduling', quote.id);
        await applyStatus(db, requestId, 'awaiting_time_selection', 'awaiting_agreement', 'customer', 'Slot held', slotId);
      } else {
        await applyStatus(db, requestId, 'awaiting_time_selection', 'awaiting_agreement', 'customer', 'Slot held', slotId);
      }

      const slot = await db
        .prepare(`SELECT starts_at FROM appointment_slots WHERE id = ?`)
        .bind(slotId)
        .first<{ starts_at: string }>();
      await sendTemplate(env, db, requestId, 'hold_created', req.email, {
        ref: req.ref,
        supportEmail: config.supportEmail,
        extra: {
          slot: slot ? fmtSlot(slot.starts_at, config.scheduling.timezone) : '',
          holdMinutes: String(config.scheduling.holdMinutes),
        },
      });
      return json({ ok: true, holdExpiresAt: holdUntil });
    }

    // ------------------------------------------------------ accept_agreements
    case 'accept_agreements': {
      if (status !== 'awaiting_agreement') {
        return errorJson('wrong_state', 'Agreements are not awaiting acceptance for this request.', 409);
      }
      const typedName = clampStr(body.typedName, 120);
      if (typedName.length < 2) return errorJson('validation', 'Please type your full name to accept.', 422);

      const required = await latestAgreements(db);
      const provided = new Set((body.versionIds ?? []).map((v) => clampStr(v, 80)));
      const missing = required.filter((d) => !provided.has(d.id));
      if (missing.length > 0) {
        return errorJson('validation', `Please review and accept every document (${missing.length} remaining).`, 422, {
          missing: missing.map((m) => m.title),
        });
      }

      const now = nowIso();
      const ip = clientIp(request);
      const ua = clampStr(request.headers.get('user-agent'), 300);
      const quote = await db
        .prepare(`SELECT id FROM quotes WHERE request_id = ? AND status = 'sent' ORDER BY version DESC LIMIT 1`)
        .bind(requestId)
        .first<{ id: string }>();
      await db.batch(
        required.map((doc) =>
          db
            .prepare(
              `INSERT INTO agreement_acceptances (id, request_id, quote_id, agreement_version_id, typed_name, accepted, ip, user_agent, created_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            )
            .bind(newId('aa'), requestId, quote?.id ?? null, doc.id, typedName, ip, ua, now),
        ),
      );
      await applyStatus(db, requestId, 'awaiting_agreement', 'awaiting_payment', 'customer', 'All agreements accepted');
      return json({ ok: true });
    }

    // --------------------------------------------------------------- checkout
    case 'checkout': {
      if (status !== 'awaiting_payment') {
        return errorJson('wrong_state', 'Payment is not available for this request yet.', 409);
      }
      await releaseExpiredHolds(db);

      const quote = await db
        .prepare(`SELECT id, expires_at, total_cents FROM quotes WHERE request_id = ? AND status = 'sent' ORDER BY version DESC LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; expires_at: string; total_cents: number }>();
      if (!quote) return errorJson('no_quote', 'There is no active quote for this request.', 409);
      if (quoteExpired(quote.expires_at)) {
        return errorJson('quote_expired', 'This quote has expired. AutoClarity will send you a refreshed quote.', 409);
      }

      const slot = await db
        .prepare(`SELECT id, starts_at FROM appointment_slots WHERE request_id = ? AND status = 'held' LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; starts_at: string }>();
      if (!slot) {
        return errorJson('hold_lapsed', 'Your held time lapsed. Please choose an appointment window again.', 409);
      }

      const acceptedCount = await db
        .prepare(`SELECT COUNT(DISTINCT agreement_version_id) AS n FROM agreement_acceptances WHERE request_id = ?`)
        .bind(requestId)
        .first<{ n: number }>();
      const required = await latestAgreements(db);
      if ((acceptedCount?.n ?? 0) < required.length) {
        return errorJson('agreements_missing', 'Please accept the service agreements first.', 409);
      }

      if (!flags.paymentsEnabled) {
        return json({
          paymentsDisabled: true,
          message:
            'Payment is switched off in this preview environment, so the booking stops here by design. In live mode this button opens secure Stripe Checkout.',
        });
      }

      // Booking row (one per request) — created/reused before the session.
      const now = nowIso();
      let booking = await db
        .prepare(`SELECT id FROM bookings WHERE request_id = ?`)
        .bind(requestId)
        .first<{ id: string }>();
      if (!booking) {
        const bookingId = newId('bkg');
        await db
          .prepare(
            `INSERT INTO bookings (id, request_id, quote_id, slot_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending_payment', ?, ?)`,
          )
          .bind(bookingId, requestId, quote.id, slot.id, now, now)
          .run();
        booking = { id: bookingId };
      } else {
        await db
          .prepare(`UPDATE bookings SET quote_id = ?, slot_id = ?, status = 'pending_payment', updated_at = ? WHERE id = ?`)
          .bind(quote.id, slot.id, now, booking.id)
          .run();
      }

      // Extend the hold to cover the 30-minute Checkout window + webhook lag.
      const extended = new Date(Date.now() + Math.max(config.scheduling.holdMinutes, 45) * 60_000).toISOString();
      await db
        .prepare(`UPDATE appointment_slots SET hold_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'held'`)
        .bind(extended, now, slot.id)
        .run();

      try {
        const session = await createCheckoutSession(env, {
          requestId,
          requestRef: req.ref,
          quoteId: quote.id,
          bookingId: booking.id,
          amountCents: quote.total_cents,
          customerEmail: req.email,
          publicBaseUrl: env.PUBLIC_BASE_URL ?? new URL(request.url).origin,
        });
        await db
          .prepare(
            `INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, amount_cents, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
          )
          .bind(newId('pay'), requestId, quote.id, booking.id, session.id, quote.total_cents, now, now)
          .run();
        return json({ ok: true, checkoutUrl: session.url });
      } catch (e) {
        if (e instanceof StripeConfigError) {
          return errorJson('payments_unavailable', 'Payments are not configured in this environment.', 503);
        }
        console.error('checkout_session_failed', String(e).slice(0, 300));
        return errorJson('checkout_failed', 'The payment service is temporarily unavailable. Your held time is unaffected — please try again shortly.', 502);
      }
    }

    // ---------------------------------------------------------------- message
    case 'message': {
      const text = clampStr(body.message, 2000);
      if (text.length < 2) return errorJson('validation', 'Message is empty.', 422);
      const limited = await rateLimit(db, requestId, 'portal_message', 20, 3600);
      if (!limited.allowed) return errorJson('rate_limited', 'Too many messages — please give us a moment to reply.', 429);
      await db
        .prepare(
          `INSERT INTO messages (id, request_id, direction, channel, body_text, status, created_at)
           VALUES (?, ?, 'inbound', 'portal', ?, 'recorded', ?)`,
        )
        .bind(newId('msg'), requestId, text, nowIso())
        .run();
      if (env.ADMIN_NOTIFY_EMAIL) {
        await sendTemplate(env, db, requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
          ref: req.ref,
          supportEmail: config.supportEmail,
          extra: { kind: 'customer message', detail: text.slice(0, 300), adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/` },
        }, req.email);
      }
      return json({ ok: true });
    }

    // ----------------------------------------------------------------- cancel
    case 'cancel': {
      const reason = clampStr(body.reason, 500);
      const paid = await db
        .prepare(`SELECT id FROM payments WHERE request_id = ? AND status = 'succeeded' LIMIT 1`)
        .bind(requestId)
        .first<{ id: string }>();

      if (!paid) {
        // Nothing has been paid — cancel cleanly and release any slots.
        const cancellable: Status[] = [
          'submitted', 'needs_info', 'seller_access_pending', 'ready_for_review',
          'quote_prepared', 'quote_sent', 'awaiting_time_selection', 'awaiting_agreement', 'awaiting_payment',
        ];
        if (!cancellable.includes(status)) {
          return errorJson('wrong_state', 'This request can no longer be cancelled from the portal — contact support.', 409);
        }
        await applyStatus(db, requestId, status, 'customer_cancelled', 'customer', reason || 'Customer cancelled before payment');
        await db
          .prepare(`UPDATE appointment_slots SET status = 'released', hold_expires_at = NULL, updated_at = ? WHERE request_id = ? AND status IN ('offered','held')`)
          .bind(nowIso(), requestId)
          .run();
        await sendTemplate(env, db, requestId, 'cancellation_confirmed', req.email, {
          ref: req.ref,
          supportEmail: config.supportEmail,
          extra: { note: 'No payment had been made, so there is nothing to refund.' },
        });
        return json({ ok: true, cancelled: true });
      }

      // Paid booking: policy is calculated but never auto-enforced — the owner
      // reviews every paid cancellation personally.
      const slot = await db
        .prepare(
          `SELECT s.starts_at FROM bookings b JOIN appointment_slots s ON s.id = b.slot_id WHERE b.request_id = ?`,
        )
        .bind(requestId)
        .first<{ starts_at: string }>();
      const outcome = slot ? cancellationOutcome(slot.starts_at, config) : null;
      await db
        .prepare(
          `INSERT INTO messages (id, request_id, direction, channel, body_text, status, created_at)
           VALUES (?, ?, 'inbound', 'portal', ?, 'recorded', ?)`,
        )
        .bind(newId('msg'), requestId, `CANCELLATION/RESCHEDULE REQUEST: ${reason || '(no reason given)'}${outcome ? ` — policy position: ${outcome.label}` : ''}`, nowIso())
        .run();
      if (env.ADMIN_NOTIFY_EMAIL) {
        await sendTemplate(env, db, requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
          ref: req.ref,
          supportEmail: config.supportEmail,
          extra: {
            kind: 'PAID cancellation request',
            detail: `${reason || '(no reason)'} — ${outcome?.label ?? ''}`,
            adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
          },
        }, req.email);
      }
      return json({
        ok: true,
        cancelled: false,
        underReview: true,
        policyPosition: outcome?.label ?? null,
        message: 'Your cancellation request was received and will be reviewed personally within the policy above. Nothing is forfeited automatically.',
      });
    }

    default:
      return errorJson('unknown_action', 'Unsupported action.', 400);
  }
};
