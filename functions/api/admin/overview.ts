// GET /api/admin/overview — dashboard counts, revenue, funnel, activity.

import type { Env } from '../../lib/types.ts';
import { requireAdmin } from '../../lib/auth.ts';
import { json } from '../../lib/util.ts';
import { REAL_RECORDS_ONLY } from '../../lib/record-kind.ts';
import { releaseExpiredHolds } from '../../lib/portal.ts';
import {
  summarizeNotificationIssues,
  type NotificationAuditIssueRow,
  type NotificationMessageIssueRow,
} from '../../lib/notification-issues.ts';

const SCORECARD_WINDOWS = [7, 30, 90] as const;
const CAPTURED_PAYMENT_STATUSES = "'succeeded','partially_refunded','refunded','disputed'";

interface RevenueWindow {
  days: number;
  since: string;
  operations: Record<string, number>;
  paymentCohort: Record<string, number | null>;
  sources: Array<Record<string, unknown>>;
  appStoreOutboundClicks: number;
  dataQuality: { capturedPaymentsMissingConfirmationEvent: number };
}

function numberFields(row: Record<string, unknown> | null): Record<string, number> {
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([key, value]) => [key, Number(value ?? 0)]),
  );
}

function nullableNumberFields(row: Record<string, unknown> | null): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([key, value]) => [key, value === null ? null : Number(value ?? 0)]),
  );
}

export async function loadRevenueWindow(db: D1Database, days: number): Promise<RevenueWindow> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const cutoffEpoch = Math.floor(Date.parse(cutoff) / 1000);
  const [operationsRow, paymentCohortRow, sources] = await Promise.all([
    db.prepare(
      `WITH params AS (
         SELECT ? AS cutoff_iso, ? AS cutoff_epoch
       ), real_requests AS (
         -- Seeded fixtures and smoke tests stay in the database but are not
         -- business. Every figure below is scoped through this.
         SELECT id FROM ppi_requests WHERE deleted_at IS NULL AND ${REAL_RECORDS_ONLY}
       ), first_milestones AS (
         SELECT request_id,
                MIN(CASE WHEN to_status = 'ready_for_review' THEN created_at END) AS ready_for_review_at,
                MIN(CASE WHEN to_status = 'quote_sent' THEN created_at END) AS quoted_at,
                MIN(CASE WHEN to_status = 'completed' THEN created_at END) AS completed_at
         FROM status_history
         WHERE request_id IN (SELECT id FROM real_requests)
         GROUP BY request_id
       ), window_refunds AS (
         SELECT * FROM provider_refunds
         WHERE status = 'succeeded'
           AND last_event_created > (SELECT cutoff_epoch FROM params)
       ), window_disputes AS (
         SELECT * FROM payment_disputes
         WHERE provider_created > (SELECT cutoff_epoch FROM params)
       )
       SELECT
         (SELECT COUNT(*) FROM ppi_requests WHERE deleted_at IS NULL AND ${REAL_RECORDS_ONLY}
           AND created_at > (SELECT cutoff_iso FROM params)) AS saved_requests,
         (SELECT COUNT(*) FROM first_milestones
           WHERE ready_for_review_at > (SELECT cutoff_iso FROM params)) AS ready_for_review_requests,
         (SELECT COUNT(*) FROM first_milestones
           WHERE quoted_at > (SELECT cutoff_iso FROM params)) AS quoted_requests,
         (SELECT COUNT(DISTINCT stripe_session_id) FROM payments
           WHERE stripe_session_id IS NOT NULL
             AND request_id IN (SELECT id FROM real_requests)
             AND created_at > (SELECT cutoff_iso FROM params)) AS checkout_starts,
         (SELECT COUNT(*) FROM analytics_events e JOIN payments p
           ON e.id = 'ev_payment_' || p.id AND e.event = 'ppi_payment_confirmed'
           WHERE e.created_at > (SELECT cutoff_iso FROM params)
             AND p.request_id IN (SELECT id FROM real_requests)) AS successful_payments,
         (SELECT COUNT(DISTINCT request_id) FROM bookings
           WHERE confirmed_at IS NOT NULL
             AND request_id IN (SELECT id FROM real_requests)
             AND confirmed_at > (SELECT cutoff_iso FROM params)) AS confirmed_bookings,
         (SELECT COUNT(*) FROM first_milestones
           WHERE completed_at > (SELECT cutoff_iso FROM params)) AS completed_inspections,
         (SELECT COUNT(*) FROM window_refunds) AS successful_refunds,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM window_refunds) AS successful_refund_cents,
         (SELECT COUNT(*) FROM window_disputes) AS dispute_cases_opened,
         (SELECT COUNT(DISTINCT payment_id) FROM window_disputes) AS disputed_payments,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM window_disputes) AS dispute_case_cents,
         (SELECT COUNT(*) FROM analytics_events
           WHERE event = 'app_store_outbound_click'
             AND created_at > (SELECT cutoff_iso FROM params)) AS app_store_outbound_clicks`,
    ).bind(cutoff, cutoffEpoch).first<Record<string, unknown>>(),
    db.prepare(
      `WITH real_requests AS (
         SELECT id FROM ppi_requests WHERE deleted_at IS NULL AND ${REAL_RECORDS_ONLY}
       ), confirmed_payments AS (
         SELECT p.*
         FROM payments p
         JOIN analytics_events e
           ON e.id = 'ev_payment_' || p.id AND e.event = 'ppi_payment_confirmed'
         WHERE e.created_at > ? AND p.status IN (${CAPTURED_PAYMENT_STATUSES})
           AND p.request_id IN (SELECT id FROM real_requests)
       ), captured AS (
         SELECT p.*,
                CASE WHEN p.status = 'disputed'
                  THEN MAX(p.amount_cents - p.refunded_cents, 0)
                  ELSE 0
                END AS disputed_cents
         FROM confirmed_payments p
       )
       SELECT COUNT(*) AS paid_payments,
              COALESCE(SUM(amount_cents), 0) AS gross_collected_cents,
              COALESCE(SUM(refunded_cents), 0) AS refunded_cents,
              COALESCE(SUM(disputed_cents), 0) AS disputed_excluded_cents,
              COALESCE(SUM(MAX(amount_cents - refunded_cents - disputed_cents, 0)), 0) AS recognized_net_cents,
              ROUND(AVG(amount_cents)) AS average_paid_ticket_cents,
              (SELECT COUNT(*) FROM payments missing
               WHERE missing.status IN (${CAPTURED_PAYMENT_STATUSES})
                 AND missing.request_id IN (SELECT id FROM real_requests)
                 AND missing.created_at > ?
                 AND NOT EXISTS (
                   SELECT 1 FROM analytics_events e
                   WHERE e.id = 'ev_payment_' || missing.id AND e.event = 'ppi_payment_confirmed'
                 )) AS captured_payments_missing_confirmation_event
       FROM captured`,
    ).bind(cutoff, cutoff).first<Record<string, unknown>>(),
    db.prepare(
      `WITH cohort AS (
         SELECT id, COALESCE(NULLIF(attribution_source, ''), 'ppi_unknown') AS source
         FROM ppi_requests
         WHERE deleted_at IS NULL AND ${REAL_RECORDS_ONLY} AND created_at > ?
       ), first_milestones AS (
         SELECT request_id,
                MIN(CASE WHEN to_status = 'ready_for_review' THEN created_at END) AS ready_for_review_at,
                MIN(CASE WHEN to_status = 'quote_sent' THEN created_at END) AS quoted_at,
                MIN(CASE WHEN to_status = 'completed' THEN created_at END) AS completed_at
         FROM status_history
         -- The cohort above is already limited to real records here.
         WHERE request_id IN (SELECT id FROM cohort)
         GROUP BY request_id
       ), dispute_cases AS (
         SELECT payment_id, COUNT(*) AS dispute_cases
         FROM payment_disputes GROUP BY payment_id
       ), refund_cases AS (
         SELECT payment_id, COUNT(*) AS refund_count
         FROM provider_refunds WHERE status = 'succeeded' GROUP BY payment_id
       ), payment_rollup AS (
         SELECT p.request_id,
                COUNT(DISTINCT p.stripe_session_id) AS checkouts,
                COUNT(CASE WHEN p.status IN (${CAPTURED_PAYMENT_STATUSES}) THEN 1 END) AS paid_payments,
                MAX(CASE WHEN p.status IN (${CAPTURED_PAYMENT_STATUSES}) THEN 1 ELSE 0 END) AS paid_request,
                MAX(CASE WHEN p.status = 'disputed' THEN 1 ELSE 0 END) AS disputed_request,
                SUM(CASE WHEN p.status IN (${CAPTURED_PAYMENT_STATUSES}) THEN p.amount_cents ELSE 0 END) AS gross_cents,
                SUM(CASE WHEN p.status IN (${CAPTURED_PAYMENT_STATUSES}) THEN p.refunded_cents ELSE 0 END) AS refunded_cents,
                SUM(CASE WHEN p.status = 'disputed'
                         THEN MAX(p.amount_cents - p.refunded_cents, 0) ELSE 0 END) AS disputed_cents,
                SUM(CASE WHEN p.status IN (${CAPTURED_PAYMENT_STATUSES})
                         THEN CASE WHEN p.status = 'disputed' THEN 0
                           ELSE MAX(p.amount_cents - p.refunded_cents, 0) END
                         ELSE 0 END) AS recognized_net_cents,
                SUM(COALESCE(rf.refund_count, 0)) AS refund_count,
                SUM(COALESCE(dc.dispute_cases, 0)) AS dispute_cases
         FROM payments p
         LEFT JOIN dispute_cases dc ON dc.payment_id = p.id
         LEFT JOIN refund_cases rf ON rf.payment_id = p.id
         GROUP BY p.request_id
       ), booking_rollup AS (
         SELECT request_id, MAX(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS booked
         FROM bookings GROUP BY request_id
       )
       SELECT c.source,
              COUNT(*) AS requests,
              COALESCE(SUM(CASE WHEN m.ready_for_review_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS ready_for_review,
              COALESCE(SUM(CASE WHEN m.quoted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS quoted,
              COALESCE(SUM(p.checkouts), 0) AS checkouts,
              COALESCE(SUM(p.paid_request), 0) AS paid,
              COALESCE(SUM(b.booked), 0) AS bookings,
              COALESCE(SUM(CASE WHEN m.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed,
              COALESCE(SUM(p.refund_count), 0) AS refund_count,
              COALESCE(SUM(p.dispute_cases), 0) AS dispute_cases,
              COALESCE(SUM(p.disputed_request), 0) AS disputed_requests,
              COALESCE(SUM(p.gross_cents), 0) AS gross_cents,
              COALESCE(SUM(p.refunded_cents), 0) AS refunded_cents,
              COALESCE(SUM(p.disputed_cents), 0) AS disputed_excluded_cents,
              COALESCE(SUM(p.recognized_net_cents), 0) AS recognized_net_cents,
              ROUND(SUM(p.gross_cents) * 1.0 / NULLIF(SUM(p.paid_payments), 0)) AS average_paid_ticket_cents,
              CASE WHEN COUNT(*) >= 20 THEN ROUND(100.0 * COALESCE(SUM(p.paid_request), 0) / COUNT(*), 1) END AS request_to_paid_rate,
              CASE WHEN COUNT(*) >= 20 THEN ROUND(100.0 * SUM(CASE WHEN m.completed_at IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) END AS request_to_completed_rate
       FROM cohort c
       LEFT JOIN first_milestones m ON m.request_id = c.id
       LEFT JOIN payment_rollup p ON p.request_id = c.id
       LEFT JOIN booking_rollup b ON b.request_id = c.id
       GROUP BY c.source
       ORDER BY recognized_net_cents DESC, requests DESC, c.source`,
    ).bind(cutoff).all<Record<string, unknown>>(),
  ]);

  const operations = numberFields(operationsRow);
  const paymentCohort = nullableNumberFields(paymentCohortRow);
  const missingConfirmationEvent = Number(paymentCohort['captured_payments_missing_confirmation_event'] ?? 0);
  delete paymentCohort['captured_payments_missing_confirmation_event'];
  return {
    days,
    since: cutoff,
    operations,
    paymentCohort,
    sources: sources.results ?? [],
    appStoreOutboundClicks: operations['app_store_outbound_clicks'] ?? 0,
    dataQuality: { capturedPaymentsMissingConfirmationEvent: missingConfirmationEvent },
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  await releaseExpiredHolds(db);

  const statusCounts = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM ppi_requests WHERE deleted_at IS NULL AND ${REAL_RECORDS_ONLY} GROUP BY status`)
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
  const revenueWindows = await Promise.all(SCORECARD_WINDOWS.map((days) => loadRevenueWindow(db, days)));
  const thirtyDayWindow = revenueWindows.find((window) => window.days === 30)!;

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
    revenueWindows,
    revenue30d: {
      grossCents: thirtyDayWindow.paymentCohort['gross_collected_cents'] ?? 0,
      refundedCents: thirtyDayWindow.paymentCohort['refunded_cents'] ?? 0,
      netCents: thirtyDayWindow.paymentCohort['recognized_net_cents'] ?? 0,
      payments: thirtyDayWindow.paymentCohort['paid_payments'] ?? 0,
      disputedPayments: thirtyDayWindow.operations['disputed_payments'] ?? 0,
      disputedCents: thirtyDayWindow.paymentCohort['disputed_excluded_cents'] ?? 0,
    },
    authoritativeFunnel30d: {
      requests_saved: thirtyDayWindow.operations['saved_requests'] ?? 0,
      ready_for_review_requests: thirtyDayWindow.operations['ready_for_review_requests'] ?? 0,
      quotes_sent: thirtyDayWindow.operations['quoted_requests'] ?? 0,
      checkouts_created: thirtyDayWindow.operations['checkout_starts'] ?? 0,
      payments_succeeded: thirtyDayWindow.operations['successful_payments'] ?? 0,
      bookings_confirmed: thirtyDayWindow.operations['confirmed_bookings'] ?? 0,
      completed: thirtyDayWindow.operations['completed_inspections'] ?? 0,
    },
    attribution30d: thirtyDayWindow.sources.map((row) => ({
      source: row['source'],
      requests: row['requests'],
      paid_requests: row['paid'],
      completed: row['completed'],
      gross_cents: row['gross_cents'],
      refunded_cents: row['refunded_cents'],
      net_cents: row['recognized_net_cents'],
      disputed_requests: row['disputed_requests'],
    })),
    funnel30d: funnel.results ?? [],
    activity: activity.results ?? [],
    // Count affected requests, not raw audit/message rows, so one failed
    // attempt cannot inflate the dashboard when both layers recorded it.
    notificationIssues: notificationIssueRequests.length,
    notificationIssueRequests: notificationIssueRequests.slice(0, 25),
  });
};
