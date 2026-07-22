// /api/admin/requests/:id — GET full detail; POST admin actions.
// Every mutation is authorized, state-machine-checked, and audit-logged.

import type { Env } from '../../../lib/types.ts';
import { modeFlags } from '../../../lib/types.ts';
import { requireAdmin, auditLog } from '../../../lib/auth.ts';
import { getConfig } from '../../../lib/config.ts';
import { applyStatus, isStatus, canTransition, STATUS_LABELS, type Status } from '../../../lib/status.ts';
import { basePriceForTier, computeQuoteTotals, quoteExpiry, travelFeeForMiles, type QuoteLineInput, type Tier } from '../../../lib/pricing.ts';
import { issueMagicLink, portalUrl } from '../../../lib/magic.ts';
import { sendTemplate, type EmailTemplateKey } from '../../../lib/email.ts';
import { createRefund, StripeConfigError } from '../../../lib/stripe.ts';
import { releaseExpiredHolds } from '../../../lib/portal.ts';
import { clampStr, errorJson, formatCents, json, newId, nowIso } from '../../../lib/util.ts';

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

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  const id = String(context.params['id'] ?? '');
  await releaseExpiredHolds(db);

  const req = await db
    .prepare(
      `SELECT r.*, c.full_name, c.email, c.phone, c.preferred_contact, c.marketing_consent,
              v.year, v.make, v.model, v.trim AS vehicle_trim, v.mileage, v.vin, v.vin_decoded_json,
              v.asking_price_cents, v.expected_price_cents, v.listing_url, v.mod_status,
              v.warning_lights, v.known_issues, v.title_status, v.starts_drives
       FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!req) return errorJson('not_found', 'Request not found.', 404);

  const [quotes, lines, slots, uploads, history, messagesRows, payments, acceptances] = await Promise.all([
    db.prepare(`SELECT * FROM quotes WHERE request_id = ? ORDER BY version DESC`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT l.* FROM quote_line_items l JOIN quotes q ON q.id = l.quote_id WHERE q.request_id = ? ORDER BY l.sort`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM appointment_slots WHERE request_id = ? ORDER BY starts_at`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT id, original_name, content_type, size_bytes, kind, created_at FROM request_uploads WHERE request_id = ? AND deleted_at IS NULL`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM status_history WHERE request_id = ? ORDER BY created_at DESC`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM messages WHERE request_id = ? ORDER BY created_at DESC LIMIT 100`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM payments WHERE request_id = ? ORDER BY created_at DESC`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT a.*, av.doc_key, av.title, av.version AS doc_version FROM agreement_acceptances a JOIN agreement_versions av ON av.id = a.agreement_version_id WHERE a.request_id = ?`).bind(id).all<Record<string, unknown>>(),
  ]);

  const status = String(req['status']);
  return json({
    request: req,
    statusLabel: isStatus(status) ? STATUS_LABELS[status] : status,
    allowedTransitions: isStatus(status)
      ? (Object.keys(STATUS_LABELS) as Status[]).filter((s) => canTransition(status, s))
      : [],
    quotes: quotes.results ?? [],
    quoteLines: lines.results ?? [],
    slots: slots.results ?? [],
    uploads: uploads.results ?? [],
    history: history.results ?? [],
    messages: messagesRows.results ?? [],
    payments: payments.results ?? [],
    acceptances: acceptances.results ?? [],
  });
};

interface AdminActionBody {
  action?: string;
  to?: string;
  reason?: string;
  note?: string;
  internalNotes?: string;
  tier?: string;
  basePriceCents?: number;
  travelCents?: number;
  addons?: Array<{ label?: string; amountCents?: number }>;
  discountCents?: number;
  discountLabel?: string;
  customerNote?: string;
  adminNote?: string;
  expiresHours?: number;
  quoteId?: string;
  slots?: string[];
  slotId?: string;
  paymentId?: string;
  amountCents?: number;
  uploadId?: string;
  emailTemplate?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  const { env } = context;
  const db = env.DB;
  const actor = auth.actor;
  const id = String(context.params['id'] ?? '');
  const config = await getConfig(db);
  const flags = modeFlags(env);

  let body: AdminActionBody;
  try {
    body = (await context.request.json()) as AdminActionBody;
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }

  const req = await db
    .prepare(
      `SELECT r.id, r.ref, r.status, r.travel_miles, c.email, c.full_name FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(id)
    .first<{ id: string; ref: string; status: string; travel_miles: number | null; email: string; full_name: string }>();
  if (!req || !isStatus(req.status)) return errorJson('not_found', 'Request not found.', 404);
  const status = req.status as Status;
  const base = (env.PUBLIC_BASE_URL ?? new URL(context.request.url).origin).replace(/\/$/, '');

  switch (body.action) {
    // ------------------------------------------------------------- set_status
    case 'set_status': {
      const to = String(body.to ?? '');
      if (!isStatus(to)) return errorJson('validation', 'Unknown status.', 422);
      if (!canTransition(status, to)) {
        return errorJson('invalid_transition', `Cannot move from ${STATUS_LABELS[status]} to ${STATUS_LABELS[to]}.`, 409);
      }
      const moved = await applyStatus(db, id, status, to, actor, clampStr(body.reason, 300) || 'Admin status change');
      if (!moved) return errorJson('conflict', 'Status changed concurrently — reload and retry.', 409);
      await auditLog(db, actor, 'set_status', 'ppi_request', id, { from: status, to, reason: body.reason });

      // Courtesy emails for the customer-facing waiting states.
      const templateByStatus: Partial<Record<Status, EmailTemplateKey>> = {
        needs_info: 'needs_info',
        seller_access_pending: 'seller_access',
        customer_cancelled: 'cancellation_confirmed',
        admin_cancelled: 'cancellation_confirmed',
      };
      const template = templateByStatus[to];
      if (template) {
        const { token } = await issueMagicLink(db, id, config);
        await sendTemplate(env, db, id, template, req.email, {
          ref: req.ref,
          portalUrl: portalUrl(base, token),
          supportEmail: config.supportEmail,
          extra: { note: clampStr(body.note, 1000) },
        });
      }
      return json({ ok: true });
    }

    // -------------------------------------------------------------- set_notes
    case 'set_notes': {
      await db
        .prepare(`UPDATE ppi_requests SET internal_notes = ?, updated_at = ? WHERE id = ?`)
        .bind(clampStr(body.internalNotes, 4000), nowIso(), id)
        .run();
      await auditLog(db, actor, 'set_notes', 'ppi_request', id);
      return json({ ok: true });
    }

    // ----------------------------------------------------------- create_quote
    case 'create_quote': {
      if (!(['ready_for_review', 'quote_prepared', 'quote_sent', 'awaiting_time_selection', 'submitted', 'needs_info', 'seller_access_pending'] as Status[]).includes(status)) {
        return errorJson('wrong_state', 'Quotes cannot be created for this request in its current status.', 409);
      }
      const tier = String(body.tier ?? '') as Tier;
      if (!['standard', 'euro_luxury_performance', 'exotic_collector'].includes(tier)) {
        return errorJson('validation', 'Choose a valid package tier.', 422);
      }

      const tierBase = basePriceForTier(tier, config);
      const baseCents = Number.isInteger(body.basePriceCents) && (body.basePriceCents as number) > 0
        ? (body.basePriceCents as number)
        : tierBase.priceCents;

      let travelCents = Number.isInteger(body.travelCents) && (body.travelCents as number) >= 0 ? (body.travelCents as number) : null;
      if (travelCents === null) {
        const suggestion = req.travel_miles !== null ? travelFeeForMiles(req.travel_miles, config) : { feeCents: null };
        travelCents = suggestion.feeCents ?? 0;
      }

      const lines: QuoteLineInput[] = [
        { kind: 'base', label: `${config.pricing.tiers[tier].label}${tierBase.promoApplied && baseCents === tierBase.priceCents ? ' (launch price)' : ''}`, amountCents: baseCents },
      ];
      if (travelCents > 0) lines.push({ kind: 'travel', label: 'Mobile-service charge', amountCents: travelCents });
      for (const addon of body.addons ?? []) {
        const label = clampStr(addon.label, 120);
        const cents = Number(addon.amountCents);
        if (label && Number.isInteger(cents) && cents > 0 && cents <= 500000) {
          lines.push({ kind: 'addon', label, amountCents: cents });
        }
      }
      const discount = Number(body.discountCents);
      if (Number.isInteger(discount) && discount > 0) {
        lines.push({ kind: 'discount', label: clampStr(body.discountLabel, 120) || 'Discount', amountCents: -discount });
      }

      let totals;
      try {
        totals = computeQuoteTotals(lines);
      } catch {
        return errorJson('validation', 'Quote total cannot be negative.', 422);
      }

      const versionRow = await db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM quotes WHERE request_id = ?`)
        .bind(id)
        .first<{ v: number }>();
      const version = (versionRow?.v ?? 0) + 1;
      const now = nowIso();
      const quoteId = newId('qot');
      const expiresHours = Number.isInteger(body.expiresHours) && (body.expiresHours as number) > 0 ? (body.expiresHours as number) : config.quotes.expiryHours;
      const expiresAt = new Date(Date.now() + expiresHours * 3600_000).toISOString();

      await db.batch([
        db.prepare(`UPDATE quotes SET status = 'superseded', updated_at = ? WHERE request_id = ? AND status IN ('draft','sent')`).bind(now, id),
        db
          .prepare(
            `INSERT INTO quotes (id, request_id, version, status, tier, subtotal_cents, travel_cents, addons_cents, discount_cents, total_cents,
                                 expires_at, admin_note_internal, customer_note, approved_by, created_at, updated_at)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            quoteId, id, version, tier,
            totals.subtotalCents, totals.travelCents, totals.addonsCents, totals.discountCents, totals.totalCents,
            expiresAt, clampStr(body.adminNote, 2000) || null, clampStr(body.customerNote, 2000) || null, actor, now, now,
          ),
        ...lines.map((l, i) =>
          db
            .prepare(`INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(newId('qli'), quoteId, l.kind, l.label, l.amountCents, i),
        ),
      ]);

      if (status !== 'quote_prepared') {
        // Walk the request into quote_prepared through legal intermediate steps.
        if (canTransition(status, 'quote_prepared')) {
          await applyStatus(db, id, status, 'quote_prepared', actor, `Quote v${version} prepared`, quoteId);
        } else if (canTransition(status, 'ready_for_review')) {
          await applyStatus(db, id, status, 'ready_for_review', actor, 'Moving to review for quoting');
          await applyStatus(db, id, 'ready_for_review', 'quote_prepared', actor, `Quote v${version} prepared`, quoteId);
        }
      }
      await auditLog(db, actor, 'create_quote', 'quote', quoteId, { version, totalCents: totals.totalCents, tier });
      return json({ ok: true, quoteId, version, totalCents: totals.totalCents, expiresAt });
    }

    // ------------------------------------------------------------- send_quote
    case 'send_quote': {
      const quote = await db
        .prepare(`SELECT id, version, total_cents, expires_at FROM quotes WHERE id = ? AND request_id = ? AND status = 'draft'`)
        .bind(clampStr(body.quoteId, 60), id)
        .first<{ id: string; version: number; total_cents: number; expires_at: string }>();
      if (!quote) return errorJson('not_found', 'Draft quote not found.', 404);
      if (status !== 'quote_prepared') return errorJson('wrong_state', 'Prepare the quote first.', 409);

      const now = nowIso();
      await db.prepare(`UPDATE quotes SET status = 'sent', updated_at = ? WHERE id = ?`).bind(now, quote.id).run();
      await applyStatus(db, id, 'quote_prepared', 'quote_sent', actor, `Quote v${quote.version} sent`, quote.id);

      const { token } = await issueMagicLink(db, id, config);
      await sendTemplate(env, db, id, 'quote_ready', req.email, {
        ref: req.ref,
        portalUrl: portalUrl(base, token),
        supportEmail: config.supportEmail,
        extra: {
          summary: `Total: ${formatCents(quote.total_cents)}`,
          expires: new Date(quote.expires_at).toLocaleString('en-US', { timeZone: config.scheduling.timezone }),
        },
      });
      await db
        .prepare(`INSERT INTO analytics_events (id, event, step, source, created_at) VALUES (?, 'ppi_quote_sent', NULL, 'admin', ?)`)
        .bind(newId('ev'), now)
        .run();
      await auditLog(db, actor, 'send_quote', 'quote', quote.id);
      return json({ ok: true });
    }

    // ---------------------------------------------------------- propose_slots
    case 'propose_slots': {
      if (!flags.bookingEnabled) return errorJson('booking_disabled', 'Booking is disabled in this environment.', 409);
      const slotsIn = (body.slots ?? []).slice(0, 5);
      if (slotsIn.length === 0) return errorJson('validation', 'Provide at least one slot start time (ISO).', 422);
      const now = nowIso();
      const inserted: string[] = [];
      const skipped: string[] = [];
      for (const startRaw of slotsIn) {
        const start = new Date(String(startRaw));
        if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() + config.scheduling.minLeadHours * 3600_000 - 60_000) {
          skipped.push(`${startRaw} (past or under ${config.scheduling.minLeadHours}h lead)`);
          continue;
        }
        const end = new Date(start.getTime() + config.scheduling.durationMin * 60_000);
        // Conflict check against confirmed/held slots including buffers.
        const bufferMs = (config.scheduling.travelBufferMin + config.scheduling.reportBufferMin) * 60_000;
        const clash = await db
          .prepare(
            `SELECT id FROM appointment_slots WHERE status IN ('held','confirmed')
             AND starts_at < ? AND ends_at > ? LIMIT 1`,
          )
          .bind(new Date(end.getTime() + bufferMs).toISOString(), new Date(start.getTime() - bufferMs).toISOString())
          .first<{ id: string }>();
        if (clash) {
          skipped.push(`${startRaw} (conflicts with an existing appointment incl. buffers)`);
          continue;
        }
        const slotId = newId('slt');
        await db
          .prepare(
            `INSERT INTO appointment_slots (id, request_id, starts_at, ends_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'offered', ?, ?)`,
          )
          .bind(slotId, id, start.toISOString(), end.toISOString(), now, now)
          .run();
        inserted.push(slotId);
      }
      if (inserted.length > 0) {
        const { token } = await issueMagicLink(db, id, config);
        const slotRows = await db
          .prepare(`SELECT starts_at FROM appointment_slots WHERE request_id = ? AND status = 'offered' ORDER BY starts_at`)
          .bind(id)
          .all<{ starts_at: string }>();
        await sendTemplate(env, db, id, 'slots_offered', req.email, {
          ref: req.ref,
          portalUrl: portalUrl(base, token),
          supportEmail: config.supportEmail,
          extra: { slots: (slotRows.results ?? []).map((s) => `• ${fmtSlot(s.starts_at, config.scheduling.timezone)}`).join('\n') },
        });
      }
      await auditLog(db, actor, 'propose_slots', 'ppi_request', id, { inserted, skipped });
      return json({ ok: true, inserted: inserted.length, skipped });
    }

    // ------------------------------------------------------------ release_slot
    case 'release_slot': {
      const upd = await db
        .prepare(`UPDATE appointment_slots SET status = 'released', hold_expires_at = NULL, updated_at = ? WHERE id = ? AND request_id = ? AND status IN ('offered','held')`)
        .bind(nowIso(), clampStr(body.slotId, 60), id)
        .run();
      if ((upd.meta?.changes ?? 0) !== 1) return errorJson('not_found', 'Slot not found or not releasable.', 404);
      await auditLog(db, actor, 'release_slot', 'appointment_slot', clampStr(body.slotId, 60));
      return json({ ok: true });
    }

    // ------------------------------------------------------------ send_message
    case 'send_message': {
      const note = clampStr(body.note, 2000);
      if (note.length < 2) return errorJson('validation', 'Message is empty.', 422);
      const now = nowIso();
      await db
        .prepare(
          `INSERT INTO messages (id, request_id, direction, channel, body_text, status, created_at)
           VALUES (?, ?, 'outbound', 'portal', ?, 'recorded', ?)`,
        )
        .bind(newId('msg'), id, note, now)
        .run();
      const { token } = await issueMagicLink(db, id, config);
      await sendTemplate(env, db, id, 'needs_info', req.email, {
        ref: req.ref,
        portalUrl: portalUrl(base, token),
        supportEmail: config.supportEmail,
        extra: { note },
      });
      await auditLog(db, actor, 'send_message', 'ppi_request', id);
      return json({ ok: true });
    }

    // ----------------------------------------------------------------- refund
    case 'refund': {
      const payment = await db
        .prepare(`SELECT id, stripe_payment_intent, amount_cents, refunded_cents, status FROM payments WHERE id = ? AND request_id = ?`)
        .bind(clampStr(body.paymentId, 60), id)
        .first<{ id: string; stripe_payment_intent: string | null; amount_cents: number; refunded_cents: number; status: string }>();
      if (!payment) return errorJson('not_found', 'Payment not found.', 404);
      if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
        return errorJson('wrong_state', 'Only succeeded payments can be refunded.', 409);
      }
      if (!payment.stripe_payment_intent) return errorJson('wrong_state', 'No payment intent recorded.', 409);
      const amount = Number.isInteger(body.amountCents) && (body.amountCents as number) > 0 ? (body.amountCents as number) : undefined;
      if (amount !== undefined && amount > payment.amount_cents - payment.refunded_cents) {
        return errorJson('validation', 'Refund exceeds the remaining refundable amount.', 422);
      }
      try {
        await createRefund(env, payment.stripe_payment_intent, amount);
      } catch (e) {
        if (e instanceof StripeConfigError) return errorJson('payments_unavailable', 'Payments are not configured in this environment.', 503);
        return errorJson('refund_failed', `Stripe refund failed: ${String(e).slice(0, 200)}`, 502);
      }
      // The charge.refunded webhook is the source of truth for the final state.
      await auditLog(db, actor, 'refund_requested', 'payment', payment.id, { amountCents: amount ?? 'full' });
      return json({ ok: true, note: 'Refund submitted — status updates when Stripe confirms via webhook.' });
    }

    // ------------------------------------------------------------ reissue_link
    case 'reissue_link': {
      const { token, expiresAt } = await issueMagicLink(db, id, config);
      await auditLog(db, actor, 'reissue_link', 'ppi_request', id);
      return json({ ok: true, url: portalUrl(base, token), expiresAt });
    }

    // ----------------------------------------------------------- delete_upload
    case 'delete_upload': {
      const upload = await db
        .prepare(`SELECT id, object_key FROM request_uploads WHERE id = ? AND request_id = ? AND deleted_at IS NULL`)
        .bind(clampStr(body.uploadId, 60), id)
        .first<{ id: string; object_key: string }>();
      if (!upload) return errorJson('not_found', 'Upload not found.', 404);
      await env.UPLOADS.delete(upload.object_key);
      await db.prepare(`UPDATE request_uploads SET deleted_at = ? WHERE id = ?`).bind(nowIso(), upload.id).run();
      await auditLog(db, actor, 'delete_upload', 'request_upload', upload.id);
      return json({ ok: true });
    }

    default:
      return errorJson('unknown_action', 'Unsupported action.', 400);
  }
};
