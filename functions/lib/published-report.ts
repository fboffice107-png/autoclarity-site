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

type ReportVerdict = 'proceed' | 'negotiate_repair_first' | 'do_not_proceed';
type ReportResult = 'pass' | 'attention' | 'fail' | 'not_inspected' | 'not_applicable';
type ReportPerformed = 'performed' | 'partial' | 'not_performed';
type ReportPriority = 'immediate' | 'soon' | 'monitor' | 'informational';
type ReportNotPerformedReason =
  | 'not_accessible'
  | 'unsafe_to_test'
  | 'seller_declined'
  | 'equipment_unavailable'
  | 'not_supported'
  | 'not_applicable';

export interface CustomerReportPayload {
  schema: 'autoclarity.ppi.report';
  schemaVersion: 1;
  inspector?: string;
  overall: {
    score: number;
    verdict: ReportVerdict;
    verdictLabel: string;
    executiveSummary: string;
    positiveFindings?: string;
    negotiationSummary?: string;
  };
  sections: Array<{
    title: string;
    performed: ReportPerformed;
    notPerformedReason?: ReportNotPerformedReason;
    summary?: string;
    items: Array<{
      label: string;
      result: ReportResult;
      note?: string;
      measurement?: { label?: string; value?: string; unit?: string };
      costLowCents?: number;
      costHighCents?: number;
      priority?: ReportPriority;
      photos?: Array<{ caption?: string }>;
    }>;
  }>;
  limitations: {
    standard: string[];
    additional?: string;
  };
}

export interface PublishedReportVersion {
  reportId: string;
  versionId: string;
  version: number;
  kind: string;
  publishedAt: string;
  payloadSha256: string;
  payload: CustomerReportPayload;
}

const MAX_REPORT_PAYLOAD_BYTES = 1_048_576;
const MAX_REPORT_SECTIONS = 50;
const MAX_REPORT_ITEMS = 1_000;
const MAX_ITEMS_PER_SECTION = 250;
const MAX_PHOTOS_PER_ITEM = 50;
const MAX_LIMITATIONS = 100;

class InvalidCustomerReportPayload extends Error {}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidCustomerReportPayload(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new InvalidCustomerReportPayload(`${path} has an invalid item count.`);
  }
  return value;
}

function requiredText(source: Record<string, unknown>, key: string, path: string, max: number): string {
  const value = source[key];
  if (typeof value !== 'string') throw new InvalidCustomerReportPayload(`${path} must be text.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new InvalidCustomerReportPayload(`${path} has an invalid length.`);
  return trimmed;
}

function optionalText(source: Record<string, unknown>, key: string, path: string, max: number): string | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new InvalidCustomerReportPayload(`${path} must be text.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new InvalidCustomerReportPayload(`${path} has an invalid length.`);
  return trimmed;
}

function requiredEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  values: readonly T[],
): T {
  const value = source[key];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new InvalidCustomerReportPayload(`${path} is not supported.`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  values: readonly T[],
): T | undefined {
  if (source[key] === undefined || source[key] === null || source[key] === '') return undefined;
  return requiredEnum(source, key, path, values);
}

function optionalCents(source: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100_000_000) {
    throw new InvalidCustomerReportPayload(`${path} must be a non-negative cent amount.`);
  }
  return Number(value);
}

const VERDICT_LABELS: Record<ReportVerdict, string> = {
  proceed: 'Proceed',
  negotiate_repair_first: 'Negotiate / Repair First',
  do_not_proceed: 'Do Not Proceed',
};

/**
 * Validate the versioned customer contract and return only fields approved for
 * the portal. Unknown/internal fields are deliberately dropped even when the
 * immutable source snapshot and its digest are otherwise valid.
 */
export function projectCustomerReportPayload(value: unknown): CustomerReportPayload | null {
  try {
    const root = record(value, 'report');
    if (root['schema'] !== 'autoclarity.ppi.report' || root['schemaVersion'] !== 1) {
      throw new InvalidCustomerReportPayload('Unsupported report schema.');
    }

    const overallRaw = record(root['overall'], 'report.overall');
    const score = overallRaw['score'];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 1 || score > 10) {
      throw new InvalidCustomerReportPayload('report.overall.score must be from 1 through 10.');
    }
    const verdict = requiredEnum(
      overallRaw,
      'verdict',
      'report.overall.verdict',
      ['proceed', 'negotiate_repair_first', 'do_not_proceed'] as const,
    );
    const overall: CustomerReportPayload['overall'] = {
      score,
      verdict,
      verdictLabel: VERDICT_LABELS[verdict],
      executiveSummary: requiredText(overallRaw, 'executiveSummary', 'report.overall.executiveSummary', 12_000),
    };
    const positiveFindings = optionalText(overallRaw, 'positiveFindings', 'report.overall.positiveFindings', 12_000);
    const negotiationSummary = optionalText(overallRaw, 'negotiationSummary', 'report.overall.negotiationSummary', 12_000);
    if (positiveFindings) overall.positiveFindings = positiveFindings;
    if (negotiationSummary) overall.negotiationSummary = negotiationSummary;

    let totalItems = 0;
    const sections = array(root['sections'], 'report.sections', MAX_REPORT_SECTIONS, 1).map((rawSection, sectionIndex) => {
      const section = record(rawSection, `report.sections[${sectionIndex}]`);
      const rawItems = array(section['items'], `report.sections[${sectionIndex}].items`, MAX_ITEMS_PER_SECTION);
      totalItems += rawItems.length;
      if (totalItems > MAX_REPORT_ITEMS) throw new InvalidCustomerReportPayload('Report contains too many inspection items.');

      const projected: CustomerReportPayload['sections'][number] = {
        title: requiredText(section, 'title', `report.sections[${sectionIndex}].title`, 200),
        performed: requiredEnum(
          section,
          'performed',
          `report.sections[${sectionIndex}].performed`,
          ['performed', 'partial', 'not_performed'] as const,
        ),
        items: rawItems.map((rawItem, itemIndex) => {
          const path = `report.sections[${sectionIndex}].items[${itemIndex}]`;
          const item = record(rawItem, path);
          const projectedItem: CustomerReportPayload['sections'][number]['items'][number] = {
            label: requiredText(item, 'label', `${path}.label`, 300),
            result: requiredEnum(
              item,
              'result',
              `${path}.result`,
              ['pass', 'attention', 'fail', 'not_inspected', 'not_applicable'] as const,
            ),
          };
          const note = optionalText(item, 'note', `${path}.note`, 8_000);
          const priority = optionalEnum(
            item,
            'priority',
            `${path}.priority`,
            ['immediate', 'soon', 'monitor', 'informational'] as const,
          );
          const low = optionalCents(item, 'costLowCents', `${path}.costLowCents`);
          const high = optionalCents(item, 'costHighCents', `${path}.costHighCents`);
          if (low !== undefined && high !== undefined && low > high) {
            throw new InvalidCustomerReportPayload(`${path} has an inverted cost range.`);
          }
          if (note) projectedItem.note = note;
          if (priority) projectedItem.priority = priority;
          if (low !== undefined) projectedItem.costLowCents = low;
          if (high !== undefined) projectedItem.costHighCents = high;

          if (item['measurement'] !== undefined && item['measurement'] !== null) {
            const measurement = record(item['measurement'], `${path}.measurement`);
            const projectedMeasurement = {
              label: optionalText(measurement, 'label', `${path}.measurement.label`, 200),
              value: optionalText(measurement, 'value', `${path}.measurement.value`, 200),
              unit: optionalText(measurement, 'unit', `${path}.measurement.unit`, 100),
            };
            if (projectedMeasurement.label || projectedMeasurement.value || projectedMeasurement.unit) {
              projectedItem.measurement = projectedMeasurement;
            }
          }

          if (item['photos'] !== undefined && item['photos'] !== null) {
            projectedItem.photos = array(item['photos'], `${path}.photos`, MAX_PHOTOS_PER_ITEM).map((rawPhoto, photoIndex) => {
              const photo = record(rawPhoto, `${path}.photos[${photoIndex}]`);
              const caption = optionalText(photo, 'caption', `${path}.photos[${photoIndex}].caption`, 1_000);
              return caption ? { caption } : {};
            });
          }
          return projectedItem;
        }),
      };
      const notPerformedReason = optionalEnum(
        section,
        'notPerformedReason',
        `report.sections[${sectionIndex}].notPerformedReason`,
        ['not_accessible', 'unsafe_to_test', 'seller_declined', 'equipment_unavailable', 'not_supported', 'not_applicable'] as const,
      );
      const summary = optionalText(section, 'summary', `report.sections[${sectionIndex}].summary`, 8_000);
      if (notPerformedReason) projected.notPerformedReason = notPerformedReason;
      if (summary) projected.summary = summary;
      return projected;
    });

    const limitationsRaw = record(root['limitations'], 'report.limitations');
    const standard = array(limitationsRaw['standard'], 'report.limitations.standard', MAX_LIMITATIONS)
      .map((item, index) => {
        const wrapper = { value: item };
        return requiredText(wrapper, 'value', `report.limitations.standard[${index}]`, 2_000);
      });
    const additional = optionalText(limitationsRaw, 'additional', 'report.limitations.additional', 12_000);
    if (standard.length === 0 && !additional) {
      throw new InvalidCustomerReportPayload('The report must disclose at least one limitation.');
    }
    const inspector = optionalText(root, 'inspector', 'report.inspector', 200);

    return {
      schema: 'autoclarity.ppi.report',
      schemaVersion: 1,
      ...(inspector ? { inspector } : {}),
      overall,
      sections,
      limitations: {
        standard,
        ...(additional ? { additional } : {}),
      },
    };
  } catch (error) {
    if (error instanceof InvalidCustomerReportPayload) return null;
    throw error;
  }
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

  if (row.payload_json.length > MAX_REPORT_PAYLOAD_BYTES) return null;
  if (new TextEncoder().encode(row.payload_json).byteLength > MAX_REPORT_PAYLOAD_BYTES) return null;
  if (!Number.isSafeInteger(row.version) || row.version < 1) return null;
  if (row.kind !== 'original' && row.kind !== 'amendment') return null;
  if (!row.published_at || Number.isNaN(new Date(row.published_at).getTime())) return null;

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
  const customerPayload = projectCustomerReportPayload(payload);
  if (!customerPayload) return null;

  return {
    reportId: row.report_id,
    versionId: row.version_id,
    version: row.version,
    kind: row.kind,
    publishedAt: row.published_at,
    payloadSha256: storedDigest,
    payload: customerPayload,
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
