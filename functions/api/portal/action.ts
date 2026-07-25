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
import { evaluateCheckoutGates } from '../../lib/checkout-gates.ts';
import {
  createCheckoutSession,
  expireCheckoutSession,
  retrieveCheckoutSession,
  sessionIsPayingOrPaid,
  settledPaymentFilter,
  StripeConfigError,
} from '../../lib/stripe.ts';
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

      // 'accepted' is included so a customer whose paid appointment lost its
      // window (see the Stripe webhook) can still pick a replacement time —
      // and an already-paid quote is not re-checked for expiry.
      const quote = await db
        .prepare(`SELECT id, status, expires_at FROM quotes WHERE request_id = ? AND status IN ('sent','accepted') ORDER BY version DESC LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; status: string; expires_at: string }>();
      if (!quote) return errorJson('no_quote', 'There is no active quote for this request.', 409);
      if (quote.status === 'sent' && quoteExpired(quote.expires_at)) {
        return errorJson('quote_expired', 'This quote has expired. AutoClarity will send you a refreshed quote.', 409);
      }

      const slotId = clampStr(body.slotId, 60);
      const holdUntil = new Date(Date.now() + config.scheduling.holdMinutes * 60_000).toISOString();

      // A request may hold only one slot at a time. Release any slot this same
      // request is already holding before placing the new hold, so two portal
      // tokens racing on different slots can't leave the request double-held.
      await db
        .prepare(`UPDATE appointment_slots SET status = 'offered', hold_expires_at = NULL, updated_at = ? WHERE request_id = ? AND status = 'held'`)
        .bind(nowIso(), requestId)
        .run();

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

      // The database index only guarantees one hold per exact start time. An
      // inspection runs for hours, so reserve-then-verify covers overlap too:
      // the hold above is already visible, so of two racing customers at least
      // one sees the other and steps back.
      const heldWindow = await db
        .prepare(`SELECT starts_at, ends_at FROM appointment_slots WHERE id = ?`)
        .bind(slotId)
        .first<{ starts_at: string; ends_at: string }>();
      if (heldWindow) {
        const overlap = await db
          .prepare(
            `SELECT id FROM appointment_slots
              WHERE id != ? AND request_id != ? AND status IN ('held','confirmed')
                AND starts_at < ? AND ends_at > ? LIMIT 1`,
          )
          .bind(slotId, requestId, heldWindow.ends_at, heldWindow.starts_at)
          .first<{ id: string }>();
        if (overlap) {
          await db
            .prepare(`UPDATE appointment_slots SET status = 'offered', hold_expires_at = NULL, updated_at = ? WHERE id = ? AND request_id = ? AND status = 'held'`)
            .bind(nowIso(), slotId, requestId)
            .run();
          return errorJson('slot_taken', 'That window overlaps an appointment that was just booked. Please pick another one.', 409);
        }
      }

      // Advance the request state, checking each hop. If the compare-and-swap
      // loses a concurrent race, release the hold we just placed and 409 so we
      // never leave a held slot attached to a non-scheduling status.
      const moved =
        status === 'quote_sent'
          ? (await applyStatus(db, requestId, 'quote_sent', 'awaiting_time_selection', 'customer', 'Customer opened scheduling', quote.id)) &&
            (await applyStatus(db, requestId, 'awaiting_time_selection', 'awaiting_agreement', 'customer', 'Slot held', slotId))
          : await applyStatus(db, requestId, 'awaiting_time_selection', 'awaiting_agreement', 'customer', 'Slot held', slotId);
      if (!moved) {
        await db
          .prepare(`UPDATE appointment_slots SET status = 'offered', hold_expires_at = NULL, updated_at = ? WHERE id = ? AND request_id = ? AND status = 'held'`)
          .bind(nowIso(), slotId, requestId)
          .run();
        return errorJson('conflict', 'This request changed a moment ago — reload the page and pick your time again.', 409);
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
      if (env.ADMIN_NOTIFY_EMAIL) {
        await sendTemplate(env, db, requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
          ref: req.ref,
          supportEmail: config.supportEmail,
          extra: {
            kind: 'appointment selected',
            detail: `Customer held ${slot ? fmtSlot(slot.starts_at, config.scheduling.timezone) : 'a window'} (agreement + payment pending)`,
            adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
          },
        }, undefined, `owner_slot_selected:${slotId}`);
      }
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
      // Consent is recorded either way; only advance if the request is still
      // where we found it, so a concurrent admin change can't be overwritten.
      const advanced = await applyStatus(db, requestId, 'awaiting_agreement', 'awaiting_payment', 'customer', 'All agreements accepted');
      if (!advanced) {
        return errorJson('conflict', 'This request changed a moment ago — reload the page and continue from there.', 409);
      }
      return json({ ok: true });
    }

    // --------------------------------------------------------------- checkout
    case 'checkout': {
      await releaseExpiredHolds(db);

      // ---- gather the facts every gate is decided on -----------------------
      // The highest-version quote whatever its status, so "superseded" and
      // "draft" are distinguishable from "no quote at all".
      const quote = await db
        .prepare(`SELECT id, status, expires_at, total_cents FROM quotes WHERE request_id = ? ORDER BY version DESC LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; status: string; expires_at: string; total_cents: number }>();

      const slot = await db
        .prepare(`SELECT id, starts_at FROM appointment_slots WHERE request_id = ? AND status = 'held' LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; starts_at: string }>();

      const required = await latestAgreements(db);
      const acceptances = await db
        .prepare(`SELECT agreement_version_id, quote_id FROM agreement_acceptances WHERE request_id = ? AND accepted = 1`)
        .bind(requestId)
        .all<{ agreement_version_id: string; quote_id: string | null }>();
      const acceptedRows = acceptances.results ?? [];

      const settledFilter = settledPaymentFilter();
      const settled = await db
        .prepare(`SELECT id FROM payments WHERE request_id = ? AND status IN (${settledFilter.sql}) LIMIT 1`)
        .bind(requestId, ...settledFilter.values)
        .first<{ id: string }>();

      const gate = evaluateCheckoutGates({
        status,
        quote: quote ? { id: quote.id, status: quote.status, expiresAt: quote.expires_at, totalCents: quote.total_cents } : null,
        hasSettledPayment: Boolean(settled),
        heldSlotId: slot?.id ?? null,
        requiredAgreementIds: required.map((d) => d.id),
        acceptedAgreementIds: acceptedRows.map((a) => a.agreement_version_id),
        acceptedForQuoteIds: quote
          ? acceptedRows.filter((a) => a.quote_id === quote.id).map((a) => a.agreement_version_id)
          : [],
      });

      if (!gate.ok) {
        // Never leave the customer on a dead-end screen: walk the request back
        // to the step that needs redoing, so the portal renders that step.
        if (gate.recover === 'time_selection') {
          const moved = await applyStatus(db, requestId, 'awaiting_payment', 'awaiting_time_selection', 'system:checkout-gate', gate.code);
          if (moved) {
            await db
              .prepare(
                `INSERT INTO messages (id, request_id, direction, channel, body_text, status, created_at)
                 VALUES (?, ?, 'outbound', 'portal', ?, 'recorded', ?)`,
              )
              .bind(
                newId('msg'),
                requestId,
                'The appointment time you were holding was released before payment completed. Nothing is lost — choose one of the available windows below, or message us and fresh times will be offered.',
                nowIso(),
              )
              .run();
            if (env.ADMIN_NOTIFY_EMAIL) {
              await sendTemplate(env, db, requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
                ref: req.ref,
                supportEmail: config.supportEmail,
                extra: {
                  kind: 'hold lapsed before payment',
                  detail: 'The customer returned to pay after their held window was released. Offer fresh windows if none remain.',
                  adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
                },
              }, undefined, `owner_hold_lapsed:${requestId}`);
            }
          }
        } else if (gate.recover === 'agreement') {
          await applyStatus(db, requestId, 'awaiting_payment', 'awaiting_agreement', 'system:checkout-gate', gate.code);
        }
        return errorJson(gate.code, gate.message, gate.httpStatus);
      }

      // Gates passed; `quote` and `slot` are non-null from here.
      const activeQuote = quote!;
      const heldSlot = slot!;

      if (!flags.paymentsEnabled) {
        return json({
          paymentsDisabled: true,
          message:
            'Payment is switched off in this preview environment, so the booking stops here by design. In live mode this button opens secure Stripe Checkout.',
        });
      }

      const now = nowIso();

      // ---- one live Checkout Session per request ---------------------------
      // A second click (or a second tab) must never mint a second payable
      // session. An open attempt for the same quote + slot hands back the same
      // URL; anything else is closed at Stripe before a replacement is made.
      const open = await db
        .prepare(
          `SELECT p.id, p.quote_id, p.created_at, p.stripe_session_id, p.checkout_url, p.session_expires_at, b.slot_id
             FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id
            WHERE p.request_id = ? AND p.status IN ('created','pending')
            ORDER BY p.created_at DESC LIMIT 1`,
        )
        .bind(requestId)
        .first<{
          id: string;
          quote_id: string;
          created_at: string;
          stripe_session_id: string | null;
          checkout_url: string | null;
          session_expires_at: string | null;
          slot_id: string | null;
        }>();

      // Reuse the attempt row itself where possible: the Stripe idempotency key
      // is derived from it, so retrying the SAME attempt can only ever recover
      // the session Stripe already made — never create a second payable one.
      let attemptId = newId('pay');
      let attemptCreatedAt = now;
      let retryingAttempt = false;

      if (open) {
        const sameTarget = open.quote_id === activeQuote.id && open.slot_id === heldSlot.id;
        const sessionLive =
          open.checkout_url && open.session_expires_at && new Date(open.session_expires_at).getTime() > Date.now() + 120_000;
        // An attempt is only worth retrying while Stripe would still accept its
        // replayed expires_at (which must be at least 30 minutes ahead).
        const attemptFresh = Date.now() - new Date(open.created_at).getTime() < 25 * 60_000;

        if (sameTarget && sessionLive) {
          return json({ ok: true, checkoutUrl: open.checkout_url, reused: true });
        }
        if (sameTarget && !open.stripe_session_id && attemptFresh) {
          attemptId = open.id;
          attemptCreatedAt = open.created_at;
          retryingAttempt = true;
        } else if (open.stripe_session_id) {
          // Replacing an attempt that HAS a session is the one genuinely
          // dangerous move: our local expiry estimate can lag a payment the
          // customer already completed. Stripe decides, not the database.
          const remote = await retrieveCheckoutSession(env, open.stripe_session_id);
          if (!remote) {
            return errorJson(
              'checkout_unavailable',
              'We could not reach the payment service to check your existing checkout. Nothing was charged — please try again in a moment.',
              503,
            );
          }
          if (sessionIsPayingOrPaid(remote)) {
            return errorJson(
              'payment_processing',
              'Your payment is already going through. This page updates by itself as soon as it is confirmed — please do not pay again.',
              409,
            );
          }
          if (remote.status === 'open' && !(await expireCheckoutSession(env, open.stripe_session_id))) {
            return errorJson(
              'checkout_in_progress',
              'Your previous checkout is still open. Finish it, or wait a moment and reload this page.',
              409,
            );
          }
          await db
            .prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('created','pending')`)
            .bind(now, open.id)
            .run();
        } else {
          // No session was ever recorded and the attempt is too stale to replay.
          // Any session Stripe did create expires on its own, because its
          // expires_at was fixed to this attempt's creation time.
          await db
            .prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('created','pending')`)
            .bind(now, open.id)
            .run();
        }
      }

      // Booking row (one per request) — created/reused before the session.
      let booking = await db
        .prepare(`SELECT id FROM bookings WHERE request_id = ?`)
        .bind(requestId)
        .first<{ id: string }>();
      if (!booking) {
        const bookingId = newId('bkg');
        try {
          await db
            .prepare(
              `INSERT INTO bookings (id, request_id, quote_id, slot_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'pending_payment', ?, ?)`,
            )
            .bind(bookingId, requestId, activeQuote.id, heldSlot.id, now, now)
            .run();
          booking = { id: bookingId };
        } catch {
          // UNIQUE(request_id): a concurrent attempt created it first.
          booking = await db.prepare(`SELECT id FROM bookings WHERE request_id = ?`).bind(requestId).first<{ id: string }>();
          if (!booking) return errorJson('checkout_failed', 'The payment service is temporarily unavailable — please try again shortly.', 502);
        }
      }
      await db
        .prepare(`UPDATE bookings SET quote_id = ?, slot_id = ?, status = 'pending_payment', updated_at = ? WHERE id = ?`)
        .bind(activeQuote.id, heldSlot.id, now, booking.id)
        .run();

      // Reserve the payment attempt BEFORE talking to Stripe, so a session can
      // never exist without a row to match its webhook against. The partial
      // unique index on open attempts makes this the concurrency guard too.
      if (!retryingAttempt) {
        try {
          await db
            .prepare(
              `INSERT INTO payments (id, request_id, quote_id, booking_id, amount_cents, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
            )
            .bind(attemptId, requestId, activeQuote.id, booking.id, activeQuote.total_cents, now, now)
            .run();
        } catch {
          return errorJson(
            'checkout_in_progress',
            'A secure checkout is already being opened for this request. Give it a moment, then reload this page.',
            409,
          );
        }
      }

      // 60 minutes from the ATTEMPT, not from now: Stripe requires at least 30
      // minutes of runway, and a replay up to 25 minutes later must send this
      // exact same value.
      const attemptExpiresAtEpoch = Math.floor(new Date(attemptCreatedAt).getTime() / 1000) + 3600;

      // Keep the hold alive past the Checkout window (60 min) + webhook lag, so
      // a payment can never land on a window we already gave away.
      const extended = new Date(Date.now() + Math.max(config.scheduling.holdMinutes, 70) * 60_000).toISOString();
      await db
        .prepare(`UPDATE appointment_slots SET hold_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'held'`)
        .bind(extended, now, heldSlot.id)
        .run();

      try {
        const session = await createCheckoutSession(env, {
          requestId,
          requestRef: req.ref,
          quoteId: activeQuote.id,
          bookingId: booking.id,
          slotId: heldSlot.id,
          paymentId: attemptId,
          amountCents: activeQuote.total_cents,
          customerEmail: req.email,
          publicBaseUrl: env.PUBLIC_BASE_URL ?? new URL(request.url).origin,
          expiresAtEpoch: attemptExpiresAtEpoch,
        });
        await db
          .prepare(
            `UPDATE payments SET stripe_session_id = ?, checkout_url = ?, session_expires_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            session.id,
            session.url,
            // Stripe echoes expires_at; fall back to what we asked for rather
            // than throwing on a malformed value.
            new Date((Number.isFinite(session.expiresAt) && session.expiresAt > 0 ? session.expiresAt : attemptExpiresAtEpoch) * 1000).toISOString(),
            nowIso(),
            attemptId,
          )
          .run();
        return json({ ok: true, checkoutUrl: session.url });
      } catch (e) {
        if (e instanceof StripeConfigError) {
          // Nothing was sent to Stripe, so the attempt cannot have a session.
          await db
            .prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'created'`)
            .bind(nowIso(), attemptId)
            .run();
          return errorJson('payments_unavailable', 'Payments are not configured in this environment.', 503);
        }
        // The call may or may not have reached Stripe (timeout, dropped
        // response, 5xx). Leave the attempt OPEN: the next try replays the same
        // idempotency key, which recovers the original session if one exists.
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
      // Every settled state counts as paid here, not just 'succeeded': telling
      // a customer whose payment was refunded or disputed that "no payment had
      // been made" would be false, and auto-cancelling during a dispute
      // destroys the record the owner needs.
      const cancelFilter = settledPaymentFilter();
      const paid = await db
        .prepare(`SELECT id FROM payments WHERE request_id = ? AND status IN (${cancelFilter.sql}) LIMIT 1`)
        .bind(requestId, ...cancelFilter.values)
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
        if (env.ADMIN_NOTIFY_EMAIL) {
          await sendTemplate(env, db, requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
            ref: req.ref,
            supportEmail: config.supportEmail,
            extra: {
              kind: 'customer cancelled (unpaid)',
              detail: reason || '(no reason given)',
              adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
            },
          }, req.email, `owner_cancelled:${requestId}`);
        }
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
