// /api/admin/requests/:id — GET full detail; POST admin actions.
// Every mutation is authorized, state-machine-checked, and audit-logged.

import { appointmentDateError, appointmentDays, sundayEligible, type SellerLocation } from '../../../lib/appointment-eligibility.ts';
import { discoveryLabel } from '../../../lib/discovery.ts';
import type { Env } from '../../../lib/types.ts';
import { modeFlags } from '../../../lib/types.ts';
import { requireAdmin, auditLog } from '../../../lib/auth.ts';
import { getConfig } from '../../../lib/config.ts';
import { applyStatus, isStatus, canTransition, STATUS_LABELS, type Status } from '../../../lib/status.ts';
import { completeWithPublishedReport, type PublishedReportVersion } from '../../../lib/published-report.ts';
import { basePriceForTier, computeQuoteTotals, quoteExpiry, travelFeeForMiles, type QuoteLineInput, type Tier } from '../../../lib/pricing.ts';
import { isTier, suggestTier, tierMismatch } from '../../../lib/vehicle-class.ts';
import { isRecordKind, testRecordReason } from '../../../lib/record-kind.ts';
import { buildPriceBreakdown, type PriceBreakdown } from '../../../lib/quote-math.ts';
import {
  defaultProposalMessage,
  findProposalByKey,
  latestProposal,
  newProposalId,
  recordProposalNotification,
  travelSentence,
  validateSlotTimes,
  hasSameDaySlot,
  MAX_OFFERED_SLOTS,
  manualSlotOfferError,
  type BookingProposalRow,
  type SlotCandidate,
} from '../../../lib/booking-proposal.ts';
import { issueMagicLink, portalUrl } from '../../../lib/magic.ts';
import { retryStoredEmail, sendTemplate, type EmailResult, type EmailStatus, type EmailTemplateKey, type StoredEmailMessage } from '../../../lib/email.ts';
import { persistNotificationIssue, resolveNotificationActionIssues } from '../../../lib/notification-issues.ts';
import { classifyStripeRefundStatus, createRefund, StripeConfigError, type StripeRefundProviderStatus } from '../../../lib/stripe.ts';
import { releaseExpiredHolds } from '../../../lib/portal.ts';
import { applyTerminalLifecycle } from '../../../lib/lifecycle.ts';
import { expireOpenCheckoutAttempts } from '../../../lib/payment-lifecycle.ts';
import { upsertProviderRefund, validateStripeRefundIdentity } from '../../../lib/refunds.ts';
import { clampStr, errorJson, formatCents, json, newId, nowIso, originAllowed } from '../../../lib/util.ts';
import { readJsonBody, requestBodyErrorResponse } from '../../../lib/request-body.ts';

const GENERIC_STATUS_BLOCKED = new Set<Status>(['refunded', 'refund_reconciliation_needed', 'disputed', 'customer_cancelled']);
const AWAITING_PAYMENT_BACKWARD_BLOCKED = new Set<Status>(['awaiting_agreement', 'awaiting_time_selection']);

function genericStatusAllowed(from: Status, to: Status): boolean {
  return !GENERIC_STATUS_BLOCKED.has(to)
    && !(from === 'awaiting_payment' && AWAITING_PAYMENT_BACKWARD_BLOCKED.has(to));
}

type RefundOperationStatus =
  | 'requested'
  | 'pending'
  | 'provider_accepted'
  | 'requires_action'
  | 'confirmed'
  | 'failed'
  | 'canceled'
  | 'reconciliation_required';

interface RefundOperationRow {
  id: string;
  payment_id: string;
  request_id: string;
  starting_refunded_cents: number;
  requested_amount_cents: number;
  idempotency_key: string;
  status: RefundOperationStatus;
  attempt_count: number;
  provider_refund_id: string | null;
}

function refundOutcome(providerStatus: StripeRefundProviderStatus, providerId: string | null): RefundOperationStatus {
  if (!providerId) return 'reconciliation_required';
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

function refundResultResponse(
  operationId: string,
  status: RefundOperationStatus,
  providerStatus?: string | null,
): Response {
  const detail = { operationId, operationStatus: status, providerStatus: providerStatus ?? null };
  switch (status) {
    case 'confirmed':
    case 'provider_accepted':
      return json({ ok: true, ...detail, note: 'Refund submitted — final balance updates when Stripe confirms via webhook.' });
    case 'pending':
      return json({ ok: true, pending: true, ...detail, note: 'Stripe is still processing this refund. Do not submit another refund.' }, 202);
    case 'requires_action':
      return errorJson('refund_action_required', 'Stripe requires operator action before this refund can complete. Do not retry it yet.', 409, detail);
    case 'failed':
    case 'canceled':
      return errorJson(
        'refund_failed_retryable',
        'Stripe definitively did not complete this refund. Review the failure, then explicitly retry this recorded operation.',
        409,
        { ...detail, retryAllowed: true },
      );
    case 'requested':
    case 'reconciliation_required':
    default:
      return errorJson(
        'refund_reconciliation_required',
        'This refund does not have a definitive provider result. Do not submit another refund until it is reconciled.',
        502,
        detail,
      );
  }
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


/** A slate of times reads as a wall of timestamps unless it is grouped. */
function groupSlotsByDay(startsAt: string[], timezone: string): string {
  const days = new Map<string, string[]>();
  for (const iso of startsAt) {
    const when = new Date(iso);
    const day = when.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' });
    const time = when.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true });
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(time);
  }
  return [...days.entries()].map(([day, times]) => `  ${day}: ${times.join(', ')}`).join('\n');
}

async function notificationFailureResponse(
  db: D1Database,
  actor: string,
  requestId: string,
  action: string,
  result: EmailResult,
): Promise<Response | null> {
  if (result.status !== 'failed') {
    await resolveNotificationActionIssues(db, actor, requestId, action);
    return null;
  }

  const outboxRecorded = Boolean(result.id);
  const auditAction = outboxRecorded ? 'notification_delivery_failed' : 'notification_record_failed';
  try {
    if (outboxRecorded) {
      await auditLog(db, actor, auditAction, 'ppi_request', requestId, {
        sourceAction: action,
        messageId: result.id,
        emailStatus: result.status,
        failure: result.failure,
      });
    } else {
      await persistNotificationIssue(db, {
        actor,
        requestId,
        issueKey: result.issueKey ?? `notification:${requestId}:${action}`,
        kind: 'record_failed',
        sourceAction: action,
        dedupeKey: result.issueDedupeKey,
        error: result.failure,
      });
    }
  } catch (e) {
    console.error(JSON.stringify({
      event: 'admin_notification_failure_audit_failed',
      requestId,
      sourceAction: action,
      error: String(e).slice(0, 240),
    }));
  }

  return errorJson(
    outboxRecorded ? 'notification_delivery_failed' : 'notification_not_recorded',
    outboxRecorded
      ? 'The action was saved, but the email provider did not accept the message. Retry it from this request’s Messages section.'
      : 'The action was saved, but the email could not be added to the delivery queue. Review the notification alert before continuing.',
    outboxRecorded ? 502 : 503,
    {
      actionApplied: true,
      messageId: result.id,
      emailStatus: result.status,
      emailFailure: result.failure ?? null,
    },
  );
}

async function notificationLinkFailureResponse(
  db: D1Database,
  actor: string,
  requestId: string,
  action: string,
  error: unknown,
): Promise<Response> {
  const detail = String(error).slice(0, 240);
  console.error(JSON.stringify({ event: 'admin_notification_link_failed', requestId, sourceAction: action, error: detail }));
  try {
    await persistNotificationIssue(db, {
      actor,
      requestId,
      issueKey: `link:${requestId}:${action}`,
      kind: 'link_failed',
      sourceAction: action,
      error: detail,
    });
  } catch (auditError) {
    console.error(JSON.stringify({
      event: 'admin_notification_failure_audit_failed',
      requestId,
      sourceAction: action,
      error: String(auditError).slice(0, 240),
    }));
  }
  return errorJson(
    'notification_link_failed',
    'The action was saved, but a secure email link could not be prepared. Existing customer links still work; review the notification alert before continuing.',
    503,
    { actionApplied: true },
  );
}


// --------------------------------------------------------- proposal helpers

/** One place that renders the proposal email, used by send and by retry. */
async function deliverProposalEmail(
  env: Env,
  db: D1Database,
  input: {
    requestId: string;
    proposalId: string;
    ref: string;
    email: string;
    config: Awaited<ReturnType<typeof getConfig>>;
    base: string;
    breakdown?: PriceBreakdown;
    priceLines?: string[];
    totals: { totalCents: number };
    slots?: SlotCandidate[];
    slotStarts?: string[];
    expiresAt: string;
    customerMessage: string;
  },
): Promise<EmailResult> {
  const { config } = input;
  let token: string;
  try {
    // rotate = false: every link AutoClarity has already given this customer
    // keeps working, so an older email is never silently broken.
    ({ token } = await issueMagicLink(db, input.requestId, config, false));
  } catch (e) {
    await recordProposalNotification(db, input.proposalId, 'failed', null, `secure link unavailable: ${String(e).slice(0, 200)}`);
    return { id: null, status: 'failed', failure: 'template_failed' };
  }

  const priceLines = input.priceLines
    ?? (input.breakdown?.lines ?? []).map((line) => `  ${line.label}: ${line.display}`);
  const slotStarts = input.slotStarts ?? (input.slots ?? []).map((s) => s.startsAt);

  const emailResult = await sendTemplate(env, db, input.requestId, 'booking_proposal', input.email, {
    ref: input.ref,
    portalUrl: portalUrl(input.base, token),
    supportEmail: config.supportEmail,
    extra: {
      message: input.customerMessage,
      priceLines: priceLines.join('\n'),
      total: formatCents(input.totals.totalCents),
      slots: groupSlotsByDay(slotStarts, config.scheduling.timezone),
      expires: fmtSlot(input.expiresAt, config.scheduling.timezone),
    },
  }, undefined, `booking_proposal:${input.proposalId}`);

  // Only the provider's acceptance earns the word "sent".
  const status = emailResult.status === 'sent'
    ? 'sent'
    : emailResult.status === 'recorded'
      ? 'queued'
      : 'failed';
  await recordProposalNotification(
    db,
    input.proposalId,
    status,
    emailResult.id,
    status === 'failed' ? (emailResult.failure ?? 'delivery_failed') : null,
  );
  return emailResult;
}

/** Proposal shape returned to the dashboard, including its offered windows. */
async function describeProposal(
  db: D1Database,
  proposal: BookingProposalRow,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<Record<string, unknown>> {
  let slotIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(proposal.slot_ids_json);
    if (Array.isArray(parsed)) slotIds = parsed.map((v) => String(v));
  } catch {
    slotIds = [];
  }
  const slots = slotIds.length
    ? await db
        .prepare(
          `SELECT id, starts_at, status FROM appointment_slots
           WHERE request_id = ? AND id IN (${slotIds.map(() => '?').join(',')}) ORDER BY starts_at`,
        )
        .bind(proposal.request_id, ...slotIds)
        .all<{ id: string; starts_at: string; status: string }>()
    : { results: [] as Array<{ id: string; starts_at: string; status: string }> };
  return {
    id: proposal.id,
    quoteId: proposal.quote_id,
    totalCents: proposal.total_cents,
    customerMessage: proposal.customer_message,
    notificationStatus: proposal.notification_status,
    notificationError: proposal.notification_error,
    createdAt: proposal.created_at,
    sentAt: proposal.sent_at,
    slots: (slots.results ?? []).map((s) => ({
      id: s.id,
      startsAt: s.starts_at,
      status: s.status,
      label: fmtSlot(s.starts_at, config.scheduling.timezone),
    })),
  };
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
              v.asking_price_cents, v.expected_price_cents, v.listing_url, v.mod_status, v.mod_details,
              v.warning_lights, v.known_issues, v.title_status, v.starts_drives
       FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!req) return errorJson('not_found', 'Request not found.', 404);

  const [
    quotes,
    lines,
    slots,
    uploads,
    history,
    messagesRows,
    payments,
    acceptances,
    refundOperations,
    refundAttempts,
    providerRefunds,
    paymentDisputes,
  ] = await Promise.all([
    db.prepare(`SELECT * FROM quotes WHERE request_id = ? ORDER BY version DESC`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT l.* FROM quote_line_items l JOIN quotes q ON q.id = l.quote_id WHERE q.request_id = ? ORDER BY l.sort`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM appointment_slots WHERE request_id = ? ORDER BY starts_at`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT id, original_name, content_type, size_bytes, kind, created_at FROM request_uploads WHERE request_id = ? AND deleted_at IS NULL`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM status_history WHERE request_id = ? ORDER BY created_at DESC`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM messages WHERE request_id = ? ORDER BY created_at DESC LIMIT 100`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM payments WHERE request_id = ? ORDER BY created_at DESC`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT a.*, av.doc_key, av.title, av.version AS doc_version FROM agreement_acceptances a JOIN agreement_versions av ON av.id = a.agreement_version_id WHERE a.request_id = ?`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM refund_operations WHERE request_id = ? ORDER BY created_at DESC`).bind(id).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT a.* FROM refund_operation_attempts a
       JOIN refund_operations o ON o.id = a.operation_id
       WHERE o.request_id = ? ORDER BY a.created_at DESC`,
    ).bind(id).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT pr.* FROM provider_refunds pr
       JOIN payments p ON p.id = pr.payment_id
       WHERE p.request_id = ? ORDER BY pr.updated_at DESC`,
    ).bind(id).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT d.* FROM payment_disputes d
       JOIN payments p ON p.id = d.payment_id
       WHERE p.request_id = ? ORDER BY d.updated_at DESC`,
    ).bind(id).all<Record<string, unknown>>(),
  ]);

  const status = String(req['status']);
  const config = await getConfig(db);
  const proposal = await latestProposal(db, id);

  // The suggestion is recomputed on read rather than trusted from intake, so
  // a rules change shows up immediately instead of pinning an old answer to
  // requests that were saved before it.
  const suggestion = suggestTier({
    year: (req['year'] as number | null) ?? null,
    make: String(req['make'] ?? ''),
    model: String(req['model'] ?? ''),
    trim: String(req['vehicle_trim'] ?? ''),
    modStatus: (String(req['mod_status'] ?? 'stock') as 'stock' | 'light' | 'heavy'),
    modDetails: (req['mod_details'] as string | null) ?? '',
    titleStatus: (String(req['title_status'] ?? 'unknown') as 'clean' | 'salvage_rebuilt' | 'unknown'),
    startsDrives: (String(req['starts_drives'] ?? 'unknown') as 'yes' | 'no' | 'unknown'),
  });
  const customerTier = req['customer_selected_tier'];
  const proposalTier = isTier(customerTier) ? customerTier : suggestion.tier;
  // Pre-tick the fee when the customer asked for same-day priority; the owner
  // still decides, because only they know whether they can actually go today.
  const sameDayRequested = Number(req['same_day_priority'] ?? 0) === 1;
  const draftBreakdown = buildPriceBreakdown({
    tier: proposalTier,
    config,
    sameDayPriority: sameDayRequested && config.fees.sameDayPriorityCents > 0,
    travelMiles: (req['travel_miles'] as number | null) ?? null,
    travelBasis: req['travel_miles'] === null || req['travel_miles'] === undefined ? 'unknown' : 'zip_centroid',
  });

  return json({
    request: req,
    manualSlotOfferError: manualSlotOfferError(status, quotes.results ?? [], payments.results ?? []),
    discoveryLabel: discoveryLabel(req['discovery_source']),
    statusLabel: isStatus(status) ? STATUS_LABELS[status] : status,
    recordKind: {
      kind: String(req['record_kind'] ?? 'real'),
      // Why it LOOKS like a test, shown even when the owner has overridden it,
      // so the classification is never a black box.
      autoReason: testRecordReason({
        ref: String(req['ref'] ?? ''),
        email: String(req['email'] ?? ''),
        fullName: String(req['full_name'] ?? ''),
      }),
    },
    // Everything the dashboard needs to render a prefilled proposal card
    // without re-deriving any price of its own.
    proposalDraft: {
      tier: proposalTier,
      suggestedTier: suggestion.tier,
      customerSelectedTier: isTier(customerTier) ? customerTier : null,
      tierMismatch: isTier(customerTier) ? tierMismatch(suggestion.tier, customerTier) : null,
      customerReason: suggestion.customerReason,
      adminReasons: suggestion.reasons,
      manualReview: suggestion.manualReview,
      manualReasons: suggestion.manualReasons,
      reviewCeiling: suggestion.reviewCeiling,
      lines: draftBreakdown.lines,
      totalCents: draftBreakdown.totalCents,
      travel: draftBreakdown.travel,
      travelOriginLabel: config.travel.originLabel,
      reviewNotes: draftBreakdown.reviewNotes,
      sameDayRequested,
      sameDayPriority: sameDayRequested && config.fees.sameDayPriorityCents > 0,
      sameDayPriorityCents: config.fees.sameDayPriorityCents,
      quoteExpiryHours: config.quotes.expiryHours,
      slotTemplates: config.scheduling.slotTemplates,
      daysOfOperation: appointmentDays(config, req),
      sundayEligible: sundayEligible(req),
      blackoutDates: config.scheduling.blackoutDates,
      timezone: config.scheduling.timezone,
      minLeadHours: config.scheduling.minLeadHours,
      maxAdvanceDays: config.scheduling.maxAdvanceDays,
      tierOptions: (['standard', 'euro_luxury_performance', 'exotic_collector'] as const).map((key) => ({
        key,
        label: config.pricing.tiers[key].label,
        priceCents: basePriceForTier(key, config).priceCents,
      })),
    },
    proposal: proposal ? await describeProposal(db, proposal, config) : null,
    allowedTransitions: isStatus(status)
      ? (Object.keys(STATUS_LABELS) as Status[]).filter((s) => canTransition(status, s) && genericStatusAllowed(status, s))
      : [],
    quotes: quotes.results ?? [],
    quoteLines: lines.results ?? [],
    slots: slots.results ?? [],
    uploads: uploads.results ?? [],
    history: history.results ?? [],
    messages: messagesRows.results ?? [],
    payments: payments.results ?? [],
    acceptances: acceptances.results ?? [],
    refundOperations: refundOperations.results ?? [],
    refundAttempts: refundAttempts.results ?? [],
    providerRefunds: providerRefunds.results ?? [],
    paymentDisputes: paymentDisputes.results ?? [],
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
  messageId?: string;
  confirmFresh?: boolean;
  refundOperationId?: string;
  proposalKey?: string;
  proposalId?: string;
  vehicleLabel?: string;
  recordKind?: string;
  sameDayPriority?: boolean;
  offlineNote?: string;
  inspectionLocationType?: string;
  permInspection?: boolean;
  collectedAt?: string;
  label?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  if (!originAllowed(context.request, context.env.PUBLIC_BASE_URL, true)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
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
    body = await readJsonBody<AdminActionBody>(context.request);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }

  const req = await db
    .prepare(
      `SELECT r.id, r.ref, r.status, r.travel_miles, r.attribution_source, r.record_kind, r.seller_type, r.inspection_location_type, r.perm_inspection, c.email, c.full_name FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(id)
    .first<{ id: string; ref: string; status: string; travel_miles: number | null; attribution_source: string; record_kind: string; email: string; full_name: string } & SellerLocation>();
  if (!req || !isStatus(req.status)) return errorJson('not_found', 'Request not found.', 404);
  const status = req.status as Status;
  const base = (env.PUBLIC_BASE_URL ?? new URL(context.request.url).origin).replace(/\/$/, '');

  switch (body.action) {
    case 'set_inspection_location': {
      if (req.seller_type !== 'private') return errorJson('validation', 'Only an explicitly private-sale request can have a private inspection location confirmed.', 422);
      if (!['submitted', 'needs_info', 'seller_access_pending', 'ready_for_review', 'quote_prepared', 'quote_sent', 'awaiting_time_selection'].includes(status)) {
        return errorJson('wrong_state', 'Confirm the location before an appointment is held or paid.', 409);
      }
      const location = body.inspectionLocationType;
      if (!location || !['private_residence', 'other', 'unknown'].includes(location)) return errorJson('validation', 'Choose the inspection location.', 422);
      const permission = typeof body.permInspection === 'boolean' ? (body.permInspection ? 1 : 0) : (Number(req.perm_inspection) === 1 ? 1 : 0);
      const changed = await db.prepare(`UPDATE ppi_requests SET inspection_location_type = ?, perm_inspection = ?, updated_at = ?
        WHERE id = ? AND status = ? AND seller_type = 'private' AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM payments WHERE request_id = ?)
          AND NOT EXISTS (SELECT 1 FROM appointment_slots WHERE request_id = ? AND status IN ('held','confirmed'))`)
        .bind(location, permission, nowIso(), id, status, id, id).run();
      if (changed.meta.changes !== 1) return errorJson('conflict', 'The request has a hold or payment record. Its location was not changed.', 409);
      await auditLog(db, actor, 'set_inspection_location', 'ppi_request', id, { from: req.inspection_location_type ?? null, to: location, priorPermission: req.perm_inspection, permission });
      return json({ ok: true });
    }

    // ------------------------------------------------------------- set_status
    case 'set_status': {
      const to = String(body.to ?? '');
      if (!isStatus(to)) return errorJson('validation', 'Unknown status.', 422);
      if (GENERIC_STATUS_BLOCKED.has(to)) {
        return errorJson(
          'dedicated_action_required',
          `${STATUS_LABELS[to]} is controlled by a dedicated customer or payment lifecycle and cannot be set manually.`,
          409,
        );
      }
      if (status === 'awaiting_payment' && AWAITING_PAYMENT_BACKWARD_BLOCKED.has(to)) {
        return errorJson(
          'dedicated_action_required',
          'A request with payment open cannot be moved backward manually. Expire its Checkout Session or release/reselect the held time through the dedicated lifecycle action.',
          409,
        );
      }
      if (!canTransition(status, to)) {
        return errorJson('invalid_transition', `Cannot move from ${STATUS_LABELS[status]} to ${STATUS_LABELS[to]}.`, 409);
      }
      const reason = clampStr(body.reason, 300) || 'Admin status change';
      let completedReport: PublishedReportVersion | null = null;

      if (to === 'confirmed') {
        if (flags.paymentsEnabled || flags.env === 'production') {
          return errorJson('payment_authority_required', 'Paid confirmations are recorded only from Stripe or paid-time reselection.', 409);
        }
        const now = nowIso();
        const slot = await db
          .prepare(
            `SELECT id FROM appointment_slots
             WHERE request_id = ? AND status = 'held' AND hold_expires_at >= ?
             ORDER BY starts_at LIMIT 1`,
          )
          .bind(id, now)
          .first<{ id: string }>();
        const quote = await db
          .prepare(
            `SELECT id FROM quotes WHERE request_id = ? AND status IN ('sent','accepted')
             ORDER BY version DESC LIMIT 1`,
          )
          .bind(id)
          .first<{ id: string }>();
        if (!slot || !quote) {
          return errorJson('booking_incomplete', 'A live held time and active quote are required before manual confirmation.', 409);
        }
        const checkoutExpiry = await expireOpenCheckoutAttempts(env, id);
        if (!checkoutExpiry.ok) {
          return errorJson(
            checkoutExpiry.code,
            'Manual confirmation was not applied because an open Checkout attempt could not be proven expired. Reconcile it before retrying.',
            checkoutExpiry.code === 'payments_unavailable' ? 503 : 409,
          );
        }
        const bookingId = newId('bkg');
        const results = await db.batch([
          db
            .prepare(
              `UPDATE appointment_slots SET status = 'confirmed', hold_expires_at = NULL, updated_at = ?
               WHERE id = ? AND request_id = ? AND status = 'held' AND hold_expires_at >= ?
                 AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_payment')`,
            )
            .bind(now, slot.id, id, now, id),
          db
            .prepare(
              `INSERT INTO bookings (id, request_id, quote_id, slot_id, status, confirmed_at, created_at, updated_at)
               SELECT ?, ?, ?, ?, 'confirmed', ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND status = 'confirmed')
               ON CONFLICT(request_id) DO UPDATE SET
                 quote_id = excluded.quote_id, slot_id = excluded.slot_id, status = 'confirmed',
                 confirmed_at = COALESCE(bookings.confirmed_at, excluded.confirmed_at), updated_at = excluded.updated_at`,
            )
            .bind(bookingId, id, quote.id, slot.id, now, now, now, slot.id),
          db
            .prepare(
              `UPDATE ppi_requests SET status = 'confirmed', updated_at = ?
               WHERE id = ? AND status = 'awaiting_payment'
                 AND EXISTS (SELECT 1 FROM bookings WHERE request_id = ? AND slot_id = ? AND status = 'confirmed')
                 AND EXISTS (SELECT 1 FROM appointment_slots WHERE id = ? AND status = 'confirmed')`,
            )
            .bind(now, id, id, slot.id, slot.id),
          db
            .prepare(
              `INSERT INTO status_history (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
               SELECT ?, ?, 'awaiting_payment', 'confirmed', ?, ?, ?, ?
               WHERE EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'confirmed')`,
            )
            .bind(newId('sh'), id, actor, reason, slot.id, now, id),
          db
            .prepare(
              `UPDATE appointment_slots SET status = 'released', hold_expires_at = NULL, updated_at = ?
               WHERE request_id = ? AND id != ? AND status IN ('offered','held')
                 AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'confirmed')`,
            )
            .bind(now, id, slot.id, id),
          db
            .prepare(
              `UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?
               AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'confirmed')`,
            )
            .bind(now, quote.id, id),
        ]);
        if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[2]?.meta?.changes ?? 0) !== 1) {
          return errorJson('conflict', 'The request or held time changed concurrently — reload and retry.', 409);
        }
      } else if (to === 'admin_cancelled' || to === 'expired') {
        if (to === 'admin_cancelled') {
          const paid = await db
            .prepare(
              `SELECT id FROM payments
               WHERE request_id = ? AND status IN ('succeeded','partially_refunded','refunded','disputed') LIMIT 1`,
            )
            .bind(id)
            .first<{ id: string }>();
          if (paid) {
            return errorJson(
              'paid_cancellation_remedy_required',
              'A paid booking cannot be closed with a generic status change. Submit the promised refund through the recorded payment, or keep the booking active while arranging priority rescheduling.',
              409,
            );
          }
        }
        const checkoutExpiry = await expireOpenCheckoutAttempts(env, id);
        if (!checkoutExpiry.ok) {
          return errorJson(
            checkoutExpiry.code,
            'Cancellation was not applied because an open payment attempt could not be proven expired. Reconcile it before retrying.',
            checkoutExpiry.code === 'payments_unavailable' ? 503 : 409,
          );
        }
        const lifecycle = await applyTerminalLifecycle(db, {
          requestId: id,
          to,
          actor,
          reason,
          relatedId: to === 'expired' ? newId('exp') : id,
        });
        if (!lifecycle.ok) {
          return lifecycle.blockedByOpenPaymentClaim
            ? errorJson(
                'reconciliation_required',
                'A Checkout attempt started while the terminal state was being applied. The request remains active; expire or reconcile that attempt before retrying.',
                409,
              )
            : errorJson('conflict', 'Status changed concurrently — reload and retry.', 409);
        }
      } else if (to === 'completed') {
        const completion = await completeWithPublishedReport(
          db,
          id,
          actor,
          clampStr(body.reason, 300) || undefined,
        );
        if (!completion.ok) {
          return completion.code === 'report_required'
            ? errorJson(
                'report_required',
                'Publish this request\'s inspection report and record its Report Ready delivery before marking it completed.',
                409,
              )
            : errorJson('conflict', 'The request or published report changed concurrently — reload and retry.', 409);
        }
        completedReport = completion.report;
      } else {
        const moved = await applyStatus(db, id, status, to, actor, reason);
        if (!moved) return errorJson('conflict', 'Status changed concurrently — reload and retry.', 409);
      }
      await auditLog(db, actor, 'set_status', 'ppi_request', id, {
        from: status,
        to,
        reason: body.reason,
        reportVersionId: completedReport?.versionId ?? null,
      });
      if (to === 'confirmed' || to === 'completed') {
        const event = to === 'confirmed' ? 'ppi_booking_confirmed' : 'ppi_completed';
        await db
          .prepare(`INSERT OR IGNORE INTO analytics_events (id, event, step, source, created_at) VALUES (?, ?, 'workflow', ?, ?)`)
          .bind(`ev_status_${id}_${to}`, event, req.attribution_source || 'ppi_unknown', nowIso())
          .run();
      }

      // Courtesy emails for the customer-facing waiting states.
      const templateByStatus: Partial<Record<Status, EmailTemplateKey>> = {
        needs_info: 'needs_info',
        seller_access_pending: 'seller_access',
        // New fulfillment versions already have their durable report-ready
        // event before completion; never bypass its safe retry/successor path.
        ...(completedReport?.workflowRevision===1?{}:{completed:'report_ready' as const}),
        customer_cancelled: 'cancellation_confirmed',
        admin_cancelled: 'cancellation_confirmed',
      };
      const template = templateByStatus[to];
      if (template) {
        let token: string;
        try {
          ({ token } = await issueMagicLink(db, id, config, false));
        } catch (e) {
          return notificationLinkFailureResponse(db, actor, id, 'set_status', e);
        }
        const emailResult = await sendTemplate(env, db, id, template, req.email, {
          ref: req.ref,
          portalUrl: portalUrl(base, token),
          supportEmail: config.supportEmail,
          extra: {
            note: clampStr(body.note, 1000),
            version: completedReport ? String(completedReport.version) : '',
          },
        }, undefined, completedReport ? `report_ready:${completedReport.versionId}` : undefined);
        const emailFailure = await notificationFailureResponse(db, actor, id, 'set_status', emailResult);
        if (emailFailure) return emailFailure;
        return json({
          ok: true,
          notification: { messageId: emailResult.id, emailStatus: emailResult.status, deliveryConfirmed: emailResult.status === 'sent' },
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
      const priorPayment = await db
        .prepare(
          `SELECT id FROM payments
           WHERE request_id = ? AND status IN ('succeeded','partially_refunded','refunded','disputed') LIMIT 1`,
        )
        .bind(id)
        .first<{ id: string }>();
      if (priorPayment) {
        return errorJson(
          'payment_already_received',
          'This request already has a recorded payment. Use paid time reselection or create a new request; no replacement quote was created.',
          409,
        );
      }
      if (!(['ready_for_review', 'quote_prepared', 'quote_sent', 'awaiting_time_selection', 'submitted', 'needs_info', 'seller_access_pending'] as Status[]).includes(status)) {
        return errorJson('wrong_state', 'Quotes cannot be created for this request in its current status.', 409);
      }
      const tier = String(body.tier ?? '') as Tier;
      if (!['standard', 'euro_luxury_performance', 'exotic_collector'].includes(tier)) {
        return errorJson('validation', 'Choose a valid package tier.', 422);
      }

      const tierBase = basePriceForTier(tier, config);
      const baseCents = Number.isSafeInteger(body.basePriceCents) && (body.basePriceCents as number) > 0
        ? (body.basePriceCents as number)
        : tierBase.priceCents;

      let travelCents = Number.isSafeInteger(body.travelCents) && (body.travelCents as number) >= 0 ? (body.travelCents as number) : null;
      if (travelCents === null) {
        const suggestion = req.travel_miles !== null ? travelFeeForMiles(req.travel_miles, config) : { feeCents: null };
        if (suggestion.feeCents === null) {
          return errorJson(
            'travel_quote_required',
            'This location requires custom travel review. Enter the approved travel amount explicitly (enter 0 only when AutoClarity has intentionally approved no travel charge).',
            422,
          );
        }
        travelCents = suggestion.feeCents;
      }

      const lines: QuoteLineInput[] = [
        { kind: 'base', label: `${config.pricing.tiers[tier].label}${tierBase.promoApplied && baseCents === tierBase.priceCents ? ' (launch price)' : ''}`, amountCents: baseCents },
      ];
      if (travelCents > 0) lines.push({ kind: 'travel', label: 'Mobile-service charge', amountCents: travelCents });
      for (const addon of body.addons ?? []) {
        const label = clampStr(addon.label, 120);
        const cents = Number(addon.amountCents);
        if (label && Number.isSafeInteger(cents) && cents > 0 && cents <= 500000) {
          lines.push({ kind: 'addon', label, amountCents: cents });
        }
      }
      const discount = Number(body.discountCents);
      if (Number.isSafeInteger(discount) && discount > 0) {
        lines.push({ kind: 'discount', label: clampStr(body.discountLabel, 120) || 'Discount', amountCents: -discount });
      }

      let totals;
      try {
        totals = computeQuoteTotals(lines);
      } catch {
        return errorJson('validation', 'Quote lines must produce one positive, exact total in whole cents.', 422);
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
            `INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, travel_cents, addons_cents, discount_cents, total_cents,
                                 expires_at, admin_note_internal, customer_note, approved_by, created_at, updated_at)
             VALUES (?, ?, ?, 'draft', ?, 'usd', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    // ------------------------------------------------------ set_record_kind
    //
    // The owner's judgement overrides the automatic classification in both
    // directions: a fixture that turned into a real job, or a real-looking
    // record that was actually a rehearsal.
    // Money that arrived outside Stripe — cash at the car, Zelle, a transfer
    // arranged over text. Without this, a real paid job had nowhere to live:
    // the request sat at "submitted" forever and the revenue was missing from
    // every figure the owner reads.
    //
    // It writes the same shapes a Stripe job writes — a committed quote, a
    // booking, a payment, the confirmation event — so the dashboard, the
    // revenue window and the customer's portal all read it as the real job it
    // was. What it does NOT write is any Stripe identity, any agreement
    // acceptance, or any report delivery: those are evidence of things that
    // either happened or did not, and inventing them would put a lie where
    // support, a refund or a dispute would later look.
    case 'record_offline_payment': {
      const now = nowIso();
      const amountCents = Number(body.amountCents);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 5_000_000) {
        return errorJson('validation', 'Enter the amount actually collected, in dollars.', 422);
      }
      const suggestedRow = await db
        .prepare(`SELECT suggested_tier FROM ppi_requests WHERE id = ?`)
        .bind(id)
        .first<{ suggested_tier: string | null }>();
      const tier = String(body.tier ?? suggestedRow?.suggested_tier ?? 'standard');
      if (!isTier(tier)) return errorJson('validation', 'Choose a valid package.', 422);

      // How it was paid, in the owner's words. Required, because "paid" with no
      // idea how is exactly the record nobody can reconcile a month later.
      const method = clampStr(body.offlineNote, 200);
      if (!method) {
        return errorJson('validation', 'Say how the money was collected (for example "Zelle" or "cash at the vehicle").', 422);
      }

      // One payment per request through this path. Re-recording would double
      // the revenue figures, which is the failure that matters most here.
      const existingPayment = await db
        .prepare(`SELECT id FROM payments WHERE request_id = ? LIMIT 1`)
        .bind(id)
        .first<{ id: string }>();
      if (existingPayment) {
        return errorJson('wrong_state', 'This request already has a payment recorded against it.', 409);
      }
      if (status === 'disputed' || status === 'refunded' || status === 'refund_reconciliation_needed') {
        return errorJson('wrong_state', 'A disputed or refunded request cannot have a payment recorded against it.', 409);
      }

      // When the money actually arrived. It drives the revenue window, so a
      // wrong date puts real income in the wrong month.
      const collectedAt = typeof body.collectedAt === 'string' && !Number.isNaN(Date.parse(body.collectedAt))
        ? new Date(body.collectedAt).toISOString()
        : now;

      const label = clampStr(body.label, 120) || `${config.pricing.tiers[tier].label} pre-purchase inspection`;
      const quoteId = newId('qot');
      const bookingId = newId('bkg');
      const paymentId = newId('pay');
      const versionRow = await db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM quotes WHERE request_id = ?`)
        .bind(id)
        .first<{ v: number }>();
      const version = (versionRow?.v ?? 0) + 1;

      // A single base line for the agreed amount. Splitting it into an invented
      // package price plus an invented travel fee would state a mileage band
      // that was never measured; one line says only what is known — the price
      // agreed and collected.
      try {
        await db.batch([
          db.prepare(`UPDATE quotes SET status = 'superseded', updated_at = ? WHERE request_id = ? AND status IN ('draft','sent')`).bind(now, id),
          db.prepare(
            `INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, travel_cents, addons_cents, discount_cents, total_cents,
                                 expires_at, admin_note_internal, approved_by, created_at, updated_at)
             VALUES (?, ?, ?, 'draft', ?, 'usd', ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            quoteId, id, version, tier, amountCents, amountCents,
            // This quote is a record of a price already agreed and paid, not an
            // open offer, so it is never valid past the moment it was settled.
            collectedAt,
            `Recorded from a payment collected outside Stripe: ${method}`,
            actor, collectedAt, now,
          ),
          db.prepare(`INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort) VALUES (?, ?, 'base', ?, ?, 0)`)
            .bind(newId('qli'), quoteId, label, amountCents),
          db.prepare(`UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'draft'`).bind(now, quoteId),
          // No slot: the exact appointment window was never recorded in this
          // system, and inventing one would put a time on the calendar that
          // nobody ever agreed to.
          db.prepare(
            `INSERT INTO bookings (id, request_id, quote_id, slot_id, status, confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, NULL, 'confirmed', ?, ?, ?)`,
          ).bind(bookingId, id, quoteId, collectedAt, collectedAt, now),
          db.prepare(
            `INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent,
                                   amount_cents, currency, status, refunded_cents, method, offline_note, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, NULL, ?, 'usd', 'succeeded', 0, 'offline', ?, ?, ?)`,
          ).bind(paymentId, id, quoteId, bookingId, amountCents, method, collectedAt, now),
          // The revenue window counts payments that carry this event, so
          // without it the money would be recorded but never reported.
          db.prepare(
            `INSERT OR IGNORE INTO analytics_events (id, event, step, source, created_at)
             VALUES (?, 'ppi_payment_confirmed', 'workflow', ?, ?)`,
          ).bind(`ev_payment_${paymentId}`, req.attribution_source || 'ppi_offline', collectedAt),
        ]);
      } catch (e) {
        return errorJson('offline_payment_write_failed', `The payment could not be recorded: ${String(e)}`, 409);
      }

      // Walk the normal path rather than jumping the state machine, so this
      // request's history reads like any other job's and every step is audited.
      const path: Status[] = [
        'ready_for_review', 'quote_prepared', 'quote_sent',
        'awaiting_time_selection', 'awaiting_agreement', 'awaiting_payment', 'confirmed',
      ];
      let walkFrom: Status = status;
      const walked: Status[] = [];
      for (const step of path) {
        if (walkFrom === step) continue;
        if (!canTransition(walkFrom, step)) continue;
        if (await applyStatus(db, id, walkFrom, step, actor, `Recording a job paid outside Stripe (${method})`)) {
          walked.push(step);
          walkFrom = step;
        }
      }

      await auditLog(db, actor, 'record_offline_payment', 'ppi_request', id, {
        paymentId, quoteId, bookingId, amountCents, method, collectedAt,
        statusFrom: status, statusTo: walkFrom, walked,
      });

      return json({
        ok: true,
        paymentId,
        quoteId,
        bookingId,
        amountCents,
        amountLabel: formatCents(amountCents),
        collectedAt,
        status: walkFrom,
        // Said plainly so it is never mistaken for a delivered inspection.
        completionNote: walkFrom === 'confirmed'
          ? 'Recorded as paid and confirmed. Marking it completed needs this request\'s inspection report published and delivered.'
          : 'Recorded as paid.',
      });
    }

    case 'set_record_kind': {
      const kind = String(body.recordKind ?? '');
      if (!isRecordKind(kind)) return errorJson('validation', 'Choose either real or test.', 422);
      const previous = String(req.record_kind ?? 'real');
      if (kind === previous) return json({ ok: true, unchanged: true, recordKind: kind });
      // Money is the one thing that settles the argument: a record with a
      // settled payment is real business and cannot be filed as a test.
      if (kind === 'test') {
        const paid = await db
          .prepare(
            `SELECT id FROM payments WHERE request_id = ?
               AND status IN ('succeeded','partially_refunded','refunded','disputed') LIMIT 1`,
          )
          .bind(id)
          .first<{ id: string }>();
        if (paid) {
          return errorJson(
            'payment_on_record',
            'This request has a recorded payment, so it cannot be filed as a test. Real money makes it real business.',
            409,
          );
        }
      }
      await db
        .prepare(`UPDATE ppi_requests SET record_kind = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
        .bind(kind, nowIso(), id)
        .run();
      await auditLog(db, actor, 'set_record_kind', 'ppi_request', id, { from: previous, to: kind });
      return json({ ok: true, recordKind: kind });
    }

    // ------------------------------------------------------- price_preview
    //
    // A dry run of the SAME calculation the send action will use, so the
    // number on the button is produced by the code that will charge it — the
    // dashboard never adds up line items itself.
    case 'price_preview': {
      const tier = String(body.tier ?? '');
      if (!isTier(tier)) return errorJson('validation', 'Choose a valid package.', 422);
      // Preview against the same times the send will use, so the total shown
      // on the button is the total the customer is charged.
      const previewSlots = (Array.isArray(body.slots) ? body.slots : [])
        .map((s) => (typeof s === 'string' ? s : String((s as { startsAt?: unknown })?.startsAt ?? '')))
        .filter(Boolean);
      const breakdown = buildPriceBreakdown({
        tier,
        config,
        sameDayPriority:
          body.sameDayPriority === true && hasSameDaySlot(previewSlots, config.scheduling.timezone),
        baseCentsOverride: Number.isSafeInteger(body.basePriceCents) ? (body.basePriceCents as number) : null,
        travelMiles: req.travel_miles,
        travelBasis: req.travel_miles === null ? 'unknown' : 'zip_centroid',
        travelCentsOverride: Number.isSafeInteger(body.travelCents) ? (body.travelCents as number) : null,
        addons: (body.addons ?? []).map((a) => ({ label: clampStr(a.label, 120), amountCents: Number(a.amountCents) })),
        discountCents: Number(body.discountCents) || 0,
        discountLabel: clampStr(body.discountLabel, 120),
      });
      return json({
        ok: true,
        lines: breakdown.lines,
        totalCents: breakdown.totalCents,
        travel: breakdown.travel,
        reviewNotes: breakdown.reviewNotes,
      });
    }

    // --------------------------------------------- send_booking_proposal
    //
    // The ordinary path, and the reason this file exists in its current shape:
    // review the price, pick times, press one button. It writes ONE coherent
    // proposal (quote + offered windows + customer message) and sends ONE
    // notification carrying ONE branded link.
    case 'send_booking_proposal': {
      if (!flags.bookingEnabled) return errorJson('booking_disabled', 'Booking is disabled in this environment.', 409);

      const idempotencyKey = clampStr(body.proposalKey, 100);
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
        return errorJson('validation', 'A proposal key is required. Reload the request and try again.', 422);
      }

      // Pressing the button twice, a retried fetch, or a duplicated tab all
      // land here. The first one already did the work; say so and stop.
      const existingProposal = await findProposalByKey(db, id, idempotencyKey);
      if (existingProposal) {
        return json({
          ok: true,
          duplicate: true,
          proposal: await describeProposal(db, existingProposal, config),
          note: 'This proposal was already sent. Nothing was duplicated.',
        });
      }

      const priorPayment = await db
        .prepare(
          `SELECT id FROM payments
           WHERE request_id = ? AND status IN ('succeeded','partially_refunded','refunded','disputed') LIMIT 1`,
        )
        .bind(id)
        .first<{ id: string }>();
      if (priorPayment) {
        return errorJson(
          'payment_already_received',
          'This request already has a recorded payment. Use paid time reselection instead; no replacement proposal was created.',
          409,
        );
      }

      const quotableStatuses: Status[] = [
        'submitted', 'needs_info', 'seller_access_pending', 'ready_for_review',
        'quote_prepared', 'quote_sent', 'awaiting_time_selection',
      ];
      if (!quotableStatuses.includes(status)) {
        return errorJson('wrong_state', 'A booking proposal cannot be sent for this request in its current status.', 409);
      }

      const tier = String(body.tier ?? '');
      if (!isTier(tier)) return errorJson('validation', 'Choose a valid package.', 422);

      // Times are validated BEFORE anything is written. A proposal without
      // times is the exact dead end this action exists to prevent, so an
      // empty result saves nothing at all.
      const slotInput = Array.isArray(body.slots) ? body.slots : [];
      const slotCheck = await validateSlotTimes(db, id, slotInput, config);
      if (slotCheck.valid.length === 0) {
        return errorJson(
          'no_usable_times',
          'None of those times can be offered, so nothing was sent. Pick different times and try again.',
          422,
          { skipped: slotCheck.skipped },
        );
      }

      // The intake page promises the same-day fee applies only when the
      // appointment really is today, so it is dropped unless one of the times
      // being offered falls on today's date in Las Vegas.
      const sameDayOffered = hasSameDaySlot(
        slotCheck.valid.map((s) => s.startsAt),
        config.scheduling.timezone,
      );
      const sameDayPriority = body.sameDayPriority === true && sameDayOffered;

      const breakdown = buildPriceBreakdown({
        tier,
        config,
        sameDayPriority,
        baseCentsOverride: Number.isSafeInteger(body.basePriceCents) ? (body.basePriceCents as number) : null,
        travelMiles: req.travel_miles,
        travelBasis: req.travel_miles === null ? 'unknown' : 'zip_centroid',
        travelCentsOverride: Number.isSafeInteger(body.travelCents) ? (body.travelCents as number) : null,
        addons: (body.addons ?? []).map((a) => ({ label: clampStr(a.label, 120), amountCents: Number(a.amountCents) })),
        discountCents: Number(body.discountCents) || 0,
        discountLabel: clampStr(body.discountLabel, 120),
      });

      if (breakdown.totalCents === null || breakdown.quoteLines.length === 0) {
        return errorJson(
          'travel_quote_required',
          'This location needs an explicit travel amount before a total can be offered. Set it under Advanced pricing (enter 0 only when travel is intentionally included).',
          422,
        );
      }

      let totals;
      try {
        totals = computeQuoteTotals(breakdown.quoteLines);
      } catch {
        return errorJson('validation', 'Those amounts do not produce one positive, exact total in whole cents.', 422);
      }

      // Take ownership of the request first; this compare-and-swap is what
      // stops two browser tabs from both building a proposal.
      if (status !== 'quote_prepared') {
        const walked = canTransition(status, 'quote_prepared')
          ? await applyStatus(db, id, status, 'quote_prepared', actor, 'Preparing booking proposal')
          : canTransition(status, 'ready_for_review')
            && (await applyStatus(db, id, status, 'ready_for_review', actor, 'Moving to review for quoting'))
            && (await applyStatus(db, id, 'ready_for_review', 'quote_prepared', actor, 'Preparing booking proposal'));
        if (!walked) {
          return errorJson('conflict', 'This request changed a moment ago — reload it and send the proposal again.', 409);
        }
      }

      const now = nowIso();
      const quoteId = newId('qot');
      const proposalId = newProposalId();
      const expiresHours = Number.isInteger(body.expiresHours) && (body.expiresHours as number) > 0
        ? (body.expiresHours as number)
        : config.quotes.expiryHours;
      const expiresAt = new Date(Date.now() + expiresHours * 3600_000).toISOString();
      const versionRow = await db
        .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM quotes WHERE request_id = ?`)
        .bind(id)
        .first<{ v: number }>();
      const version = (versionRow?.v ?? 0) + 1;
      const slotIds = slotCheck.valid.map(() => newId('slt'));
      const customerMessage = clampStr(body.customerNote, 2000)
        || defaultProposalMessage({
          customerFirstName: req.full_name.split(' ')[0] ?? '',
          vehicle: clampStr(body.vehicleLabel, 120) || 'your vehicle',
          totalLabel: formatCents(totals.totalCents),
          travelSentence: travelSentence(breakdown.travel.feeCents, breakdown.travel.miles),
        });

      // One transaction: supersede any older offer, write the quote already in
      // 'sent' state, its lines, the offered windows, and the proposal record.
      // D1 batches are transactional, so the customer can never see a price
      // with no times or times with no price.
      try {
        await db.batch([
          db.prepare(`UPDATE quotes SET status = 'superseded', updated_at = ? WHERE request_id = ? AND status IN ('draft','sent')`).bind(now, id),
          db.prepare(
            `UPDATE appointment_slots SET status = 'released', hold_expires_at = NULL, updated_at = ?
             WHERE request_id = ? AND status = 'offered'`,
          ).bind(now, id),
          // 0008 requires a quote to be born as a draft, receive its line
          // items, and only then cross the commit point — the commit is what
          // re-checks that every component adds up. All three steps live in
          // this one transaction, so the customer never sees a half-built offer.
          db.prepare(
            `INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, travel_cents, addons_cents, discount_cents, total_cents,
                                 expires_at, admin_note_internal, customer_note, approved_by, created_at, updated_at)
             VALUES (?, ?, ?, 'draft', ?, 'usd', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            quoteId, id, version, tier,
            totals.subtotalCents, totals.travelCents, totals.addonsCents, totals.discountCents, totals.totalCents,
            expiresAt, clampStr(body.adminNote, 2000) || null, customerMessage, actor, now, now,
          ),
          ...breakdown.quoteLines.map((l, i) =>
            db.prepare(`INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort) VALUES (?, ?, ?, ?, ?, ?)`)
              .bind(newId('qli'), quoteId, l.kind, l.label, l.amountCents, i),
          ),
          db.prepare(`UPDATE quotes SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'draft'`).bind(now, quoteId),
          ...slotCheck.valid.map((slot, i) =>
            db.prepare(
              `INSERT INTO appointment_slots
                 (id, request_id, starts_at, ends_at, blocked_starts_at, blocked_ends_at, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'offered', ?, ?)`,
            ).bind(slotIds[i], id, slot.startsAt, slot.endsAt, slot.blockedStartsAt, slot.blockedEndsAt, now, now),
          ),
          db.prepare(
            `INSERT INTO booking_proposals
               (id, request_id, quote_id, slot_ids_json, total_cents, customer_message,
                notification_status, idempotency_key, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'saved', ?, ?, ?, ?)`,
          ).bind(proposalId, id, quoteId, JSON.stringify(slotIds), totals.totalCents, customerMessage, idempotencyKey, actor, now, now),
        ]);
      } catch (e) {
        const detail = String(e);
        const conflict = /overlap|UNIQUE/i.test(detail);
        return errorJson(
          conflict ? 'conflict' : 'proposal_write_failed',
          conflict
            ? 'One of those times was taken while you were reviewing, or this proposal was already sent. Nothing was sent — reload and try again.'
            : 'The proposal could not be saved. Nothing was sent to the customer.',
          409,
          { skipped: slotCheck.skipped },
        );
      }

      const movedToSent = await applyStatus(db, id, 'quote_prepared', 'quote_sent', actor, `Booking proposal v${version} sent`, quoteId);
      if (movedToSent) {
        await applyStatus(db, id, 'quote_sent', 'awaiting_time_selection', actor, 'Appointment options offered', proposalId);
      }

      await db
        .prepare(`INSERT INTO analytics_events (id, event, step, source, created_at) VALUES (?, 'ppi_quote_sent', 'booking_proposal', ?, ?)`)
        .bind(newId('ev'), req.attribution_source || 'ppi_unknown', now)
        .run();
      await auditLog(db, actor, 'send_booking_proposal', 'ppi_request', id, {
        proposalId, quoteId, version, totalCents: totals.totalCents, tier, slots: slotIds.length, skipped: slotCheck.skipped,
      });

      // The proposal is saved and durable from here. Whatever the email does
      // next is recorded against it truthfully rather than assumed.
      const emailResult = await deliverProposalEmail(env, db, {
        requestId: id, proposalId, ref: req.ref, email: req.email, config, base,
        breakdown, totals, slots: slotCheck.valid, expiresAt, customerMessage,
      });

      return json({
        ok: true,
        proposalId,
        quoteId,
        version,
        totalCents: totals.totalCents,
        offeredSlots: slotCheck.valid.length,
        sameDayPriority,
        sameDayFeeDropped: body.sameDayPriority === true && !sameDayOffered,
        skipped: slotCheck.skipped,
        notification: {
          messageId: emailResult.id,
          emailStatus: emailResult.status,
          deliveryConfirmed: emailResult.status === 'sent',
        },
      }, emailResult.status === 'failed' ? 207 : 200);
    }

    // ------------------------------------------ retry_proposal_notification
    //
    // Safe retry: reuses the SAME stored proposal and the SAME outbox dedupe
    // key, so it can never create a second proposal, a second quote, a second
    // set of times, or a second email.
    case 'retry_proposal_notification': {
      const proposalId = clampStr(body.proposalId, 60);
      const proposal = await db
        .prepare(`SELECT * FROM booking_proposals WHERE id = ? AND request_id = ?`)
        .bind(proposalId, id)
        .first<BookingProposalRow>();
      if (!proposal) return errorJson('not_found', 'That booking proposal was not found for this request.', 404);
      if (proposal.notification_status === 'sent') {
        return json({ ok: true, alreadySent: true, note: 'This proposal was already delivered. Nothing was re-sent.' });
      }

      const quote = await db
        .prepare(`SELECT id, total_cents, expires_at, status FROM quotes WHERE id = ? AND request_id = ?`)
        .bind(proposal.quote_id, id)
        .first<{ id: string; total_cents: number; expires_at: string; status: string }>();
      if (!quote || quote.status === 'superseded') {
        return errorJson('stale_proposal', 'A newer proposal has replaced this one. Send the current proposal instead.', 409);
      }

      const lines = await db
        .prepare(`SELECT kind, label, amount_cents FROM quote_line_items WHERE quote_id = ? ORDER BY sort`)
        .bind(proposal.quote_id)
        .all<{ kind: string; label: string; amount_cents: number }>();
      const slots = await db
        .prepare(`SELECT starts_at FROM appointment_slots WHERE request_id = ? AND status IN ('offered','held','confirmed') ORDER BY starts_at`)
        .bind(id)
        .all<{ starts_at: string }>();

      const emailResult = await deliverProposalEmail(env, db, {
        requestId: id, proposalId: proposal.id, ref: req.ref, email: req.email, config, base,
        priceLines: (lines.results ?? []).map((l) => `  ${l.label}: ${l.kind === 'discount' ? '−' : ''}${formatCents(Math.abs(l.amount_cents))}`),
        totals: { totalCents: quote.total_cents },
        slotStarts: (slots.results ?? []).map((s) => s.starts_at),
        expiresAt: quote.expires_at,
        customerMessage: proposal.customer_message ?? '',
      });
      await auditLog(db, actor, 'retry_proposal_notification', 'ppi_request', id, { proposalId: proposal.id, emailStatus: emailResult.status });
      return json({
        ok: true,
        notification: { messageId: emailResult.id, emailStatus: emailResult.status, deliveryConfirmed: emailResult.status === 'sent' },
      }, emailResult.status === 'failed' ? 207 : 200);
    }

    // ------------------------------------------------------------- send_quote
    case 'send_quote': {
      const priorPayment = await db
        .prepare(
          `SELECT id FROM payments
           WHERE request_id = ? AND status IN ('succeeded','partially_refunded','refunded','disputed') LIMIT 1`,
        )
        .bind(id)
        .first<{ id: string }>();
      if (priorPayment) {
        return errorJson(
          'payment_already_received',
          'This request already has a recorded payment. Use paid time reselection; no replacement quote was sent.',
          409,
        );
      }
      const quote = await db
        .prepare(`SELECT id, version, total_cents, expires_at FROM quotes WHERE id = ? AND request_id = ? AND status = 'draft'`)
        .bind(clampStr(body.quoteId, 60), id)
        .first<{ id: string; version: number; total_cents: number; expires_at: string }>();
      if (!quote) return errorJson('not_found', 'Draft quote not found.', 404);
      if (status !== 'quote_prepared') return errorJson('wrong_state', 'Prepare the quote first.', 409);

      const now = nowIso();
      await db.prepare(`UPDATE quotes SET status = 'sent', updated_at = ? WHERE id = ?`).bind(now, quote.id).run();
      await applyStatus(db, id, 'quote_prepared', 'quote_sent', actor, `Quote v${quote.version} sent`, quote.id);

      let token: string;
      try {
        ({ token } = await issueMagicLink(db, id, config, false));
      } catch (e) {
        await auditLog(db, actor, 'send_quote', 'quote', quote.id, { notification: 'link_failed' });
        return notificationLinkFailureResponse(db, actor, id, 'send_quote', e);
      }
      const emailResult = await sendTemplate(env, db, id, 'quote_ready', req.email, {
        ref: req.ref,
        portalUrl: portalUrl(base, token),
        supportEmail: config.supportEmail,
        extra: {
          summary: `Total: ${formatCents(quote.total_cents)}`,
          expires: new Date(quote.expires_at).toLocaleString('en-US', { timeZone: config.scheduling.timezone }),
        },
      });
      await db
        .prepare(`INSERT INTO analytics_events (id, event, step, source, created_at) VALUES (?, 'ppi_quote_sent', NULL, ?, ?)`)
        .bind(newId('ev'), req.attribution_source || 'ppi_unknown', now)
        .run();
      await auditLog(db, actor, 'send_quote', 'quote', quote.id);
      const emailFailure = await notificationFailureResponse(db, actor, id, 'send_quote', emailResult);
      if (emailFailure) return emailFailure;
      return json({
        ok: true,
        notification: { messageId: emailResult.id, emailStatus: emailResult.status, deliveryConfirmed: emailResult.status === 'sent' },
      });
    }

    // ---------------------------------------------------------- propose_slots
    case 'propose_slots': {
      if (!flags.bookingEnabled) return errorJson('booking_disabled', 'Booking is disabled in this environment.', 409);
      // A times-only email is useful only when the existing portal can book it.
      // Preserve paid reselection, including its accepted/expired quote behavior.
      const [manualQuotes, manualPayments] = await Promise.all([
        db.prepare(`SELECT status, expires_at FROM quotes WHERE request_id = ? ORDER BY version DESC`).bind(id).all<Record<string, unknown>>(),
        db.prepare(`SELECT status, booking_id FROM payments WHERE request_id = ? ORDER BY updated_at DESC`).bind(id).all<Record<string, unknown>>(),
      ]);
      const manualError = manualSlotOfferError(status, manualQuotes.results ?? [], manualPayments.results ?? []);
      if (manualError) return errorJson('manual_slots_not_bookable', manualError, 409);
      const slotsIn = (body.slots ?? []).slice(0, MAX_OFFERED_SLOTS);
      if (slotsIn.length === 0) return errorJson('validation', 'Provide at least one slot start time (ISO).', 422);
      const now = nowIso();
      const nowMs = Date.now();
      const inserted: string[] = [];
      const skipped: string[] = [];
      for (const startRaw of slotsIn) {
        const start = new Date(String(startRaw));
        if (Number.isNaN(start.getTime()) || start.getTime() < nowMs + config.scheduling.minLeadHours * 3600_000 - 60_000) {
          skipped.push(`${startRaw} (past or under ${config.scheduling.minLeadHours}h lead)`);
          continue;
        }
        if (start.getTime() > nowMs + config.scheduling.maxAdvanceDays * 86_400_000 + 60_000) {
          skipped.push(`${startRaw} (beyond the ${config.scheduling.maxAdvanceDays}-day scheduling window)`);
          continue;
        }
        const dateError = appointmentDateError(start, config, req);
        if (dateError) { skipped.push(`${startRaw} — ${dateError}`); continue; }
        const end = new Date(start.getTime() + config.scheduling.durationMin * 60_000);
        const blockedStart = new Date(start.getTime() - config.scheduling.travelBufferMin * 60_000).toISOString();
        const blockedEnd = new Date(end.getTime() + config.scheduling.reportBufferMin * 60_000).toISOString();
        // Friendly preflight; the 0015 triggers are the concurrency-safe
        // authority. Only held and confirmed windows reserve capacity.
        const clash = await db
          .prepare(
            `SELECT id FROM appointment_slots WHERE status IN ('held','confirmed')
             AND COALESCE(blocked_starts_at, starts_at) < ?
             AND COALESCE(blocked_ends_at, ends_at) > ? LIMIT 1`,
          )
          .bind(blockedEnd, blockedStart)
          .first<{ id: string }>();
        if (clash) {
          skipped.push(`${startRaw} (conflicts with an existing appointment incl. buffers)`);
          continue;
        }
        const slotId = newId('slt');
        try {
          await db
            .prepare(
              `INSERT INTO appointment_slots
                 (id, request_id, starts_at, ends_at, blocked_starts_at, blocked_ends_at, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'offered', ?, ?)`,
            )
            .bind(slotId, id, start.toISOString(), end.toISOString(), blockedStart, blockedEnd, now, now)
            .run();
          inserted.push(slotId);
        } catch {
          skipped.push(`${startRaw} (conflicts with an existing appointment incl. buffers)`);
        }
      }
      await auditLog(db, actor, 'propose_slots', 'ppi_request', id, { inserted, skipped });
      if (inserted.length > 0) {
        let token: string;
        try {
          ({ token } = await issueMagicLink(db, id, config, false));
        } catch (e) {
          return notificationLinkFailureResponse(db, actor, id, 'propose_slots', e);
        }
        const slotRows = await db
          .prepare(`SELECT starts_at FROM appointment_slots WHERE request_id = ? AND status = 'offered' ORDER BY starts_at`)
          .bind(id)
          .all<{ starts_at: string }>();
        const emailResult = await sendTemplate(env, db, id, 'slots_offered', req.email, {
          ref: req.ref,
          portalUrl: portalUrl(base, token),
          supportEmail: config.supportEmail,
          extra: { slots: (slotRows.results ?? []).map((s) => `• ${fmtSlot(s.starts_at, config.scheduling.timezone)}`).join('\n') },
        });
        const emailFailure = await notificationFailureResponse(db, actor, id, 'propose_slots', emailResult);
        if (emailFailure) return emailFailure;
        return json({
          ok: true,
          inserted: inserted.length,
          skipped,
          notification: { messageId: emailResult.id, emailStatus: emailResult.status, deliveryConfirmed: emailResult.status === 'sent' },
        });
      }
      return json({ ok: true, inserted: inserted.length, skipped });
    }

    // ------------------------------------------------------------ release_slot
    case 'release_slot': {
      const slotId = clampStr(body.slotId, 60);
      const slot = await db
        .prepare(`SELECT status FROM appointment_slots WHERE id = ? AND request_id = ? AND status IN ('offered','held')`)
        .bind(slotId, id)
        .first<{ status: string }>();
      if (!slot) return errorJson('not_found', 'Slot not found or not releasable.', 404);
      const now = nowIso();
      if ((slot.status === 'held' || slot.status === 'offered')
        && (status === 'awaiting_agreement' || status === 'awaiting_payment')) {
        if (status === 'awaiting_payment') {
          const checkoutExpiry = await expireOpenCheckoutAttempts(env, id);
          if (!checkoutExpiry.ok) {
            return errorJson(
              checkoutExpiry.code,
              'The slot was not released because an open Checkout attempt could not be proven expired. Reconcile it before retrying.',
              checkoutExpiry.code === 'payments_unavailable' ? 503 : 409,
            );
          }
        }

        // Claim the state move inside the same D1 transaction as the release.
        // The open-payment predicate closes the post-expiry race: either a new
        // Checkout claim wins and every statement below is a no-op, or this
        // marker wins and checkout can no longer claim awaiting_payment.
        const historyId = newId('sh');
        const results = await db.batch([
          db
            .prepare(
              `INSERT INTO status_history
                 (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
               SELECT ?, ?, ?, 'awaiting_time_selection', ?, 'Appointment slot released by admin', ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM ppi_requests
                 WHERE id = ? AND status = ? AND deleted_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM payments
                     WHERE request_id = ? AND status IN ('created','pending')
                   )
               )`,
            )
            .bind(historyId, id, status, actor, slotId, now, id, status, id),
          db
            .prepare(
              `UPDATE ppi_requests SET status = 'awaiting_time_selection', updated_at = ?
               WHERE id = ? AND status = ? AND deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM status_history WHERE id = ?)`,
            )
            .bind(now, id, status, historyId),
          db
            .prepare(
              `UPDATE appointment_slots
               SET status = 'released', hold_expires_at = NULL, updated_at = ?
               WHERE id = ? AND request_id = ? AND status = ?
                 AND EXISTS (SELECT 1 FROM status_history WHERE id = ?)
                 AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_time_selection')`,
            )
            .bind(now, slotId, id, slot.status, historyId, id),
          db
            .prepare(
              `UPDATE bookings SET slot_id = NULL, status = 'pending_payment', updated_at = ?
               WHERE request_id = ?
                 AND EXISTS (SELECT 1 FROM status_history WHERE id = ?)
                 AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = 'awaiting_time_selection')`,
            )
            .bind(now, id, historyId, id),
        ]);
        if (
          (results[0]?.meta?.changes ?? 0) !== 1
          || (results[1]?.meta?.changes ?? 0) !== 1
          || (results[2]?.meta?.changes ?? 0) !== 1
        ) {
          return errorJson(
            'reconciliation_required',
            'The request, slot, or Checkout state changed concurrently. The slot was not safely released; reload and reconcile before retrying.',
            409,
          );
        }
      } else {
        const released = await db
          .prepare(
            `UPDATE appointment_slots SET status = 'released', hold_expires_at = NULL, updated_at = ?
             WHERE id = ? AND request_id = ? AND status = ?`,
          )
          .bind(now, slotId, id, slot.status)
          .run();
        if ((released.meta?.changes ?? 0) !== 1) {
          return errorJson('conflict', 'The slot changed concurrently — reload and retry.', 409);
        }
      }
      await auditLog(db, actor, 'release_slot', 'appointment_slot', slotId);
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
      let token: string;
      try {
        ({ token } = await issueMagicLink(db, id, config, false));
      } catch (e) {
        await auditLog(db, actor, 'send_message', 'ppi_request', id, { notification: 'link_failed' });
        return notificationLinkFailureResponse(db, actor, id, 'send_message', e);
      }
      const emailResult = await sendTemplate(env, db, id, 'needs_info', req.email, {
        ref: req.ref,
        portalUrl: portalUrl(base, token),
        supportEmail: config.supportEmail,
        extra: { note },
      });
      await auditLog(db, actor, 'send_message', 'ppi_request', id);
      const emailFailure = await notificationFailureResponse(db, actor, id, 'send_message', emailResult);
      if (emailFailure) return emailFailure;
      return json({
        ok: true,
        notification: { messageId: emailResult.id, emailStatus: emailResult.status, deliveryConfirmed: emailResult.status === 'sent' },
      });
    }

    // ------------------------------------------------------------- retry_email
    case 'retry_email': {
      const messageId = clampStr(body.messageId, 80);
      if (!messageId) return errorJson('validation', 'Choose an email message to retry.', 422);
      const message = await db
        .prepare(
          `SELECT id, request_id, template, to_email, subject, body_text, status, created_at
           FROM messages
           WHERE id = ? AND request_id = ? AND direction = 'outbound' AND channel = 'email'`,
        )
        .bind(messageId, id)
        .first<StoredEmailMessage>();
      if (!message) return errorJson('not_found', 'Email message not found for this request.', 404);
      if (!(['recorded', 'failed', 'sent'] as EmailStatus[]).includes(message.status)) {
        return errorJson('wrong_state', 'This message cannot be retried.', 409);
      }
      if (message.status === 'sent') {
        return errorJson('already_sent', 'This email is already marked sent; it was not sent again.', 409);
      }

      const recordedSupport = message.body_text?.match(/^Questions\?\s+([^\s]+@[^\s]+)$/m)?.[1];
      const replyTo = message.template?.startsWith('owner_') ? req.email : (recordedSupport ?? config.supportEmail);
      const result = await retryStoredEmail(env, db, message, replyTo, {
        publicBaseUrl: base,
        config,
        confirmFreshAfterWindow: body.confirmFresh === true,
      });
      await auditLog(db, actor, 'retry_email', 'message', message.id, {
        from: message.status,
        to: result.status,
        deliveredMessageId: result.id,
        failure: result.failure,
      });
      if (result.status === 'recorded') {
        return errorJson('email_provider_unavailable', 'Email is still recorded, but no delivery provider is configured.', 503, {
          messageId: result.id,
          emailStatus: result.status,
        });
      }
      if (result.status === 'failed') {
        if (result.failure === 'idempotency_window_expired') {
          return errorJson(
            'email_retry_window_expired',
            'This message is more than 24 hours old, so the provider can no longer guarantee a retry will not duplicate it. Review delivery history, then explicitly confirm a fresh copy if needed.',
            409,
            {
              messageId: message.id,
              emailStatus: result.status,
              emailFailure: result.failure,
              requiresFreshConfirmation: true,
            },
          );
        }
        const linkFailure = result.failure === 'link_refresh_failed' || result.failure === 'invalid_stored_message';
        const outboxFailure = result.failure === 'outbox_record_failed' || result.failure === 'template_failed';
        return errorJson(
          linkFailure ? 'email_link_refresh_failed' : (outboxFailure ? 'email_retry_not_recorded' : 'email_retry_failed'),
          linkFailure
            ? 'The stored secure link is no longer usable, and a fresh message could not be prepared. No stale link was sent.'
            : (outboxFailure
                ? 'A safe retry could not be added to the delivery queue. No stale link was sent.'
                : 'The provider did not accept the retry. The message remains available to retry again.'),
          linkFailure || outboxFailure ? 503 : 502,
          {
          messageId: result.id,
          emailStatus: result.status,
          emailFailure: result.failure ?? null,
          },
        );
      }
      return json({ ok: true, messageId: result.id, emailStatus: result.status });
    }

    // ----------------------------------------------------------------- refund
    case 'refund': {
      const payment = await db
        .prepare(`SELECT id, stripe_payment_intent, amount_cents, refunded_cents, currency, status FROM payments WHERE id = ? AND request_id = ?`)
        .bind(clampStr(body.paymentId, 60), id)
        .first<{ id: string; stripe_payment_intent: string | null; amount_cents: number; refunded_cents: number; currency: string; status: string }>();
      if (!payment) return errorJson('not_found', 'Payment not found.', 404);
      if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
        return errorJson('wrong_state', 'Only succeeded payments can be refunded.', 409);
      }
      if (!payment.stripe_payment_intent) return errorJson('wrong_state', 'No payment intent recorded.', 409);
      if (payment.currency.toLowerCase() !== 'usd') {
        return errorJson('refund_reconciliation_required', 'This payment has an unsupported currency and must be reconciled before a refund is submitted.', 409);
      }
      const amount = Number.isSafeInteger(body.amountCents) && (body.amountCents as number) > 0 ? (body.amountCents as number) : undefined;
      if (amount !== undefined && amount > payment.amount_cents - payment.refunded_cents) {
        return errorJson('validation', 'Refund exceeds the remaining refundable amount.', 422);
      }
      const refundAmount = amount ?? (payment.amount_cents - payment.refunded_cents);
      if (refundAmount <= 0) return errorJson('wrong_state', 'This payment is already fully refunded.', 409);
      const requestedOperationId = clampStr(body.refundOperationId, 80);
      let operation = await db
        .prepare(
          `SELECT id, payment_id, request_id, starting_refunded_cents, requested_amount_cents,
                  idempotency_key, status, attempt_count, provider_refund_id
           FROM refund_operations
           WHERE payment_id = ? AND starting_refunded_cents = ? LIMIT 1`,
        )
        .bind(payment.id, payment.refunded_cents)
        .first<RefundOperationRow>();

      let attemptNo: number;
      let idempotencyKey: string;
      let effectiveRefundAmount = refundAmount;
      const claimTime = nowIso();

      if (operation) {
        if (operation.status !== 'failed' && operation.status !== 'canceled') {
          return errorJson(
            'refund_reconciliation_required',
            'A refund from this payment balance is already recorded. Wait for its provider result or reconcile it before another attempt.',
            409,
            { operationId: operation.id, operationStatus: operation.status },
          );
        }
        if (requestedOperationId !== operation.id) {
          return errorJson(
            'refund_retry_available',
            'The prior refund definitively failed. Review it, then explicitly retry that recorded operation.',
            409,
            { operationId: operation.id, operationStatus: operation.status, retryAllowed: true },
          );
        }
        if (amount !== undefined && amount !== operation.requested_amount_cents) {
          return errorJson('refund_retry_amount_mismatch', 'A retry must use the original refund amount.', 409, {
            operationId: operation.id,
            amountCents: operation.requested_amount_cents,
          });
        }

        effectiveRefundAmount = operation.requested_amount_cents;
        attemptNo = operation.attempt_count + 1;
        idempotencyKey = `refund/${operation.id}/${attemptNo}`;
        const attemptId = newId('rfa');
        const retryClaim = await db.batch([
          db
            .prepare(
              `UPDATE refund_operations
               SET status = 'requested', attempt_count = ?, idempotency_key = ?, provider_refund_id = NULL,
                   last_provider_status = NULL, last_error = NULL, updated_at = ?
               WHERE id = ? AND status = ? AND attempt_count = ?
                 AND EXISTS (
                   SELECT 1 FROM payments
                   WHERE id = ? AND request_id = ? AND refunded_cents = ?
                     AND status IN ('succeeded','partially_refunded')
                 )`,
            )
            .bind(
              attemptNo,
              idempotencyKey,
              claimTime,
              operation.id,
              operation.status,
              operation.attempt_count,
              payment.id,
              id,
              payment.refunded_cents,
            ),
          db
            .prepare(
              `INSERT OR IGNORE INTO refund_operation_attempts
                 (id, operation_id, attempt_no, idempotency_key, outcome_status, created_at, updated_at)
               SELECT ?, ?, ?, ?, 'requested', ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM refund_operations
                 WHERE id = ? AND status = 'requested' AND attempt_count = ? AND idempotency_key = ?
               )`,
            )
            .bind(attemptId, operation.id, attemptNo, idempotencyKey, claimTime, claimTime, operation.id, attemptNo, idempotencyKey),
        ]);
        if ((retryClaim[0]?.meta?.changes ?? 0) !== 1 || (retryClaim[1]?.meta?.changes ?? 0) !== 1) {
          return errorJson(
            'refund_reconciliation_required',
            'The refund balance or operation changed before the retry could be claimed. Reload before taking another action.',
            409,
            { operationId: operation.id },
          );
        }
        operation = { ...operation, status: 'requested', attempt_count: attemptNo, idempotency_key: idempotencyKey };
        await auditLog(db, actor, 'refund_retry_claimed', 'refund_operation', operation.id, { attemptNo, amountCents: effectiveRefundAmount });
      } else {
        if (requestedOperationId) {
          return errorJson('not_found', 'The refund operation selected for retry was not found at this payment balance.', 404);
        }
        const operationId = newId('rfo');
        attemptNo = 1;
        idempotencyKey = `refund/${operationId}/${attemptNo}`;
        const attemptId = newId('rfa');
        try {
          const claimed = await db.batch([
            db
              .prepare(
                `INSERT INTO refund_operations
                   (id, payment_id, request_id, starting_refunded_cents, requested_amount_cents,
                    idempotency_key, status, attempt_count, created_at, updated_at)
                 SELECT ?, ?, ?, ?, ?, ?, 'requested', 1, ?, ?
                 WHERE EXISTS (
                   SELECT 1 FROM payments
                   WHERE id = ? AND request_id = ? AND refunded_cents = ?
                     AND status IN ('succeeded','partially_refunded')
                 )`,
              )
              .bind(
                operationId,
                payment.id,
                id,
                payment.refunded_cents,
                effectiveRefundAmount,
                idempotencyKey,
                claimTime,
                claimTime,
                payment.id,
                id,
                payment.refunded_cents,
              ),
            db
              .prepare(
                `INSERT INTO refund_operation_attempts
                   (id, operation_id, attempt_no, idempotency_key, outcome_status, created_at, updated_at)
                 SELECT ?, ?, 1, ?, 'requested', ?, ?
                 WHERE EXISTS (
                   SELECT 1 FROM refund_operations
                   WHERE id = ? AND status = 'requested' AND attempt_count = 1 AND idempotency_key = ?
                 )`,
              )
              .bind(attemptId, operationId, idempotencyKey, claimTime, claimTime, operationId, idempotencyKey),
          ]);
          if ((claimed[0]?.meta?.changes ?? 0) !== 1 || (claimed[1]?.meta?.changes ?? 0) !== 1) {
            return errorJson('refund_reconciliation_required', 'The refundable balance changed before this refund could be claimed.', 409);
          }
        } catch {
          const raced = await db
            .prepare(
              `SELECT id, status FROM refund_operations
               WHERE payment_id = ? AND starting_refunded_cents = ? LIMIT 1`,
            )
            .bind(payment.id, payment.refunded_cents)
            .first<{ id: string; status: string }>();
          if (raced) {
            return errorJson(
              'refund_reconciliation_required',
              'Another refund attempt claimed this payment balance first. No duplicate provider request was made.',
              409,
              { operationId: raced.id, operationStatus: raced.status },
            );
          }
          throw new Error('Refund operation could not be claimed.');
        }
        operation = {
          id: operationId,
          payment_id: payment.id,
          request_id: id,
          starting_refunded_cents: payment.refunded_cents,
          requested_amount_cents: effectiveRefundAmount,
          idempotency_key: idempotencyKey,
          status: 'requested',
          attempt_count: attemptNo,
          provider_refund_id: null,
        };
        await auditLog(db, actor, 'refund_claimed', 'refund_operation', operation.id, { attemptNo, amountCents: effectiveRefundAmount });
      }

      const settleAttempt = async (
        outcome: RefundOperationStatus,
        providerId: string | null,
        providerStatus: string | null,
        failure: string | null,
      ): Promise<RefundOperationRow> => {
        const settledAt = nowIso();
        try {
          await db.batch([
            db
              .prepare(
                `UPDATE refund_operation_attempts
                 SET provider_refund_id = ?, provider_status = ?, outcome_status = ?, error = ?, updated_at = ?
                 WHERE operation_id = ? AND attempt_no = ? AND idempotency_key = ? AND outcome_status = 'requested'`,
              )
              .bind(providerId, providerStatus, outcome, failure, settledAt, operation!.id, attemptNo, idempotencyKey),
            db
              .prepare(
                `UPDATE refund_operations
                 SET provider_refund_id = ?, last_provider_status = ?, last_error = ?, status = ?, updated_at = ?
                 WHERE id = ? AND attempt_count = ? AND idempotency_key = ? AND status = 'requested'`,
              )
              .bind(providerId, providerStatus, failure, outcome, settledAt, operation!.id, attemptNo, idempotencyKey),
          ]);
        } catch (settleError) {
          const detail = `refund result persistence failed: ${String(settleError).slice(0, 180)}`;
          await db.batch([
            db
              .prepare(
                `UPDATE refund_operation_attempts
                 SET provider_status = ?, outcome_status = 'reconciliation_required', error = ?, updated_at = ?
                 WHERE operation_id = ? AND attempt_no = ? AND outcome_status = 'requested'`,
              )
              .bind(providerStatus, detail, settledAt, operation!.id, attemptNo),
            db
              .prepare(
                `UPDATE refund_operations
                 SET provider_refund_id = NULL, last_provider_status = ?, last_error = ?,
                     status = 'reconciliation_required', updated_at = ?
                 WHERE id = ? AND attempt_count = ? AND status = 'requested'`,
              )
              .bind(providerStatus, detail, settledAt, operation!.id, attemptNo),
          ]);
        }
        const persisted = await db
          .prepare(
            `SELECT id, payment_id, request_id, starting_refunded_cents, requested_amount_cents,
                    idempotency_key, status, attempt_count, provider_refund_id
             FROM refund_operations WHERE id = ?`,
          )
          .bind(operation!.id)
          .first<RefundOperationRow>();
        if (!persisted) throw new Error(`Refund operation ${operation!.id} disappeared after provider submission.`);
        return persisted;
      };

      let providerRefund: Record<string, unknown>;
      try {
        providerRefund = await createRefund(
          env,
          payment.stripe_payment_intent,
          effectiveRefundAmount,
          idempotencyKey,
          { operationId: operation.id, attemptNo },
        );
      } catch (e) {
        if (e instanceof StripeConfigError) {
          const persisted = await settleAttempt('failed', null, null, 'stripe_configuration_unavailable');
          await auditLog(db, actor, 'refund_provider_failed', 'refund_operation', operation.id, {
            attemptNo,
            outcome: persisted.status,
            failure: 'configuration',
          });
          return errorJson('payments_unavailable', 'Payments are not configured in this environment. The failed attempt is recorded and may be explicitly retried after repair.', 503, {
            operationId: operation.id,
            operationStatus: persisted.status,
            retryAllowed: persisted.status === 'failed',
          });
        }
        const failure = `ambiguous_provider_error:${String(e).slice(0, 180)}`;
        const persisted = await settleAttempt('reconciliation_required', null, null, failure);
        await auditLog(db, actor, 'refund_provider_ambiguous', 'refund_operation', operation.id, { attemptNo, outcome: persisted.status });
        return refundResultResponse(operation.id, persisted.status, null);
      }

      const providerStatus = classifyStripeRefundStatus(providerRefund);
      const providerIdentity = validateStripeRefundIdentity(providerRefund, {
        paymentIntent: payment.stripe_payment_intent,
        amountCents: effectiveRefundAmount,
        currency: payment.currency,
        operationId: operation.id,
        attemptNo,
      });
      if (!providerIdentity.ok) {
        const detail = `provider_identity_mismatch:${providerIdentity.reason}`;
        const persisted = await settleAttempt(
          'reconciliation_required',
          providerIdentity.providerRefundId,
          providerStatus,
          detail,
        );
        await auditLog(db, actor, 'refund_provider_identity_mismatch', 'refund_operation', operation.id, {
          attemptNo,
          reason: providerIdentity.reason,
          providerStatus,
          operationStatus: persisted.status,
        });
        return refundResultResponse(operation.id, persisted.status, providerStatus);
      }
      const providerId = providerIdentity.providerRefundId;
      const outcome = refundOutcome(providerStatus, providerId);
      const failure = outcome === 'failed' || outcome === 'canceled' || outcome === 'requires_action' || outcome === 'reconciliation_required'
        ? clampStr(providerRefund['failure_reason'] ?? providerRefund['failure_message'] ?? `provider_status:${providerStatus}`, 240)
        : null;
      const persisted = await settleAttempt(outcome, providerId, providerStatus, failure);
      if (providerId) {
        const attempt = await db
          .prepare(`SELECT id FROM refund_operation_attempts WHERE operation_id = ? AND attempt_no = ?`)
          .bind(operation.id, attemptNo)
          .first<{ id: string }>();
        if (!attempt) throw new Error(`Refund attempt ${operation.id}/${attemptNo} disappeared before ledger seeding.`);
        try {
          await upsertProviderRefund(db, {
            providerRefundId: providerId,
            paymentId: payment.id,
            operationId: operation.id,
            attemptId: attempt.id,
            amountCents: providerIdentity.amountCents,
            currency: providerIdentity.currency,
            providerCreated: providerIdentity.providerCreated,
            status: providerStatus,
            eventCreated: providerIdentity.providerCreated,
            eventId: `admin_response:${operation.id}:${attemptNo}`,
          });
        } catch (ledgerError) {
          const detail = `refund ledger persistence failed: ${String(ledgerError).slice(0, 180)}`;
          await db.batch([
            db
              .prepare(
                `UPDATE refund_operation_attempts
                 SET outcome_status = 'reconciliation_required', error = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .bind(detail, nowIso(), attempt.id),
            db
              .prepare(
                `UPDATE refund_operations
                 SET status = 'reconciliation_required', last_error = ?, updated_at = ?
                 WHERE id = ? AND attempt_count = ?`,
              )
              .bind(detail, nowIso(), operation.id, attemptNo),
          ]);
          await auditLog(db, actor, 'refund_ledger_seed_failed', 'refund_operation', operation.id, { attemptNo, detail });
          return refundResultResponse(operation.id, 'reconciliation_required', providerStatus);
        }
      }
      await auditLog(db, actor, 'refund_provider_result', 'refund_operation', operation.id, {
        attemptNo,
        amountCents: effectiveRefundAmount,
        providerStatus,
        operationStatus: persisted.status,
      });
      return refundResultResponse(operation.id, persisted.status, providerStatus);
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
