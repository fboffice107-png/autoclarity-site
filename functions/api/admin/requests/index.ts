// GET /api/admin/requests — list/filter requests for the dashboard.

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
    SELECT r.id, r.ref, r.status, r.created_at, r.loc_city, r.loc_zip, r.suggested_tier,
           r.manual_review_reasons, r.same_day_priority, r.travel_miles,
           c.full_name, c.email, v.year, v.make, v.model, v.trim, v.vin
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
