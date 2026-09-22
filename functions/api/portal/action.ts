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
import {
  createCheckoutSession,
  expireCheckoutSession,
  STRIPE_CHECKOUT_CURRENCY,
  StripeApiError,
  StripeConfigError,
} from '../../lib/stripe.ts';
import { expireOpenCheckoutAttempts } from '../../lib/payment-lifecycle.ts';
import { applyTerminalLifecycle } from '../../lib/lifecycle.ts';
import { sendTemplate } from '../../lib/email.ts';
import { portalUrl } from '../../lib/magic.ts';
import { clampStr, clientIp, errorJson, formatCents, json, newId, nowIso, originAllowed } from '../../lib/util.ts';
import { rateLimit } from '../../lib/ratelimit.ts';
import { readJsonBody, requestBodyErrorResponse } from '../../lib/request-body.ts';

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

// Used in every durable Checkout claim/finalization CAS. Keeping this as one
// SQL predicate prevents the preflight check from drifting from the checks
// immediately before and after the provider call.
const LATEST_QUOTE_AGREEMENTS_ACCEPTED_SQL = `
  EXISTS (SELECT 1 FROM agreement_versions)
  AND NOT EXISTS (
    SELECT 1
    FROM agreement_versions av
    JOIN (
      SELECT doc_key, MAX(version) AS version
      FROM agreement_versions GROUP BY doc_key
    ) latest ON latest.doc_key = av.doc_key AND latest.version = av.version
    WHERE NOT EXISTS (
      SELECT 1 FROM agreement_acceptances accepted
      WHERE accepted.request_id = ? AND accepted.quote_id = ?
        AND accepted.agreement_version_id = av.id AND accepted.accepted = 1
    )
  )`;

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
    body = await readJsonBody<ActionBody>(request);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }

  // Run before loading the request so every action sees the selectable state
  // produced by an expired hold, rather than acting on a stale checkout state.
  await releaseExpiredHolds(db);

  const req = await db
    .prepare(
      `SELECT r.id, r.ref, r.status, r.attribution_source, c.email, c.full_name FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(requestId)
    .first<{ id: string; ref: string; status: string; attribution_source: string; email: string; full_name: string }>();
  if (!req || !isStatus(req.status)) return errorJson('not_found', 'This request no longer exists.', 404);
  const status = req.status as Status;

  switch (body.action) {
    // ------------------------------------------------------------ select_slot
    case 'select_slot': {
      if (!flags.bookingEnabled) return errorJson('booking_disabled', 'Scheduling is not enabled right now.', 409);
      if (status !== 'quote_sent' && status !== 'awaiting_time_selection') {
        return errorJson('wrong_state', 'Appointment selection is not available for this request right now.', 409);
      }
      const paid = status === 'awaiting_time_selection'
        ? await db
            .prepare(
              `SELECT id, booking_id, amount_cents, status FROM payments
               WHERE request_id = ? AND status IN ('succeeded','partially_refunded') ORDER BY updated_at DESC LIMIT 1`,
            )
            .bind(requestId)
            .first<{ id: string; booking_id: string | null; amount_cents: number; status: 'succeeded' | 'partially_refunded' }>()
        : null;
      const quote = await db
        .prepare(
          `SELECT id, expires_at FROM quotes
           WHERE request_id = ? AND status ${paid ? "IN ('sent','accepted')" : "= 'sent'"}
           ORDER BY version DESC LIMIT 1`,
        )
        .bind(requestId)
        .first<{ id: string; expires_at: string }>();
      if (!quote) return errorJson('no_quote', 'There is no active quote for this request.', 409);
      if (!paid && quoteExpired(quote.expires_at)) {
        return errorJson('quote_expired', 'This quote has expired. AutoClarity will send you a refreshed quote.', 409);
      }
      if (paid && !paid.booking_id) {
        return errorJson(
          'payment_reconciliation_required',
          'Your payment is recorded, but scheduling needs AutoClarity support. No new charge was started.',
          409,
        );
      }

      const slotId = clampStr(body.slotId, 60);
      const selectionNow = Date.now();
      const earliest = new Date(selectionNow + config.scheduling.minLeadHours * 3600_000 - 60_000).toISOString();
      const latest = new Date(selectionNow + config.scheduling.maxAdvanceDays * 86_400_000 + 60_000).toISOString();
      const slot = await db
        .prepare(
          `SELECT starts_at, ends_at, COALESCE(blocked_starts_at, starts_at) AS blocked_starts_at,
                  COALESCE(blocked_ends_at, ends_at) AS blocked_ends_at
           FROM appointment_slots
           WHERE id = ? AND request_id = ? AND status = 'offered'`,
        )
        .bind(slotId, requestId)
        .first<{ starts_at: string; ends_at: string; blocked_starts_at: string; blocked_ends_at: string }>();
      if (!slot) return errorJson('slot_unavailable', 'That time is no longer available. Please pick another window.', 409);
      if (slot.starts_at < earliest || slot.starts_at > latest || slot.ends_at <= slot.starts_at) {
        return errorJson('slot_invalid', 'That time is outside the current scheduling window. Please pick another option.', 409);
      }

      if (paid?.booking_id) {
        const paidBooking = await db
          .prepare(`SELECT id FROM bookings WHERE id = ? AND request_id = ? AND status = 'pending_payment'`)
          .bind(paid.booking_id, requestId)
          .first<{ id: string }>();
        if (!paidBooking) {
          return errorJson(
            'payment_reconciliation_required',
            'Your payment is recorded, but scheduling needs AutoClarity support. No new charge was started.',
            409,
          );
        }
      }

      const holdUntil = new Date(Date.now() + config.scheduling.holdMinutes * 60_000).toISOString();

      try {
        const upd = await db
          .prepare(
            `UPDATE appointment_slots SET status = 'held', hold_expires_at = ?, updated_at = ?
             WHERE id = ? AND request_id = ? AND status = 'offered'
               AND starts_at >= ? AND starts_at <= ? AND ends_at > starts_at
               AND EXISTS (
                 SELECT 1 FROM ppi_requests
                 WHERE id = ? AND status IN ('quote_sent','awaiting_time_selection') AND deleted_at IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM appointment_slots held
                 WHERE held.request_id = ? AND held.status = 'held'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM appointment_slots other
                 WHERE other.id != appointment_slots.id
                   -- Only a real reservation blocks. Offered windows, this
                   -- request's or another customer's, are invitations; the
                   -- first customer to reach this compare-and-swap wins, and
                   -- the loser is told the time was just taken.
                   AND other.status IN ('held','confirmed')
                   AND COALESCE(other.blocked_starts_at, other.starts_at) < COALESCE(appointment_slots.blocked_ends_at, appointment_slots.ends_at)
                   AND COALESCE(other.blocked_ends_at, other.ends_at) > COALESCE(appointment_slots.blocked_starts_at, appointment_slots.starts_at)
               )`,
          )
          .bind(holdUntil, nowIso(), slotId, requestId, earliest, latest, requestId, requestId)
          .run();
        if ((upd.meta?.changes ?? 0) !== 1) {
          return errorJson('slot_unavailable', 'That time is no longer available. Please pick another window.', 409);
        }
      } catch {
        // Partial unique index tripped: same start time already held/confirmed.
        return errorJson('slot_taken', 'That time was just taken. Please pick another window.', 409);
      }

      // A paid request whose original hold lapsed must never enter checkout a
      // second time. Selecting a replacement confirms it against the existing
      // succeeded payment and records the whole state change transactionally.
      if (paid?.booking_id) {
        const confirmedAt = nowIso();
        const results = await db.batch([
          db
            .prepare(
              `UPDATE appointment_slots SET status = 'confirmed', hold_expires_at = NULL, updated_at = ?
               WHERE id = ? AND request_id = ? AND status = 'held'
                 AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_time_selection')
                 AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status IN ('succeeded','partially_refunded'))
                 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND request_id = ? AND status = 'pending_payment')`,
            )
            .bind(confirmedAt, slotId, requestId, requestId, paid.id, paid.booking_id, requestId),
          db
            .prepare(
              `UPDATE bookings SET slot_id = ?, status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), updated_at = ?
               WHERE id = ? AND request_id = ? AND status = 'pending_payment'
                 AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_time_selection')
                 AND EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND status = 'confirmed')
                 AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status IN ('succeeded','partially_refunded'))`,
            )
            .bind(slotId, confirmedAt, confirmedAt, paid.booking_id, requestId, requestId, slotId, paid.id),
          db
            .prepare(
              `UPDATE ppi_requests SET status = 'confirmed', updated_at = ?
               WHERE id = ? AND status = 'awaiting_time_selection' AND deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status IN ('succeeded','partially_refunded'))
                 AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND request_id = ? AND slot_id = ? AND status = 'confirmed')
                 AND EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND status = 'confirmed')`,
            )
            .bind(confirmedAt, requestId, paid.id, paid.booking_id, requestId, slotId, slotId),
          db
            .prepare(
              `UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?
               AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'confirmed')`,
            )
            .bind(confirmedAt, quote.id, requestId),
          db
            .prepare(
              `UPDATE appointment_slots SET status = 'released', hold_expires_at = NULL, updated_at = ?
               WHERE request_id = ? AND id != ? AND status IN ('offered','held')
                 AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'confirmed')`,
            )
            .bind(confirmedAt, requestId, slotId, requestId),
          db
            .prepare(
              `INSERT OR IGNORE INTO status_history
                 (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
               SELECT ?, ?, 'awaiting_time_selection', 'confirmed', 'customer',
                      'Replacement time selected for existing payment', ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM bookings b JOIN appointment_slots s ON s.id = b.slot_id
                 WHERE b.id = ? AND b.status = 'confirmed' AND s.id = ? AND s.status = 'confirmed'
               )`,
            )
            .bind(`sh_paid_reselect_${paid.id}`, requestId, paid.id, confirmedAt, paid.booking_id, slotId),
        ]);
        const completed = [results[0], results[1], results[2]].every((result) => (result?.meta?.changes ?? 0) === 1);
        if (!completed) {
          return errorJson('conflict', 'This request changed a moment ago — reload to see its current booking state.', 409);
        }

        await db
          .prepare(`INSERT OR IGNORE INTO analytics_events (id, event, step, source, created_at) VALUES (?, 'ppi_booking_confirmed', 'paid_reselection', ?, ?)`)
          .bind(`ev_booking_${paid.id}`, req.attribution_source || 'ppi_unknown', confirmedAt)
          .run();

        const secureUrl = portalUrl((env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, ''), auth.token);
        await sendTemplate(env, db, requestId, 'appointment_confirmed', req.email, {
          ref: req.ref,
          portalUrl: secureUrl,
          supportEmail: config.supportEmail,
          extra: { slot: slot ? fmtSlot(slot.starts_at, config.scheduling.timezone) : '' },
        }, undefined, `appointment_confirmed:${paid.id}`);
        if (env.ADMIN_NOTIFY_EMAIL) {
          await sendTemplate(env, db, requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
            ref: req.ref,
            supportEmail: config.supportEmail,
            extra: {
              kind: 'BOOKING CONFIRMED AFTER PAID RESELECTION',
              detail: `${formatCents(paid.amount_cents)} already paid — ${slot ? fmtSlot(slot.starts_at, config.scheduling.timezone) : 'replacement time selected'}`,
              adminUrl: `${(env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, '')}/ppi/admin/?request=${encodeURIComponent(requestId)}`,
            },
          }, req.email, `owner_booking_confirmed:${paid.id}`);
        }
        return json({ ok: true, confirmed: true, paymentStatus: paid.status });
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
      if (status !== 'awaiting_agreement' && status !== 'awaiting_payment') {
        return errorJson('wrong_state', 'Agreements are not awaiting acceptance for this request.', 409);
      }
      const typedName = clampStr(body.typedName, 120);
      if (typedName.length < 2) return errorJson('validation', 'Please type your full name to accept.', 422);

      const required = await latestAgreements(db);
      const providedIds = (body.versionIds ?? []).map((v) => clampStr(v, 80));
      const provided = new Set(providedIds);
      const requiredIds = new Set(required.map((doc) => doc.id));
      const missing = required.filter((doc) => !provided.has(doc.id));
      const hasUnexpected = providedIds.length !== provided.size || [...provided].some((id) => !requiredIds.has(id));
      if (required.length === 0 || missing.length > 0 || hasUnexpected || provided.size !== required.length) {
        return errorJson('validation', `Please review and accept every current document (${missing.length} remaining).`, 422, {
          missing: missing.map((m) => m.title),
        });
      }

      const now = nowIso();
      const ip = clientIp(request);
      const ua = clampStr(request.headers.get('user-agent'), 300);
      const quote = await db
        .prepare(`SELECT id, expires_at FROM quotes WHERE request_id = ? AND status = 'sent' ORDER BY version DESC LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; expires_at: string }>();
      if (!quote) return errorJson('no_quote', 'There is no active quote for this request.', 409);
      if (quoteExpired(quote.expires_at)) {
        return errorJson('quote_expired', 'This quote has expired. AutoClarity will send you a refreshed quote.', 409);
      }
      const heldSlot = await db
        .prepare(`SELECT id FROM appointment_slots WHERE request_id = ? AND status = 'held' LIMIT 1`)
        .bind(requestId)
        .first<{ id: string }>();
      if (!heldSlot) {
        return errorJson('hold_lapsed', 'Your held appointment lapsed. AutoClarity will refresh the available times.', 409);
      }

      // A newly published agreement version can reach a customer who had
      // already advanced to awaiting_payment under the prior version. Let that
      // customer accept the current quote-bound set without releasing their
      // held appointment or fabricating acceptance during deployment.
      const existingAcceptances = await db
        .prepare(
          `SELECT agreement_version_id FROM agreement_acceptances
           WHERE request_id = ? AND quote_id = ? AND accepted = 1`,
        )
        .bind(requestId, quote.id)
        .all<{ agreement_version_id: string }>();
      const existingIds = new Set((existingAcceptances.results ?? []).map((row) => row.agreement_version_id));
      const documentsToAccept = required.filter((doc) => !existingIds.has(doc.id));
      if (documentsToAccept.length === 0) {
        return errorJson('wrong_state', 'The current agreements are already accepted for this quote.', 409);
      }

      const historyId = newId('sh');
      const acceptanceIds = documentsToAccept.map(() => newId('aa'));
      const acceptanceIdPlaceholders = acceptanceIds.map(() => '?').join(',');
      const results = await db.batch([
        ...documentsToAccept.map((doc, index) =>
          db
            .prepare(
              `INSERT INTO agreement_acceptances (id, request_id, quote_id, agreement_version_id, typed_name, accepted, ip, user_agent, created_at)
               SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM ppi_requests
                 WHERE id = ? AND status = ? AND deleted_at IS NULL
               )
                 AND EXISTS (SELECT 1 FROM quotes WHERE id = ? AND request_id = ? AND status = 'sent')
                 AND EXISTS (
                   SELECT 1 FROM agreement_versions av
                   WHERE av.id = ?
                     AND NOT EXISTS (
                       SELECT 1 FROM agreement_versions newer
                       WHERE newer.doc_key = av.doc_key AND newer.version > av.version
                     )
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM agreement_acceptances
                   WHERE request_id = ? AND quote_id = ? AND agreement_version_id = ? AND accepted = 1
                 )`,
            )
            .bind(
              acceptanceIds[index], requestId, quote.id, doc.id, typedName, ip, ua, now,
              requestId, status, quote.id, requestId, doc.id, requestId, quote.id, doc.id,
            ),
        ),
        db
          .prepare(
            `UPDATE ppi_requests SET status = 'awaiting_payment', updated_at = ?
             WHERE id = ? AND status = ? AND deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM quotes WHERE id = ? AND request_id = ? AND status = 'sent')
               AND EXISTS (SELECT 1 FROM appointment_slots WHERE request_id = ? AND status = 'held')
               AND (
                 SELECT COUNT(*) FROM agreement_acceptances
                 WHERE id IN (${acceptanceIdPlaceholders}) AND request_id = ? AND quote_id = ?
               ) = ?
               AND EXISTS (SELECT 1 FROM agreement_versions)
               AND NOT EXISTS (
                 SELECT 1
                 FROM agreement_versions av
                 JOIN (
                   SELECT doc_key, MAX(version) AS version
                   FROM agreement_versions GROUP BY doc_key
                 ) latest ON latest.doc_key = av.doc_key AND latest.version = av.version
                 WHERE NOT EXISTS (
                   SELECT 1 FROM agreement_acceptances accepted
                   WHERE accepted.request_id = ? AND accepted.quote_id = ?
                     AND accepted.agreement_version_id = av.id AND accepted.accepted = 1
                 )
              )`,
          )
          .bind(
            now, requestId, status, quote.id, requestId, requestId,
            ...acceptanceIds, requestId, quote.id, documentsToAccept.length,
            requestId, quote.id,
          ),
        db
          .prepare(
            `INSERT INTO status_history
               (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
             SELECT ?, ?, ?, 'awaiting_payment', 'customer', ?, ?, ?
             WHERE changes() = 1`,
          )
          .bind(
            historyId,
            requestId,
            status,
            status === 'awaiting_payment' ? 'Current agreement versions accepted' : 'All agreements accepted',
            quote.id,
            now,
          ),
      ]);
      const transitioned = (results[documentsToAccept.length]?.meta?.changes ?? 0) === 1;
      const historyRecorded = (results[documentsToAccept.length + 1]?.meta?.changes ?? 0) === 1;
      if (!transitioned || !historyRecorded) {
        return errorJson('conflict', 'This request changed before the agreements were accepted. Reload and review its current state.', 409);
      }
      return json({ ok: true });
    }

    // --------------------------------------------------------------- checkout
    case 'checkout': {
      const priorPayment = await db
        .prepare(
          `SELECT id FROM payments
           WHERE request_id = ? AND status IN ('succeeded','partially_refunded','refunded','disputed') LIMIT 1`,
        )
        .bind(requestId)
        .first<{ id: string }>();
      if (priorPayment) {
        return errorJson(
          'payment_already_received',
          'Payment has already been received for this request. No new charge was started; choose a replacement time or contact AutoClarity.',
          409,
        );
      }
      if (status !== 'awaiting_payment') {
        return errorJson('wrong_state', 'Payment is not available for this request yet.', 409);
      }

      const quote = await db
        .prepare(`SELECT id, expires_at, total_cents, currency FROM quotes WHERE request_id = ? AND status = 'sent' ORDER BY version DESC LIMIT 1`)
        .bind(requestId)
        .first<{ id: string; expires_at: string; total_cents: number; currency: string }>();
      if (!quote) return errorJson('no_quote', 'There is no active quote for this request.', 409);
      if (
        !Number.isSafeInteger(quote.total_cents)
        || quote.total_cents <= 0
        || quote.currency !== STRIPE_CHECKOUT_CURRENCY
      ) {
        return errorJson('quote_reconciliation_required', 'The approved quote amount or currency requires support review before payment.', 409);
      }
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

      const required = await latestAgreements(db);
      const acceptedLatest = required.length > 0
        ? await db
            .prepare(
              `SELECT CASE WHEN ${LATEST_QUOTE_AGREEMENTS_ACCEPTED_SQL} THEN 1 ELSE 0 END AS ok`,
            )
            .bind(requestId, quote.id)
            .first<{ ok: number }>()
        : null;
      if (required.length === 0 || acceptedLatest?.ok !== 1) {
        return errorJson('agreements_missing', 'Please accept the service agreements first.', 409);
      }

      if (!flags.paymentsEnabled) {
        return errorJson(
          'payments_unavailable',
          'Online payment is currently unavailable. Contact AutoClarity to finish scheduling; no charge was started.',
          503,
          { paymentsDisabled: true },
        );
      }

      // Booking row (one per request) — created/reused before the session.
      const now = nowIso();
      let booking = await db
        .prepare(`SELECT id, quote_id FROM bookings WHERE request_id = ?`)
        .bind(requestId)
        .first<{ id: string; quote_id: string }>();
      if (!booking) {
        const bookingId = newId('bkg');
        try {
          await db
            .prepare(
              `INSERT INTO bookings (id, request_id, quote_id, slot_id, status, created_at, updated_at)
               SELECT ?, ?, ?, ?, 'pending_payment', ?, ?
               WHERE EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_payment')
                 AND EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND request_id = ? AND status = 'held')`,
            )
            .bind(bookingId, requestId, quote.id, slot.id, now, now, requestId, slot.id, requestId)
            .run();
        } catch {
          // A concurrent checkout may have created the one-per-request row.
        }
        booking = await db
          .prepare(`SELECT id, quote_id FROM bookings WHERE request_id = ?`)
          .bind(requestId)
          .first<{ id: string; quote_id: string }>();
        if (!booking) {
          return errorJson('conflict', 'This request changed before checkout could start. Reload before trying again.', 409);
        }
      } else {
        // The request owns one booking across refreshed quotes. Rebind it only
        // after every older attempt is provider-terminal; each old payment row
        // keeps its original quote/session/amount identity as evidence.
        const bookingUpdate = await db
          .prepare(
            `UPDATE bookings SET quote_id = ?, slot_id = ?, status = 'pending_payment', updated_at = ?
             WHERE id = ?
               AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_payment')
               AND EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND request_id = ? AND status = 'held')
               AND (
                 quote_id = ?
                 OR NOT EXISTS (
                   SELECT 1 FROM payments prior_attempt
                   WHERE prior_attempt.booking_id = bookings.id
                     AND prior_attempt.status NOT IN ('failed','expired')
                 )
               )`,
          )
          .bind(quote.id, slot.id, now, booking.id, requestId, slot.id, requestId, quote.id)
          .run();
        if ((bookingUpdate.meta?.changes ?? 0) !== 1) {
          const blockingAttempt = booking.quote_id !== quote.id
            ? await db
                .prepare(
                  `SELECT id FROM payments
                   WHERE booking_id = ? AND status NOT IN ('failed','expired') LIMIT 1`,
                )
                .bind(booking.id)
                .first<{ id: string }>()
            : null;
          if (blockingAttempt) {
            return errorJson(
              'payment_reconciliation_required',
              'The prior Checkout attempt must be verified as expired or failed before this refreshed quote can open. No new charge was started.',
              409,
            );
          }
          return errorJson('conflict', 'This request changed before checkout could start. Reload before trying again.', 409);
        }
      }

      type AttemptRow = {
        id: string;
        status: string;
        stripe_session_id: string | null;
        checkout_attempt: number | null;
        amount_cents: number;
        currency: string;
        created_at: string;
      };
      let claim: AttemptRow | null = null;
      let claimWasPending = false;
      try {
        const attempts = await db
          .prepare(
            `SELECT id, status, stripe_session_id, checkout_attempt, amount_cents, currency, created_at
             FROM payments WHERE request_id = ? AND quote_id = ? AND booking_id = ?
             ORDER BY created_at DESC`,
          )
          .bind(requestId, quote.id, booking.id)
          .all<AttemptRow>();
        const rows = attempts.results ?? [];
        if (rows.some((row) => row.amount_cents !== quote.total_cents || row.currency !== quote.currency)) {
          return errorJson(
            'payment_reconciliation_required',
            'A prior payment record does not match the approved quote. No new charge was started.',
            409,
          );
        }
        const active = rows.filter((row) => row.status === 'created' || row.status === 'pending');
        if (active.length > 1) {
          return errorJson(
            'payment_reconciliation_required',
            'Multiple checkout attempts need provider verification. No new charge was started; contact AutoClarity.',
            409,
          );
        }

        const existing = active[0];
        if (existing) {
          const createdMs = Date.parse(existing.created_at);
          if (
            !existing.checkout_attempt ||
            !Number.isFinite(createdMs) ||
            Date.now() - createdMs >= 30 * 60_000
          ) {
            return errorJson(
              'payment_reconciliation_required',
              'A prior Checkout Session needs provider verification. No new charge was started.',
              409,
            );
          }
          if (existing.status === 'created' && !existing.stripe_session_id) {
            return errorJson(
              'payment_reconciliation_required',
              'A prior Checkout Session needs provider verification. No new charge was started.',
              409,
            );
          }
          claim = existing;
          claimWasPending = existing.status === 'pending';
        } else {
          const reusable = rows.find(
            (row) => row.status === 'failed' && !row.stripe_session_id && Number.isInteger(row.checkout_attempt),
          );
          if (reusable) {
            const reclaimed = await db
              .prepare(
                `UPDATE payments SET status = 'pending', updated_at = ?
                 WHERE id = ? AND status = 'failed' AND stripe_session_id IS NULL
                   AND amount_cents = ? AND currency = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM payments other
                     WHERE other.request_id = ? AND other.status IN ('created','pending')
                   )
                   AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_payment')
                   AND ${LATEST_QUOTE_AGREEMENTS_ACCEPTED_SQL}`,
              )
              .bind(
                nowIso(), reusable.id, quote.total_cents, quote.currency,
                requestId, requestId, requestId, quote.id,
              )
              .run();
            if ((reclaimed.meta?.changes ?? 0) !== 1) {
              return errorJson('payment_reconciliation_required', 'Another checkout attempt started first. No new charge was started.', 409);
            }
            claim = { ...reusable, status: 'pending' };
          } else {
            const attempt = Math.max(0, ...rows.map((row) => row.checkout_attempt ?? 0)) + 1;
            const paymentId = newId('pay');
            const inserted = await db
              .prepare(
                `INSERT INTO payments
                   (id, request_id, quote_id, booking_id, amount_cents, currency, status, checkout_attempt, created_at, updated_at)
                 SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
                 WHERE EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_payment')
                   AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND request_id = ? AND slot_id = ? AND status = 'pending_payment')
                   AND EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND request_id = ? AND status = 'held')
                   AND ${LATEST_QUOTE_AGREEMENTS_ACCEPTED_SQL}
                   AND NOT EXISTS (
                     SELECT 1 FROM payments other
                     WHERE other.request_id = ? AND other.status IN ('created','pending','succeeded','partially_refunded','refunded','disputed')
                   )`,
              )
              .bind(
                paymentId,
                requestId,
                quote.id,
                booking.id,
                quote.total_cents,
                quote.currency,
                attempt,
                now,
                now,
                requestId,
                booking.id,
                requestId,
                slot.id,
                slot.id,
                requestId,
                requestId,
                quote.id,
                requestId,
              )
              .run();
            if ((inserted.meta?.changes ?? 0) !== 1) {
              return errorJson('payment_reconciliation_required', 'This request changed or another checkout started first. No new charge was started.', 409);
            }
            claim = {
              id: paymentId,
              status: 'pending',
              stripe_session_id: null,
              checkout_attempt: attempt,
              amount_cents: quote.total_cents,
              currency: quote.currency,
              created_at: now,
            };
          }
          claimWasPending = true;
        }

        // The durable pending row above is the cancellation gate. Only after
        // it is visible do we make the provider call.
        const extended = new Date(Date.now() + Math.max(config.scheduling.holdMinutes, 45) * 60_000).toISOString();
        const extendedHold = await db
          .prepare(
            `UPDATE appointment_slots SET hold_expires_at = ?, updated_at = ?
             WHERE id = ? AND request_id = ? AND status = 'held'
               AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_payment')
               AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status IN ('pending','created'))
               AND ${LATEST_QUOTE_AGREEMENTS_ACCEPTED_SQL}`,
          )
          .bind(extended, nowIso(), slot.id, requestId, requestId, claim.id, requestId, quote.id)
          .run();
        if ((extendedHold.meta?.changes ?? 0) !== 1) {
          if (claimWasPending) {
            await db.prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'`).bind(nowIso(), claim.id).run();
          }
          return errorJson('conflict', 'The held time or request changed before Checkout could start.', 409);
        }

        const session = await createCheckoutSession(env, {
          requestId,
          requestRef: req.ref,
          quoteId: quote.id,
          bookingId: booking.id,
          amountCents: quote.total_cents,
          currency: quote.currency,
          customerEmail: req.email,
          publicBaseUrl: env.PUBLIC_BASE_URL ?? new URL(request.url).origin,
          attempt: claim.checkout_attempt ?? 1,
        });
        if (!session.id.startsWith('cs_') || !session.url.startsWith('http')) {
          throw new Error('Stripe returned a malformed Checkout Session.');
        }

        // Persist the provider id even before the validity CAS. If request
        // state was lost, cancellation/reconciliation can still see and expire
        // the exact payable Session.
        if (claimWasPending) {
          const recorded = await db
            .prepare(
              `UPDATE payments SET stripe_session_id = ?, updated_at = ?
               WHERE id = ? AND status = 'pending'
                 AND (stripe_session_id IS NULL OR stripe_session_id = ?)`,
            )
            .bind(session.id, nowIso(), claim.id, session.id)
            .run();
          if ((recorded.meta?.changes ?? 0) !== 1) {
            throw new Error('Checkout claim changed before its provider Session could be recorded.');
          }
        } else if (claim.stripe_session_id !== session.id) {
          try { await expireCheckoutSession(env, session.id); } catch { /* retained below as reconciliation */ }
          return errorJson('payment_reconciliation_required', 'Stripe returned a different Session for an existing attempt. Contact AutoClarity.', 409);
        }

        const finalized = await db
          .prepare(
            `UPDATE payments SET status = 'created', updated_at = ?
             WHERE id = ? AND status IN ('pending','created') AND stripe_session_id = ?
               AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_payment')
               AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND request_id = ? AND slot_id = ? AND status = 'pending_payment')
               AND EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND request_id = ? AND status = 'held')
               AND ${LATEST_QUOTE_AGREEMENTS_ACCEPTED_SQL}`,
          )
          .bind(
            nowIso(), claim.id, session.id, requestId,
            booking.id, requestId, slot.id, slot.id, requestId,
            requestId, quote.id,
          )
          .run();
        if ((finalized.meta?.changes ?? 0) !== 1) {
          try {
            await expireCheckoutSession(env, session.id);
            await db
              .prepare(`UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('pending','created')`)
              .bind(nowIso(), claim.id)
              .run();
            return errorJson('checkout_state_changed', 'The request changed before Checkout finished, so the payment Session was expired.', 409);
          } catch (expiryError) {
            console.error('checkout_lost_cas_expiry_failed', claim.id, String(expiryError).slice(0, 240));
            return errorJson('payment_reconciliation_required', 'The request changed while Checkout was opening. The payment Session requires support review.', 502);
          }
        }
        return json({ ok: true, checkoutUrl: session.url });
      } catch (e) {
        // Only a pre-network configuration failure or explicit Stripe 4xx is
        // definitive. A timeout/5xx/malformed success may have created a live
        // Session, so leave the durable pending claim resumable with the same
        // idempotency key and keep cancellation fail-closed.
        const definitelyFailed = e instanceof StripeConfigError
          || (e instanceof StripeApiError && e.definitiveFailure);
        if (claimWasPending && claim && definitelyFailed) {
          await db
            .prepare(`UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending' AND stripe_session_id IS NULL`)
            .bind(nowIso(), claim.id)
            .run();
        }
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
          extra: { kind: 'customer message', detail: text.slice(0, 300), adminUrl: `${(env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, '')}/ppi/admin/?request=${encodeURIComponent(requestId)}` },
        }, req.email);
      }
      return json({ ok: true });
    }

    // ----------------------------------------------------------------- cancel
    case 'cancel': {
      const reason = clampStr(body.reason, 500);
      const paid = await db
        .prepare(`SELECT id FROM payments WHERE request_id = ? AND status IN ('succeeded','partially_refunded','refunded','disputed') LIMIT 1`)
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
        const checkoutExpiry = await expireOpenCheckoutAttempts(env, requestId);
        if (!checkoutExpiry.ok) {
          return errorJson(
            checkoutExpiry.code,
            'Cancellation was not applied because an open payment attempt could not be proven expired. Contact AutoClarity; no second payment attempt was started.',
            checkoutExpiry.code === 'payments_unavailable' ? 503 : 409,
          );
        }
        const cancelled = await applyTerminalLifecycle(db, {
          requestId,
          to: 'customer_cancelled',
          actor: 'customer',
          reason: reason || 'Customer cancelled before payment',
          relatedId: requestId,
        });
        if (!cancelled.ok) {
          return cancelled.blockedByOpenPaymentClaim
            ? errorJson(
                'reconciliation_required',
                'A Checkout attempt started while cancellation was being applied. The request remains active; contact AutoClarity before trying again.',
                409,
              )
            : errorJson('conflict', 'This request changed while cancellation was being applied. Reload before trying again.', 409);
        }
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
            adminUrl: `${(env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, '')}/ppi/admin/?request=${encodeURIComponent(requestId)}`,
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
