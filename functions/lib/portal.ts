// Shared helpers for the customer portal: token auth, lazy hold expiry, and
// the customer-visible view of a request (never internal notes or risk data).

import { appointmentDateError } from './appointment-eligibility.ts';
import { DISCOVERY_OPTIONS } from './discovery.ts';
import { modeFlags, type Env } from './types.ts';
import type { PpiConfig } from './config.ts';
import { inspectMagicToken, verifyMagicToken } from './magic.ts';
import { rateLimit, rateLimitStatus } from './ratelimit.ts';
import { clientIp, errorJson, nowIso } from './util.ts';
import { latestAgreements } from './agreements.ts';
import { STATUS_LABELS, type Status } from './status.ts';
import { quoteExpired } from './pricing.ts';
import { loadPublishedReportVersion, type CustomerReportPayload } from './published-report.ts';

export type PortalAuth = { ok: true; requestId: string; token: string } | { ok: false; response: Response };

/** Private report photos use a separate bounded asset budget. Invalid tokens
 * retain a prechecked 60/hour failure budget; every read rechecks revocation. */
export async function requirePortalAsset(request:Request,env:Env):Promise<PortalAuth>{
  const ip=clientIp(request);
  const failureBudget=await rateLimitStatus(env.DB,ip,'portal_asset_invalid',60,3600);
  const assetBudget=await rateLimit(env.DB,ip,'portal_asset',600,3600);
  if(!failureBudget.allowed||!assetBudget.allowed)return {ok:false,response:errorJson('rate_limited','Too many attempts. Please try again later.',429)};
  const header=request.headers.get('authorization')||'';
  const token=header.startsWith('Bearer ')?header.slice(7):'';
  const result=await inspectMagicToken(env.DB,token);
  if(!result.ok){await rateLimit(env.DB,ip,'portal_asset_invalid',60,3600);return {ok:false,response:errorJson(`link_${result.reason}`,'Use your current secure AutoClarity portal link to view this photo.',401)};}
  return {ok:true,requestId:result.requestId,token};
}

export async function requirePortal(request: Request, env: Env): Promise<PortalAuth> {
  const limited = await rateLimit(env.DB, clientIp(request), 'portal_token', 60, 3600);
  if (!limited.allowed) {
    return { ok: false, response: errorJson('rate_limited', 'Too many attempts. Please try again later.', 429) };
  }
  const header = request.headers.get('authorization') ?? '';
  const url = new URL(request.url);
  const token = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('t') ?? '');
  const result = await verifyMagicToken(env.DB, token);
  if (!result.ok) {
    const messages = {
      invalid: 'This link is not valid. Check the most recent email from AutoClarity or contact support.',
      expired: 'This link has expired. Contact AutoClarity support for help accessing your request.',
      revoked: 'This link was replaced. Use the most recent secure link from AutoClarity or contact support.',
    } as const;
    return { ok: false, response: errorJson(`link_${result.reason}`, messages[result.reason], 401) };
  }
  return { ok: true, requestId: result.requestId, token };
}

/** Release held slots whose hold window lapsed (lazy — no cron needed). */
export async function releaseExpiredHolds(db: D1Database): Promise<void> {
  const now = nowIso();
  // D1 batch is transactional. History/state, any pending booking, and the
  // slot move together, so the portal never strands a request in checkout
  // after its hold has become selectable again.
  await db.batch([
    db
      .prepare(
        `INSERT INTO status_history (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
         SELECT 'sh_' || lower(hex(randomblob(16))), r.id, r.status, 'awaiting_time_selection',
                'system:hold-expiry', 'Appointment hold expired',
                (SELECT s.id FROM appointment_slots s
                 WHERE s.request_id = r.id AND s.status = 'held' AND s.hold_expires_at < ?
                 ORDER BY s.hold_expires_at LIMIT 1), ?
         FROM ppi_requests r
         WHERE r.status IN ('awaiting_agreement','awaiting_payment')
           AND r.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM appointment_slots s
             WHERE s.request_id = r.id AND s.status = 'held' AND s.hold_expires_at < ?
           )`,
      )
      .bind(now, now, now),
    db
      .prepare(
        `UPDATE ppi_requests SET status = 'awaiting_time_selection', updated_at = ?
         WHERE status IN ('awaiting_agreement','awaiting_payment') AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM appointment_slots s
             WHERE s.request_id = ppi_requests.id AND s.status = 'held' AND s.hold_expires_at < ?
           )`,
      )
      .bind(now, now),
    db
      .prepare(
        `UPDATE bookings SET slot_id = NULL, status = 'pending_payment', updated_at = ?
         WHERE status = 'pending_payment'
           AND EXISTS (
             SELECT 1 FROM appointment_slots s
             WHERE s.id = bookings.slot_id AND s.status = 'held' AND s.hold_expires_at < ?
           )`,
      )
      .bind(now, now),
    db
      .prepare(
        `UPDATE appointment_slots
         SET status = 'offered', hold_expires_at = NULL, updated_at = ?
         WHERE status = 'held' AND hold_expires_at < ?`,
      )
      .bind(now, now),

    // Second repair: a request sitting at the agreement or payment step with
    // NO held slot at all. The statements above only fire while an expired
    // hold still exists, so a request whose slot was released by any other
    // path — an admin release, an earlier sweep, a crash between statements —
    // stayed in that status forever. The customer then saw a price with no
    // way to act on it and no explanation, which is exactly the dead end this
    // release exists to remove. Requests with settled money are excluded:
    // those follow the dedicated paid-reselection and dispute paths.
    db
      .prepare(
        `INSERT INTO status_history (id, request_id, from_status, to_status, actor, reason, created_at)
         SELECT 'sh_' || lower(hex(randomblob(16))), r.id, r.status, 'awaiting_time_selection',
                'system:hold-repair', 'No held appointment remained for this step', ?
         FROM ppi_requests r
         WHERE r.status IN ('awaiting_agreement','awaiting_payment')
           AND r.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM appointment_slots s WHERE s.request_id = r.id AND s.status = 'held')
           AND NOT EXISTS (
             SELECT 1 FROM payments p WHERE p.request_id = r.id
               AND p.status IN ('succeeded','partially_refunded','refunded','disputed')
           )`,
      )
      .bind(now),
    db
      .prepare(
        `UPDATE ppi_requests SET status = 'awaiting_time_selection', updated_at = ?
         WHERE status IN ('awaiting_agreement','awaiting_payment') AND deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM appointment_slots s WHERE s.request_id = ppi_requests.id AND s.status = 'held')
           AND NOT EXISTS (
             SELECT 1 FROM payments p WHERE p.request_id = ppi_requests.id
               AND p.status IN ('succeeded','partially_refunded','refunded','disputed')
           )`,
      )
      .bind(now),
  ]);
}

export interface PortalView {
  discovery: { source: string | null; detail: string | null };
  discoveryOptions: typeof DISCOVERY_OPTIONS;
  ref: string;
  status: Status;
  statusLabel: string;
  vehicle: { year: number | null; make: string; model: string; trim: string | null; vin: string | null };
  location: { city: string | null; state: string | null; zip: string | null; street: string | null };
  quote: null | {
    id: string;
    version: number;
    status: string;
    expiresAt: string;
    expired: boolean;
    customerNote: string | null;
    lines: Array<{ kind: string; label: string; amountCents: number }>;
    totalCents: number;
  };
  slots: Array<{ id: string; startsAt: string; endsAt: string; status: string; holdExpiresAt: string | null }>;
  agreements: {
    required: Array<{ id: string; docKey: string; title: string; version: number; bodyMd: string }>;
    accepted: string[]; // agreement_version_ids already accepted
    typedName: string | null;
  };
  payment: null | { status: string; amountCents: number };
  booking: null | { status: string; startsAt: string | null; endsAt: string | null };
  /** Exact immutable version selected by this request's published report. */
  report: null | {
    reportId: string;
    versionId: string;
    version: number;
    kind: string;
    publishedAt: string;
    payloadSha256: string;
    payload: CustomerReportPayload;
    amended: boolean;
  };
  uploads: Array<{ id: string; name: string; kind: string }>;
  messages: Array<{ direction: string; body: string; createdAt: string }>;
  supportEmail: string;
  paymentsEnabled: boolean;
}

export async function loadPortalView(env: Env, config: PpiConfig, requestId: string): Promise<PortalView | null> {
  const db = env.DB;
  await releaseExpiredHolds(db);

  const req = await db
    .prepare(
      `SELECT r.*, c.full_name, c.email, v.year, v.make, v.model, v.trim, v.vin
       FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(requestId)
    .first<Record<string, unknown>>();
  if (!req) return null;

  const quoteRow = await db
    .prepare(
      `SELECT * FROM quotes WHERE request_id = ? AND status IN ('sent','accepted')
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(requestId)
    .first<Record<string, unknown>>();

  let quote: PortalView['quote'] = null;
  if (quoteRow) {
    const lines = await db
      .prepare(`SELECT kind, label, amount_cents FROM quote_line_items WHERE quote_id = ? ORDER BY sort`)
      .bind(String(quoteRow['id']))
      .all<{ kind: string; label: string; amount_cents: number }>();
    quote = {
      id: String(quoteRow['id']),
      version: Number(quoteRow['version']),
      status: String(quoteRow['status']),
      expiresAt: String(quoteRow['expires_at']),
      expired: quoteExpired(String(quoteRow['expires_at'])),
      customerNote: (quoteRow['customer_note'] as string | null) ?? null,
      lines: (lines.results ?? []).map((l) => ({ kind: l.kind, label: l.label, amountCents: l.amount_cents })),
      totalCents: Number(quoteRow['total_cents']),
    };
  }

  const slots = await db
    .prepare(
      `SELECT id, starts_at, ends_at, status, hold_expires_at FROM appointment_slots
       WHERE request_id = ? AND status IN ('offered','held','confirmed') ORDER BY starts_at`,
    )
    .bind(requestId)
    .all<{ id: string; starts_at: string; ends_at: string; status: string; hold_expires_at: string | null }>();

  const agreementDocs = await latestAgreements(db);
  const acceptances = await db
    .prepare(
      `SELECT agreement_version_id, typed_name FROM agreement_acceptances
       WHERE request_id = ? AND quote_id = ? AND accepted = 1`,
    )
    .bind(requestId, quote?.id ?? '')
    .all<{ agreement_version_id: string; typed_name: string }>();
  const currentAgreementIds = new Set(agreementDocs.map((doc) => doc.id));
  const currentAcceptances = (acceptances.results ?? []).filter((acceptance) => currentAgreementIds.has(acceptance.agreement_version_id));

  const paymentRow = await db
    .prepare(`SELECT status, amount_cents FROM payments WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(requestId)
    .first<{ status: string; amount_cents: number }>();

  const bookingRow = await db
    .prepare(
      `SELECT b.status, s.starts_at, s.ends_at FROM bookings b
       LEFT JOIN appointment_slots s ON s.id = b.slot_id WHERE b.request_id = ?`,
    )
    .bind(requestId)
    .first<{ status: string; starts_at: string | null; ends_at: string | null }>();

  const uploads = await db
    .prepare(`SELECT id, original_name, kind FROM request_uploads WHERE request_id = ? AND deleted_at IS NULL`)
    .bind(requestId)
    .all<{ id: string; original_name: string; kind: string }>();

  const messages = await db
    .prepare(
      `SELECT direction, body_text, created_at FROM messages
       WHERE request_id = ? AND direction IN ('outbound','inbound') AND channel = 'portal'
       ORDER BY created_at DESC LIMIT 30`,
    )
    .bind(requestId)
    .all<{ direction: string; body_text: string; created_at: string }>();

  // No draft or merely-latest version is eligible for this authenticated
  // customer response. The report's explicit published pointer is authoritative.
  const publishedReport = await loadPublishedReportVersion(db, requestId);

  const status = String(req['status']) as Status;
  return {
    discovery: { source: (req['discovery_source'] as string | null) ?? null, detail: (req['discovery_detail'] as string | null) ?? null },
    discoveryOptions: DISCOVERY_OPTIONS,
    ref: String(req['ref']),
    status,
    statusLabel: STATUS_LABELS[status] ?? String(req['status']),
    vehicle: {
      year: (req['year'] as number | null) ?? null,
      make: String(req['make']),
      model: String(req['model']),
      trim: (req['trim'] as string | null) ?? null,
      vin: (req['vin'] as string | null) ?? null,
    },
    location: {
      city: (req['loc_city'] as string | null) ?? null,
      state: (req['loc_state'] as string | null) ?? null,
      zip: (req['loc_zip'] as string | null) ?? null,
      street: (req['loc_street'] as string | null) ?? null,
    },
    quote,
    // Keep historical held/confirmed records visible; only eligible offers are selectable.
    slots: (slots.results ?? []).filter((s) => s.status !== 'offered' || !appointmentDateError(new Date(s.starts_at), config, req)).map((s) => ({
      id: s.id,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      status: s.status,
      holdExpiresAt: s.hold_expires_at,
    })),
    agreements: {
      required: agreementDocs.map((d) => ({ id: d.id, docKey: d.doc_key, title: d.title, version: d.version, bodyMd: d.body_md })),
      accepted: currentAcceptances.map((a) => a.agreement_version_id),
      typedName: currentAcceptances[0]?.typed_name ?? null,
    },
    payment: paymentRow ? { status: paymentRow.status, amountCents: paymentRow.amount_cents } : null,
    booking: bookingRow ? { status: bookingRow.status, startsAt: bookingRow.starts_at, endsAt: bookingRow.ends_at } : null,
    report: publishedReport
      ? {
          ...publishedReport,
          amended: publishedReport.kind === 'amendment' || publishedReport.version > 1,
        }
      : null,
    uploads: (uploads.results ?? []).map((u) => ({ id: u.id, name: u.original_name, kind: u.kind })),
    messages: (messages.results ?? []).map((m) => ({ direction: m.direction, body: m.body_text, createdAt: m.created_at })),
    supportEmail: config.supportEmail,
    paymentsEnabled: modeFlags(env).paymentsEnabled,
  };
}
