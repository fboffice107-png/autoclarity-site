// POST /api/inspector/inspections — Start Inspection.
// Creates the report draft linked to the exact request/customer/vehicle/quote/
// booking. Idempotent by design: UNIQUE(request_id) at the database level means
// repeated taps, refreshes or races can never create a second report — the
// existing report is returned instead.

import type { Env } from '../../lib/types.ts';
import { requireAdmin } from '../../lib/auth.ts';
import { applyStatus, type Status } from '../../lib/status.ts';
import { REPORT_TEMPLATE_KEY, REPORT_TEMPLATE_VERSION } from '../../lib/report-template.ts';
import { getReportByRequest, reportAudit } from '../../lib/report.ts';
import { sendTemplate } from '../../lib/email.ts';
import { clampStr, errorJson, json, newId, nowIso, originAllowed } from '../../lib/util.ts';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!originAllowed(request, env.PUBLIC_BASE_URL)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return auth.response;
  const db = env.DB;

  let body: { requestId?: string };
  try {
    body = (await request.json()) as { requestId?: string };
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }
  const requestId = clampStr(body.requestId, 60);
  if (!requestId) return errorJson('validation', 'requestId is required.', 422);

  const req = await db
    .prepare(
      `SELECT r.id, r.ref, r.status, r.customer_id, r.vehicle_id, b.id AS booking_id, b.quote_id, b.status AS booking_status
       FROM ppi_requests r
       LEFT JOIN bookings b ON b.request_id = r.id
       WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(requestId)
    .first<{ id: string; ref: string; status: string; customer_id: string; vehicle_id: string; booking_id: string | null; quote_id: string | null; booking_status: string | null }>();
  if (!req) return errorJson('not_found', 'Request not found.', 404);

  // Duplicate-start guard #1: an existing report is simply resumed.
  const existing = await getReportByRequest(db, requestId);
  if (existing) return json({ ok: true, reportId: existing.id, existing: true, state: existing.state });

  const startable: string[] = ['confirmed', 'inspection_in_progress', 'report_in_progress'];
  if (!startable.includes(req.status)) {
    return errorJson('wrong_state', `An inspection can only be started for a confirmed booking (this request is "${req.status}").`, 409);
  }

  const now = nowIso();
  const reportId = newId('rpt');
  try {
    await db
      .prepare(
        `INSERT INTO inspection_reports (id, request_id, booking_id, customer_id, vehicle_id, quote_id, state,
           template_key, template_version, inspected_at, started_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(reportId, requestId, req.booking_id, req.customer_id, req.vehicle_id, req.quote_id, REPORT_TEMPLATE_KEY, REPORT_TEMPLATE_VERSION, now, auth.actor, now, now)
      .run();
  } catch (e) {
    // Duplicate-start guard #2: a concurrent tap hit the UNIQUE(request_id)
    // constraint — return the row that won.
    if (/UNIQUE|constraint/i.test(String(e))) {
      const winner = await getReportByRequest(db, requestId);
      if (winner) return json({ ok: true, reportId: winner.id, existing: true, state: winner.state });
    }
    throw e;
  }

  if (req.status === 'confirmed') {
    await applyStatus(db, requestId, 'confirmed' as Status, 'inspection_in_progress', auth.actor, 'Inspection started', reportId);
  }
  await reportAudit(db, auth.actor, 'start_inspection', { reportId, requestId }, { prev: null, next: 'in_progress' });

  // Owner/internal notification — recorded idempotently, never customer-facing.
  if (env.ADMIN_NOTIFY_EMAIL) {
    await sendTemplate(env, db, requestId, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
      ref: req.ref,
      supportEmail: 'support@getautoclarity.com',
      extra: { kind: 'inspection_started', detail: `Inspection started by ${auth.actor}` },
    }, undefined, `inspection_started:${reportId}`);
  }

  return json({ ok: true, reportId, existing: false, state: 'in_progress' });
};
