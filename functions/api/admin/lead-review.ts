// /api/admin/lead-review — privacy-minimized owner classification queue.
// Classification is independent from lifecycle, customer contact, bookings,
// quotes, and payments. This endpoint never mutates those systems.

import type { Env } from '../../lib/types.ts';
import { requireAdmin } from '../../lib/auth.ts';
import { isStatus } from '../../lib/status.ts';
import { errorJson, json, newId, nowIso, originAllowed } from '../../lib/util.ts';
import { readJsonBody, requestBodyErrorResponse } from '../../lib/request-body.ts';

export const LEAD_CLASSIFICATIONS = [
  'genuine',
  'duplicate',
  'spam',
  'test',
  'closed',
  'needs_owner_review',
] as const;

export type LeadClassification = (typeof LEAD_CLASSIFICATIONS)[number];

const CLASSIFICATION_SET = new Set<string>(LEAD_CLASSIFICATIONS);
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,96}$/u;
const POST_BODY_KEYS = new Set(['requestId', 'expectedClassification', 'classification']);
const POST_BODY_MAX_BYTES = 4 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function isLeadClassification(value: unknown): value is LeadClassification {
  return typeof value === 'string' && CLASSIFICATION_SET.has(value);
}

function parseLimit(value: string | null): number {
  if (!value || !/^\d{1,4}$/u.test(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Number(value), 1), MAX_LIMIT);
}

function boolFlag(value: unknown): boolean {
  return Number(value ?? 0) === 1;
}

interface LeadReviewBody {
  requestId?: unknown;
  expectedClassification?: unknown;
  classification?: unknown;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;

  const url = new URL(context.request.url);
  const rawClassification = url.searchParams.get('classification');
  const classificationFilter = rawClassification ?? 'needs_owner_review';
  if (classificationFilter !== 'all' && !isLeadClassification(classificationFilter)) {
    return errorJson('validation', 'Unknown lead classification filter.', 422);
  }

  const statusFilter = url.searchParams.get('status') ?? '';
  if (statusFilter && statusFilter !== 'all' && !isStatus(statusFilter)) {
    return errorJson('validation', 'Unknown lifecycle status filter.', 422);
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  const now = new Date();
  const nowValue = now.toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const clauses = ['r.deleted_at IS NULL'];
  const queueBindings: unknown[] = [nowValue];
  if (classificationFilter !== 'all') {
    clauses.push('r.lead_classification = ?');
    queueBindings.push(classificationFilter);
  }
  if (statusFilter && statusFilter !== 'all') {
    clauses.push('r.status = ?');
    queueBindings.push(statusFilter);
  }
  queueBindings.push(sevenDaysAgo, limit);

  const [classificationRows, summary, queueRows] = await Promise.all([
    context.env.DB
      .prepare(
        `SELECT lead_classification, COUNT(*) AS n
         FROM ppi_requests
         WHERE deleted_at IS NULL
         GROUP BY lead_classification`,
      )
      .all<{ lead_classification: LeadClassification; n: number }>(),
    context.env.DB
      .prepare(
        `SELECT
           SUM(CASE WHEN r.lead_classification = 'genuine' AND r.created_at >= ? THEN 1 ELSE 0 END) AS new_genuine_30d,
           SUM(CASE WHEN r.lead_classification = 'needs_owner_review'
                     AND r.status = 'submitted' AND r.created_at < ? THEN 1 ELSE 0 END) AS stale_needs_owner_review,
           SUM(CASE WHEN r.lead_classification IN ('duplicate','spam','test','closed')
                     AND (
                       EXISTS (SELECT 1 FROM payments p WHERE p.request_id = r.id)
                       OR EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = r.id)
                       OR EXISTS (SELECT 1 FROM status_history h WHERE h.request_id = r.id AND h.to_status = 'completed')
                     ) THEN 1 ELSE 0 END) AS reconciliation_warning_count
         FROM ppi_requests r
         WHERE r.deleted_at IS NULL`,
      )
      .bind(thirtyDaysAgo, sevenDaysAgo)
      .first<Record<string, unknown>>(),
    context.env.DB
      .prepare(
        `SELECT r.id, r.ref, substr(r.created_at, 1, 10) AS created_date,
                r.status, r.lead_classification,
                r.loc_city, r.loc_zip, r.attribution_source,
                v.year, v.make, v.model,
                CAST(MAX(0, julianday(?) - julianday(r.created_at)) AS INTEGER) AS age_days,
                EXISTS (SELECT 1 FROM payments p WHERE p.request_id = r.id) AS has_payment,
                EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = r.id) AS has_booking,
                EXISTS (
                  SELECT 1 FROM status_history h
                  WHERE h.request_id = r.id AND h.to_status = 'completed'
                ) AS has_completion
         FROM ppi_requests r
         JOIN vehicles v ON v.id = r.vehicle_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY CASE
           WHEN r.lead_classification = 'needs_owner_review'
             AND r.status = 'submitted' AND r.created_at < ? THEN 0
           ELSE 1
         END,
         r.created_at ASC, r.id ASC
         LIMIT ?`,
      )
      .bind(...queueBindings)
      .all<Record<string, unknown>>(),
  ]);

  const classificationCounts = Object.fromEntries(
    LEAD_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<LeadClassification, number>;
  for (const row of classificationRows.results ?? []) {
    if (isLeadClassification(row.lead_classification)) {
      classificationCounts[row.lead_classification] = Number(row.n ?? 0);
    }
  }

  const queue = (queueRows.results ?? []).map((row) => {
    const hasPayment = boolFlag(row['has_payment']);
    const hasBooking = boolFlag(row['has_booking']);
    const hasCompletion = boolFlag(row['has_completion']);
    const classification = String(row['lead_classification']);
    return {
      id: row['id'],
      ref: row['ref'],
      createdDate: row['created_date'],
      ageDays: Number(row['age_days'] ?? 0),
      status: row['status'],
      classification,
      vehicle: {
        year: row['year'],
        make: row['make'],
        model: row['model'],
      },
      location: {
        city: row['loc_city'],
        zip: row['loc_zip'],
      },
      attributionSource: row['attribution_source'] ?? 'ppi_unknown',
      hasPayment,
      hasBooking,
      hasCompletion,
      hasReconciliationEvidence:
        ['duplicate', 'spam', 'test', 'closed'].includes(classification)
        && (hasPayment || hasBooking || hasCompletion),
    };
  });

  return json({
    classificationCounts,
    newGenuine30d: Number(summary?.['new_genuine_30d'] ?? 0),
    staleNeedsOwnerReview: Number(summary?.['stale_needs_owner_review'] ?? 0),
    reconciliationWarningCount: Number(summary?.['reconciliation_warning_count'] ?? 0),
    filters: {
      classification: classificationFilter,
      status: statusFilter || 'all',
      limit,
    },
    queue,
  });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  if (!originAllowed(context.request, context.env.PUBLIC_BASE_URL, true)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;

  let body: LeadReviewBody;
  try {
    body = await readJsonBody<LeadReviewBody>(context.request, POST_BODY_MAX_BYTES);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorJson('validation', 'Request body must be an object.', 422);
  }
  if (Object.keys(body).some((key) => !POST_BODY_KEYS.has(key))) {
    return errorJson('validation', 'Unknown lead classification field.', 422);
  }

  const requestId = body.requestId;
  const expectedClassification = body.expectedClassification;
  const classification = body.classification;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    return errorJson('validation', 'A valid request ID is required.', 422);
  }
  if (!isLeadClassification(expectedClassification) || !isLeadClassification(classification)) {
    return errorJson('validation', 'Unknown lead classification.', 422);
  }

  const current = await context.env.DB
    .prepare(
      `SELECT lead_classification
       FROM ppi_requests
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(requestId)
    .first<{ lead_classification: string }>();
  if (!current) return errorJson('not_found', 'Request not found.', 404);
  if (current.lead_classification !== expectedClassification) {
    return errorJson(
      'conflict',
      'Lead classification changed concurrently — reload and retry.',
      409,
      { currentClassification: current.lead_classification },
    );
  }
  if (classification === expectedClassification) {
    return json({ ok: true, noChange: true, classification });
  }

  const auditId = newId('al');
  const changedAt = nowIso();
  const details = JSON.stringify({ from: expectedClassification, to: classification });
  const results = await context.env.DB.batch([
    context.env.DB
      .prepare(
        `INSERT INTO admin_audit_log
           (id, actor, action, entity, entity_id, details_json, created_at)
         SELECT ?, ?, 'set_lead_classification', 'ppi_request', r.id, ?, ?
         FROM ppi_requests r
         WHERE r.id = ? AND r.deleted_at IS NULL AND r.lead_classification = ?`,
      )
      .bind(auditId, auth.actor, details, changedAt, requestId, expectedClassification),
    context.env.DB
      .prepare(
        `UPDATE ppi_requests
         SET lead_classification = ?
         WHERE id = ? AND deleted_at IS NULL AND lead_classification = ?`,
      )
      .bind(classification, requestId, expectedClassification),
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    return errorJson(
      'conflict',
      'Lead classification changed concurrently — reload and retry.',
      409,
    );
  }

  return json({ ok: true, noChange: false, classification });
};
