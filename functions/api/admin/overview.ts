// GET /api/admin/overview — dashboard counts, revenue, funnel, activity.

import type { Env } from '../../lib/types.ts';
import { requireAdmin } from '../../lib/auth.ts';
import { json } from '../../lib/util.ts';
import { releaseExpiredHolds } from '../../lib/portal.ts';
import {
  summarizeNotificationIssues,
  type NotificationAuditIssueRow,
  type NotificationMessageIssueRow,
} from '../../lib/notification-issues.ts';

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
       WHERE b.status = 'confirmed' AND s.status = 'confirmed'
         AND r.status IN ('confirmed','inspection_in_progress','report_in_progress')
         AND s.starts_at > ?
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

  const recordedBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const recentAuditCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [messageIssueRows, auditIssueRows] = await Promise.all([
    db
      .prepare(
         `SELECT m.id, m.request_id, m.template, m.status, m.created_at, r.ref
         FROM messages m
         JOIN ppi_requests r ON r.id = m.request_id AND r.deleted_at IS NULL
         WHERE m.direction = 'outbound' AND m.channel = 'email'
           AND (m.status = 'failed' OR (m.status = 'recorded' AND m.created_at < ?))
           AND NOT EXISTS (
             SELECT 1 FROM admin_audit_log resolved
             WHERE resolved.action = 'notification_issue_resolved'
               AND resolved.entity = 'message' AND resolved.entity_id = m.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM messages successor
             WHERE successor.status = 'sent'
               AND successor.dedupe_key IN ('email_link_refresh:' || m.id, 'email_manual_fresh:' || m.id)
           )`,
      )
      .bind(recordedBefore)
      .all<NotificationMessageIssueRow>(),
    db
      .prepare(
        `SELECT a.id, a.entity_id, a.action, a.details_json, a.created_at, r.ref
         FROM admin_audit_log a
         JOIN ppi_requests r ON r.id = a.entity_id AND r.deleted_at IS NULL
         WHERE a.entity = 'ppi_request'
           AND a.action IN ('notification_record_failed', 'notification_link_failed')
           AND a.created_at >= ?
           AND NOT (
             a.action = 'notification_record_failed'
             AND json_extract(CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END, '$.dedupeKey') IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM messages recovered
               WHERE recovered.dedupe_key = json_extract(
                 CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END,
                 '$.dedupeKey'
               )
                 AND recovered.to_email IS NOT NULL
                 AND recovered.subject IS NOT NULL
                 AND recovered.body_text IS NOT NULL
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM admin_audit_log resolved
             WHERE resolved.action = 'notification_issue_resolved'
               AND resolved.entity = 'ppi_request'
               AND resolved.entity_id = a.entity_id
               AND resolved.created_at >= a.created_at
               AND json_extract(
                 CASE WHEN json_valid(resolved.details_json) THEN resolved.details_json ELSE '{}' END,
                 '$.sourceAction'
               ) = json_extract(
                 CASE WHEN json_valid(a.details_json) THEN a.details_json ELSE '{}' END,
                 '$.sourceAction'
               )
           )`,
      )
      .bind(recentAuditCutoff)
      .all<NotificationAuditIssueRow>(),
  ]);
  const notificationIssueRequests = summarizeNotificationIssues(
    messageIssueRows.results ?? [],
    auditIssueRows.results ?? [],
  );

  return json({
    statusCounts: statusCounts.results ?? [],
    upcoming: upcoming.results ?? [],
    revenue30d: { cents: revenue?.cents ?? 0, payments: revenue?.n ?? 0 },
    funnel30d: funnel.results ?? [],
    activity: activity.results ?? [],
    // Count affected requests, not raw audit/message rows, so one failed
    // attempt cannot inflate the dashboard when both layers recorded it.
    notificationIssues: notificationIssueRequests.length,
    notificationIssueRequests: notificationIssueRequests.slice(0, 25),
  });
};
