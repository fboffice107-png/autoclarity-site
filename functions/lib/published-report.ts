// The single customer-visible definition of a published inspection report.
// A loose report_versions lookup is not enough: the request's one report must
// explicitly point at the still-published immutable snapshot being returned.

import { sha256Hex, timingSafeEqual } from './util.ts';

interface PublishedReportRow {
  report_id: string;
  version_id: string;
  version: number;
  kind: string;
  payload_json: string;
  payload_sha256: string;
  published_at: string;
}

export interface PublishedReportVersion {
  reportId: string;
  versionId: string;
  version: number;
  kind: string;
  publishedAt: string;
  payloadSha256: string;
  payload: Record<string, unknown>;
}

/**
 * Load the exact immutable snapshot selected by a request's published report.
 * Drafts, superseded versions, orphan versions, cross-request rows, invalid
 * JSON, and snapshots whose stored digest does not match are all fail-closed.
 */
export async function loadPublishedReportVersion(
  db: D1Database,
  requestId: string,
): Promise<PublishedReportVersion | null> {
  const row = await db
    .prepare(
      `SELECT ir.id AS report_id, rv.id AS version_id, rv.version, rv.kind,
              rv.payload_json, rv.payload_sha256, rv.published_at
       FROM inspection_reports ir
       JOIN report_versions rv
         ON rv.id = ir.published_version_id
        AND rv.report_id = ir.id
        AND rv.request_id = ir.request_id
       WHERE ir.request_id = ?
         AND ir.state = 'published'
         AND rv.status = 'published'
       LIMIT 1`,
    )
    .bind(requestId)
    .first<PublishedReportRow>();
  if (!row) return null;

  const storedDigest = row.payload_sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(storedDigest)) return null;
  const actualDigest = await sha256Hex(row.payload_json);
  if (!timingSafeEqual(actualDigest, storedDigest)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  return {
    reportId: row.report_id,
    versionId: row.version_id,
    version: row.version,
    kind: row.kind,
    publishedAt: row.published_at,
    payloadSha256: storedDigest,
    payload: payload as Record<string, unknown>,
  };
}

export type CompleteWithPublishedReportResult =
  | { ok: true; report: PublishedReportVersion }
  | { ok: false; code: 'report_required' | 'conflict' };

/**
 * Atomically guards report_in_progress -> completed with the exact published
 * report/version loaded above. The conditional UPDATE repeats the relational
 * checks, closing the gap if publication state changes between load and move.
 */
export async function completeWithPublishedReport(
  db: D1Database,
  requestId: string,
  actor: string,
  reason?: string,
): Promise<CompleteWithPublishedReportResult> {
  const report = await loadPublishedReportVersion(db, requestId);
  if (!report) return { ok: false, code: 'report_required' };

  const now = new Date().toISOString();
  const historyId = `sh_report_completed_${report.versionId}`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO status_history
           (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
         SELECT ?, ?, 'report_in_progress', 'completed', ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM ppi_requests r
           JOIN inspection_reports ir ON ir.request_id = r.id
           JOIN report_versions rv
             ON rv.id = ir.published_version_id
            AND rv.report_id = ir.id
            AND rv.request_id = ir.request_id
           WHERE r.id = ?
             AND r.status = 'report_in_progress'
             AND r.deleted_at IS NULL
             AND ir.id = ?
             AND ir.state = 'published'
             AND rv.id = ?
             AND rv.status = 'published'
         )`,
      )
      .bind(
        historyId,
        requestId,
        actor,
        reason ?? `Published report v${report.version} ready`,
        report.versionId,
        now,
        requestId,
        report.reportId,
        report.versionId,
      ),
    db
      .prepare(
        `UPDATE ppi_requests
         SET status = 'completed', updated_at = ?
         WHERE id = ? AND status = 'report_in_progress' AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM inspection_reports ir
             JOIN report_versions rv
               ON rv.id = ir.published_version_id
              AND rv.report_id = ir.id
              AND rv.request_id = ir.request_id
             WHERE ir.request_id = ppi_requests.id
               AND ir.id = ?
               AND ir.state = 'published'
               AND rv.id = ?
               AND rv.status = 'published'
           )`,
      )
      .bind(now, requestId, report.reportId, report.versionId),
  ]);

  if ((results[1]?.meta?.changes ?? 0) !== 1) return { ok: false, code: 'conflict' };
  return { ok: true, report };
}
