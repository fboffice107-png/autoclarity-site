// GET /api/admin/requests — list/filter requests for the dashboard.
//
// Each row carries everything the list card shows, so the owner can read a
// request's customer, vehicle, location, package, current total, appointment
// and payment state without opening it — and without the dashboard inventing
// a price of its own.

import type { Env } from '../../../lib/types.ts';
import { requireAdmin } from '../../../lib/auth.ts';
import { isStatus } from '../../../lib/status.ts';
import { json } from '../../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;

  const url = new URL(context.request.url);
  const statusFilter = url.searchParams.get('status') ?? '';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);

  const where = statusFilter && isStatus(statusFilter) ? `AND r.status = ?` : '';
  const stmt = `
    SELECT r.id, r.ref, r.status, r.created_at, r.loc_city, r.loc_zip, r.loc_street, r.suggested_tier,
           r.customer_selected_tier, r.tier_review_needed,
           r.manual_review_reasons, r.same_day_priority, r.travel_miles,
           r.attribution_source,
           c.full_name, c.email, v.year, v.make, v.model, v.trim, v.vin,
           -- The current offer: the newest quote that is still live.
           (SELECT q.total_cents FROM quotes q
             WHERE q.request_id = r.id AND q.status IN ('sent','accepted')
             ORDER BY q.version DESC LIMIT 1) AS current_total_cents,
           (SELECT q.tier FROM quotes q
             WHERE q.request_id = r.id AND q.status IN ('sent','accepted')
             ORDER BY q.version DESC LIMIT 1) AS current_tier,
           (SELECT q.expires_at FROM quotes q
             WHERE q.request_id = r.id AND q.status IN ('sent','accepted')
             ORDER BY q.version DESC LIMIT 1) AS current_quote_expires_at,
           -- Appointment: confirmed wins, then held, then the earliest option.
           (SELECT s.starts_at FROM appointment_slots s
             WHERE s.request_id = r.id AND s.status = 'confirmed' LIMIT 1) AS confirmed_starts_at,
           (SELECT s.starts_at FROM appointment_slots s
             WHERE s.request_id = r.id AND s.status = 'held' LIMIT 1) AS held_starts_at,
           (SELECT COUNT(*) FROM appointment_slots s
             WHERE s.request_id = r.id AND s.status = 'offered') AS offered_slot_count,
           (SELECT p.status FROM payments p
             WHERE p.request_id = r.id ORDER BY p.created_at DESC LIMIT 1) AS payment_status,
           (SELECT p.amount_cents FROM payments p
             WHERE p.request_id = r.id AND p.status IN ('succeeded','partially_refunded')
             ORDER BY p.created_at DESC LIMIT 1) AS paid_amount_cents,
           (SELECT bp.notification_status FROM booking_proposals bp
             WHERE bp.request_id = r.id ORDER BY bp.created_at DESC LIMIT 1) AS proposal_notification_status
    FROM ppi_requests r
    JOIN customers c ON c.id = r.customer_id
    JOIN vehicles v ON v.id = r.vehicle_id
    WHERE r.deleted_at IS NULL ${where}
    ORDER BY r.created_at DESC LIMIT ?`;

  const rows = statusFilter && isStatus(statusFilter)
    ? await context.env.DB.prepare(stmt).bind(statusFilter, limit).all<Record<string, unknown>>()
    : await context.env.DB.prepare(stmt).bind(limit).all<Record<string, unknown>>();

  return json({ requests: rows.results ?? [] });
};
