// GET /api/admin/overview — dashboard counts, revenue, funnel, activity.

import type { Env } from '../../lib/types.ts';
import { requireAdmin } from '../../lib/auth.ts';
import { json } from '../../lib/util.ts';
import { releaseExpiredHolds } from '../../lib/portal.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  await releaseExpiredHolds(db);

  const statusCounts = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM ppi_requests WHERE deleted_at IS NULL GROUP BY status`)
    .all<{ status: string; n: number }>();

  const upcoming = await db
    .prepare(
      `SELECT r.ref, r.id, s.starts_at, v.year, v.make, v.model
       FROM bookings b
       JOIN ppi_requests r ON r.id = b.request_id
       JOIN appointment_slots s ON s.id = b.slot_id
       JOIN vehicles v ON v.id = r.vehicle_id
       WHERE b.status = 'confirmed' AND s.starts_at > ?
       ORDER BY s.starts_at LIMIT 10`,
    )
    .bind(new Date().toISOString())
    .all<Record<string, unknown>>();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const revenue = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS cents, COUNT(*) AS n
       FROM payments WHERE status IN ('succeeded','partially_refunded') AND created_at > ?`,
    )
    .bind(thirtyDaysAgo)
    .first<{ cents: number; n: number }>();

  const funnel = await db
    .prepare(`SELECT event, COUNT(*) AS n FROM analytics_events WHERE created_at > ? GROUP BY event`)
    .bind(thirtyDaysAgo)
    .all<{ event: string; n: number }>();

  const activity = await db
    .prepare(
      `SELECT h.created_at, h.to_status, h.actor, h.reason, r.ref
       FROM status_history h JOIN ppi_requests r ON r.id = h.request_id
       ORDER BY h.created_at DESC LIMIT 20`,
    )
    .all<Record<string, unknown>>();

  return json({
    statusCounts: statusCounts.results ?? [],
    upcoming: upcoming.results ?? [],
    revenue30d: { cents: revenue?.cents ?? 0, payments: revenue?.n ?? 0 },
    funnel30d: funnel.results ?? [],
    activity: activity.results ?? [],
  });
};
