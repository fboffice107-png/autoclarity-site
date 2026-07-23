// GET /api/inspector/overview — the inspector's work queue:
// confirmed appointments (ready to inspect), reports in progress, and
// recently published reports. Same owner/staff auth as the admin API.

import type { Env } from '../../lib/types.ts';
import { requireAdmin } from '../../lib/auth.ts';
import { json } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  const db = context.env.DB;

  // Confirmed / in-inspection bookings joined with any existing report.
  const queue = await db
    .prepare(
      `SELECT r.id AS request_id, r.ref, r.status, s.starts_at, s.ends_at,
              c.full_name AS customer_name, v.year, v.make, v.model, v.trim, v.vin, v.mileage,
              r.loc_city, r.loc_state,
              ir.id AS report_id, ir.state AS report_state, ir.updated_at AS report_updated_at,
              (SELECT COUNT(*) FROM report_versions rv WHERE rv.report_id = ir.id) AS version_count
       FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN vehicles v ON v.id = r.vehicle_id
       LEFT JOIN bookings b ON b.request_id = r.id
       LEFT JOIN appointment_slots s ON s.id = b.slot_id
       LEFT JOIN inspection_reports ir ON ir.request_id = r.id
       WHERE r.deleted_at IS NULL
         AND (r.status IN ('confirmed','inspection_in_progress','report_in_progress') OR ir.id IS NOT NULL)
       ORDER BY COALESCE(s.starts_at, r.created_at)`,
    )
    .all<Record<string, unknown>>();

  const rows = queue.results ?? [];
  const ready = rows.filter((r) => !r['report_id'] && r['status'] === 'confirmed');
  const inProgress = rows.filter((r) => r['report_id'] && r['report_state'] !== 'published');
  const published = rows.filter((r) => r['report_state'] === 'published');

  return json({ ready, inProgress, published });
};
