// Inspection-report domain logic: authoring state machine, autosave with
// optimistic concurrency, publication snapshots, and the readiness checks
// that gate publishing. Customers only ever see report_versions payloads.

import type { Env } from './types.ts';
import { clampStr, newId, nowIso, sha256Hex } from './util.ts';
import {
  ITEM_RESULTS,
  NOT_INSPECTED_REASONS,
  PRIORITIES,
  REPORT_SECTIONS,
  SECTION_NOT_PERFORMED_REASONS,
  SECTION_PERFORMED,
  STANDARD_LIMITATIONS,
  VERDICTS,
  VERDICT_LABELS,
  itemDef,
  sectionDef,
  type ItemResult,
  type Verdict,
} from './report-template.ts';

// ------------------------------------------------------------------- states

export const REPORT_STATES = ['in_progress', 'draft_complete', 'ready_for_review', 'published'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

// publish/amend have dedicated endpoints; this table covers the plain moves.
const STATE_MOVES: Record<ReportState, ReportState[]> = {
  in_progress: ['draft_complete'],
  draft_complete: ['in_progress', 'ready_for_review'],
  ready_for_review: ['in_progress', 'draft_complete'],
  published: [], // leaving 'published' requires the amend endpoint
};

export function canMoveState(from: ReportState, to: ReportState): boolean {
  return STATE_MOVES[from]?.includes(to) ?? false;
}

/** Display state incl. the virtual/amendment variants. */
export function displayState(state: ReportState, versionCount: number): string {
  if (state === 'published') return versionCount > 1 ? 'amended' : 'published';
  if (versionCount > 0) return `amending (${state})`;
  return state;
}

// -------------------------------------------------------------------- audit

export async function reportAudit(
  db: D1Database,
  actor: string,
  action: string,
  ids: { reportId?: string | null; requestId?: string | null; versionId?: string | null },
  states?: { prev?: string | null; next?: string | null },
  details?: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO report_audit (id, report_id, request_id, version_id, actor, action, prev_state, new_state, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('ra'),
      ids.reportId ?? null,
      ids.requestId ?? null,
      ids.versionId ?? null,
      actor,
      action,
      states?.prev ?? null,
      states?.next ?? null,
      details === undefined ? null : JSON.stringify(details).slice(0, 4000),
      nowIso(),
    )
    .run();
}

// ------------------------------------------------------------------ loading

export interface ReportRow {
  id: string;
  request_id: string;
  booking_id: string | null;
  customer_id: string;
  vehicle_id: string;
  quote_id: string | null;
  state: ReportState;
  template_key: string;
  template_version: number;
  inspected_at: string | null;
  odometer_miles: number | null;
  plate: string | null;
  plate_state: string | null;
  vin_check: string;
  vin_observed: string | null;
  title_disclosure_notes: string | null;
  seller_notes: string | null;
  score: number | null;
  verdict: Verdict | null;
  executive_summary: string | null;
  positive_findings: string | null;
  negotiation_summary: string | null;
  limitations_notes: string | null;
  autosave_seq: number;
  started_by: string;
  published_version_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemRow {
  id: string;
  report_id: string;
  section_key: string;
  item_key: string;
  result: ItemResult | null;
  not_inspected_reason: string | null;
  inspector_notes: string | null;
  customer_note: string | null;
  measurement_value: string | null;
  measurement_unit: string | null;
  cost_low_cents: number | null;
  cost_high_cents: number | null;
  priority: string | null;
  safety_critical: number;
  negotiation_item: number;
}

export interface SectionRow {
  section_key: string;
  performed: string;
  not_performed_reason: string | null;
  summary_note: string | null;
}

export interface PhotoRow {
  id: string;
  report_id: string;
  item_key: string | null;
  object_key: string;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
  sort: number;
  deleted_at: string | null;
}

export async function getReport(db: D1Database, reportId: string): Promise<ReportRow | null> {
  return db.prepare(`SELECT * FROM inspection_reports WHERE id = ?`).bind(reportId).first<ReportRow>();
}

export async function getReportByRequest(db: D1Database, requestId: string): Promise<ReportRow | null> {
  return db.prepare(`SELECT * FROM inspection_reports WHERE request_id = ?`).bind(requestId).first<ReportRow>();
}

export async function getItems(db: D1Database, reportId: string): Promise<ItemRow[]> {
  const rows = await db.prepare(`SELECT * FROM report_items WHERE report_id = ?`).bind(reportId).all<ItemRow>();
  return rows.results ?? [];
}

export async function getSections(db: D1Database, reportId: string): Promise<SectionRow[]> {
  const rows = await db
    .prepare(`SELECT section_key, performed, not_performed_reason, summary_note FROM report_sections WHERE report_id = ?`)
    .bind(reportId)
    .all<SectionRow>();
  return rows.results ?? [];
}

export async function getPhotos(db: D1Database, reportId: string, includeDeleted = false): Promise<PhotoRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM report_photos WHERE report_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY sort, created_at`)
    .bind(reportId)
    .all<PhotoRow>();
  return rows.results ?? [];
}

export async function getVersions(db: D1Database, reportId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .prepare(
      `SELECT id, version, status, kind, amendment_reason, payload_sha256, pdf_object_key, published_by, published_at, superseded_at
       FROM report_versions WHERE report_id = ? ORDER BY version DESC`,
    )
    .bind(reportId)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

// ----------------------------------------------------------------- autosave

export interface SaveItemPatch {
  itemKey: string;
  result?: string | null;
  notInspectedReason?: string | null;
  inspectorNotes?: string | null;
  customerNote?: string | null;
  measurementValue?: string | null;
  measurementUnit?: string | null;
  costLowCents?: number | null;
  costHighCents?: number | null;
  priority?: string | null;
  safetyCritical?: boolean;
  negotiationItem?: boolean;
}

export interface SaveSectionPatch {
  sectionKey: string;
  performed?: string;
  notPerformedReason?: string | null;
  summaryNote?: string | null;
}

export interface SaveReportPatch {
  inspectedAt?: string | null;
  odometerMiles?: number | null;
  plate?: string | null;
  plateState?: string | null;
  vinCheck?: string;
  vinObserved?: string | null;
  titleDisclosureNotes?: string | null;
  sellerNotes?: string | null;
  score?: number | null;
  verdict?: string | null;
  executiveSummary?: string | null;
  positiveFindings?: string | null;
  negotiationSummary?: string | null;
  limitationsNotes?: string | null;
}

export type SaveResult =
  | { ok: true; seq: number }
  | { ok: false; code: 'conflict' | 'locked' | 'validation'; message: string };

const nul = (v: unknown, max: number): string | null => {
  const s = clampStr(v, max);
  return s ? s : null;
};

function intOrNull(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

/**
 * Apply an autosave batch. `baseSeq` must equal the stored autosave_seq —
 * otherwise another device/tab saved first and the caller must reload (409).
 * Publishing locks the report; edits then require the amend endpoint.
 */
export async function applySave(
  db: D1Database,
  report: ReportRow,
  baseSeq: number,
  patch: { report?: SaveReportPatch; sections?: SaveSectionPatch[]; items?: SaveItemPatch[] },
): Promise<SaveResult> {
  if (report.state === 'published') {
    return { ok: false, code: 'locked', message: 'This report is published. Create an amendment to make changes.' };
  }
  if (!Number.isInteger(baseSeq)) return { ok: false, code: 'validation', message: 'Missing autosave sequence.' };

  const now = nowIso();
  const nextSeq = report.autosave_seq + 1;

  // Optimistic-concurrency gate: claim the next sequence number first.
  const claim = await db
    .prepare(`UPDATE inspection_reports SET autosave_seq = ?, updated_at = ? WHERE id = ? AND autosave_seq = ?`)
    .bind(nextSeq, now, report.id, baseSeq)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    return { ok: false, code: 'conflict', message: 'This report was saved from another device or tab. Reload to continue.' };
  }

  const statements: D1PreparedStatement[] = [];

  // ---- report-level fields
  const r = patch.report;
  if (r) {
    const sets: string[] = [];
    const binds: unknown[] = [];
    const set = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      binds.push(val);
    };
    if ('inspectedAt' in r) set('inspected_at', nul(r.inspectedAt, 40));
    if ('odometerMiles' in r) set('odometer_miles', intOrNull(r.odometerMiles, 0, 2_000_000));
    if ('plate' in r) set('plate', nul(r.plate, 16));
    if ('plateState' in r) set('plate_state', nul(r.plateState, 8));
    if ('vinCheck' in r) set('vin_check', ['matches', 'mismatch', 'not_checked'].includes(String(r.vinCheck)) ? String(r.vinCheck) : 'not_checked');
    if ('vinObserved' in r) set('vin_observed', nul(r.vinObserved, 24));
    if ('titleDisclosureNotes' in r) set('title_disclosure_notes', nul(r.titleDisclosureNotes, 2000));
    if ('sellerNotes' in r) set('seller_notes', nul(r.sellerNotes, 2000));
    if ('score' in r) {
      const s = r.score === null || r.score === undefined || r.score === ('' as unknown) ? null : Number(r.score);
      if (s !== null && (!Number.isFinite(s) || s < 1 || s > 10)) {
        return { ok: false, code: 'validation', message: 'Score must be between 1 and 10.' };
      }
      set('score', s === null ? null : Math.round(s * 10) / 10);
    }
    if ('verdict' in r) {
      const v = r.verdict ? String(r.verdict) : null;
      if (v !== null && !(VERDICTS as readonly string[]).includes(v)) {
        return { ok: false, code: 'validation', message: 'Unknown verdict.' };
      }
      set('verdict', v);
    }
    if ('executiveSummary' in r) set('executive_summary', nul(r.executiveSummary, 6000));
    if ('positiveFindings' in r) set('positive_findings', nul(r.positiveFindings, 4000));
    if ('negotiationSummary' in r) set('negotiation_summary', nul(r.negotiationSummary, 4000));
    if ('limitationsNotes' in r) set('limitations_notes', nul(r.limitationsNotes, 4000));
    if (sets.length > 0) {
      statements.push(db.prepare(`UPDATE inspection_reports SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, report.id));
    }
  }

  // ---- sections
  for (const s of patch.sections ?? []) {
    const def = sectionDef(String(s.sectionKey ?? ''));
    if (!def) return { ok: false, code: 'validation', message: `Unknown section: ${clampStr(s.sectionKey, 60)}` };
    const performed = (SECTION_PERFORMED as readonly string[]).includes(String(s.performed)) ? String(s.performed) : 'performed';
    const reasonRaw = s.notPerformedReason ? String(s.notPerformedReason) : null;
    const reason = reasonRaw && (SECTION_NOT_PERFORMED_REASONS as readonly string[]).includes(reasonRaw) ? reasonRaw : null;
    if (performed !== 'performed' && performed !== 'partial' && !reason) {
      return { ok: false, code: 'validation', message: `Give the reason "${def.title}" was not performed.` };
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO report_sections (id, report_id, section_key, performed, not_performed_reason, summary_note, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(report_id, section_key) DO UPDATE SET
             performed = excluded.performed,
             not_performed_reason = excluded.not_performed_reason,
             summary_note = excluded.summary_note,
             updated_at = excluded.updated_at`,
        )
        .bind(newId('rs'), report.id, def.key, performed, performed === 'performed' ? null : reason, nul(s.summaryNote, 2000), now),
    );
  }

  // ---- items
  for (const it of patch.items ?? []) {
    const found = itemDef(String(it.itemKey ?? ''));
    if (!found) return { ok: false, code: 'validation', message: `Unknown checklist item: ${clampStr(it.itemKey, 80)}` };

    const result = it.result ? String(it.result) : null;
    if (result !== null && !(ITEM_RESULTS as readonly string[]).includes(result)) {
      return { ok: false, code: 'validation', message: `Invalid result for ${found.def.label}.` };
    }
    const niReason = it.notInspectedReason ? String(it.notInspectedReason) : null;
    if (niReason !== null && !(NOT_INSPECTED_REASONS as readonly string[]).includes(niReason)) {
      return { ok: false, code: 'validation', message: `Invalid not-inspected reason for ${found.def.label}.` };
    }
    const priority = it.priority ? String(it.priority) : null;
    if (priority !== null && !(PRIORITIES as readonly string[]).includes(priority)) {
      return { ok: false, code: 'validation', message: `Invalid priority for ${found.def.label}.` };
    }
    const low = intOrNull(it.costLowCents, 0, 50_000_000);
    const high = intOrNull(it.costHighCents, 0, 50_000_000);
    if (low !== null && high !== null && high < low) {
      return { ok: false, code: 'validation', message: `Estimate range for ${found.def.label} is inverted.` };
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO report_items (id, report_id, section_key, item_key, result, not_inspected_reason, inspector_notes,
             customer_note, measurement_value, measurement_unit, cost_low_cents, cost_high_cents, priority,
             safety_critical, negotiation_item, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(report_id, item_key) DO UPDATE SET
             result = excluded.result,
             not_inspected_reason = excluded.not_inspected_reason,
             inspector_notes = excluded.inspector_notes,
             customer_note = excluded.customer_note,
             measurement_value = excluded.measurement_value,
             measurement_unit = excluded.measurement_unit,
             cost_low_cents = excluded.cost_low_cents,
             cost_high_cents = excluded.cost_high_cents,
             priority = excluded.priority,
             safety_critical = excluded.safety_critical,
             negotiation_item = excluded.negotiation_item,
             updated_at = excluded.updated_at`,
        )
        .bind(
          newId('ri'),
          report.id,
          found.section.key,
          found.def.key,
          result,
          result === 'not_inspected' ? niReason : null,
          nul(it.inspectorNotes, 4000),
          nul(it.customerNote, 4000),
          nul(it.measurementValue, 40),
          nul(it.measurementUnit, 20) ?? found.def.measurement?.unit ?? null,
          low,
          high,
          priority,
          it.safetyCritical ? 1 : 0,
          it.negotiationItem ? 1 : 0,
          now,
          now,
        ),
    );
  }

  if (statements.length > 0) await db.batch(statements);
  return { ok: true, seq: nextSeq };
}

// ------------------------------------------------------- publication payload

export interface PublishReadiness {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

export function publishReadiness(report: ReportRow, sections: SectionRow[], items: ItemRow[]): PublishReadiness {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (report.score === null) problems.push('Set the overall condition score (1–10).');
  if (!report.verdict) problems.push('Choose the overall verdict.');
  if (!report.executive_summary || report.executive_summary.trim().length < 40) {
    problems.push('Write an executive summary (a few sentences).');
  }
  if (!report.odometer_miles) warnings.push('Odometer reading is empty.');
  if (!report.inspected_at) warnings.push('Inspection date/time is empty.');
  if (report.vin_check === 'not_checked') warnings.push('VIN was not verified against the paperwork.');
  if (report.vin_check === 'mismatch') warnings.push('VIN MISMATCH recorded — make sure the summary explains it.');

  const sectionByKey = new Map(sections.map((s) => [s.section_key, s]));
  const itemByKey = new Map(items.map((i) => [i.item_key, i]));

  for (const sec of REPORT_SECTIONS) {
    const secRow = sectionByKey.get(sec.key);
    if (secRow && secRow.performed === 'not_performed') continue; // whole section skipped with a reason
    const missing = sec.items.filter((d) => {
      const row = itemByKey.get(d.key);
      return !row || row.result === null;
    });
    if (missing.length > 0) {
      problems.push(
        `${sec.title}: ${missing.length} item${missing.length === 1 ? '' : 's'} unresolved — mark each (or mark the section not performed with a reason).`,
      );
    }
  }

  for (const it of items) {
    const def = itemDef(it.item_key);
    if (!def) continue;
    if (it.result === 'not_inspected' && !it.not_inspected_reason) {
      problems.push(`${def.def.label}: give the reason it was not inspected.`);
    }
    if ((it.result === 'fail' || it.result === 'attention') && !it.customer_note) {
      warnings.push(`${def.def.label}: marked ${it.result} without a customer-facing explanation.`);
    }
    if (it.safety_critical && it.result !== 'fail' && it.result !== 'attention') {
      warnings.push(`${def.def.label}: flagged safety-critical but result is ${it.result ?? 'unset'}.`);
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

/** Vehicle/customer/request context joined for snapshots + dashboards. */
export interface RequestContext {
  request_id: string;
  ref: string;
  status: string;
  customer_name: string;
  customer_email: string;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  vin: string | null;
  mileage: number | null;
  seller_type: string | null;
  seller_name: string | null;
  title_status: string;
  loc_city: string | null;
  loc_state: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

export async function getRequestContext(db: D1Database, requestId: string): Promise<RequestContext | null> {
  return db
    .prepare(
      `SELECT r.id AS request_id, r.ref, r.status, c.full_name AS customer_name, c.email AS customer_email,
              v.year, v.make, v.model, v.trim, v.vin, v.mileage,
              r.seller_type, r.seller_name, v.title_status, r.loc_city, r.loc_state,
              s.starts_at, s.ends_at
       FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN vehicles v ON v.id = r.vehicle_id
       LEFT JOIN bookings b ON b.request_id = r.id
       LEFT JOIN appointment_slots s ON s.id = b.slot_id
       WHERE r.id = ? AND r.deleted_at IS NULL`,
    )
    .bind(requestId)
    .first<RequestContext>();
}

/**
 * Build the complete customer-facing snapshot payload for publication.
 * The HTML report and the PDF are BOTH rendered from this payload, so they
 * can never disagree. Inspector-internal notes are deliberately excluded.
 */
export function buildSnapshot(
  report: ReportRow,
  ctx: RequestContext,
  sections: SectionRow[],
  items: ItemRow[],
  photos: PhotoRow[],
  meta: { version: number; kind: 'original' | 'amendment'; amendmentReason?: string | null; publishedAt: string; inspectorName: string },
): Record<string, unknown> {
  const sectionByKey = new Map(sections.map((s) => [s.section_key, s]));
  const itemByKey = new Map(items.map((i) => [i.item_key, i]));
  const photosByItem = new Map<string, PhotoRow[]>();
  for (const p of photos) {
    if (p.deleted_at) continue;
    const k = p.item_key ?? '';
    if (!photosByItem.has(k)) photosByItem.set(k, []);
    photosByItem.get(k)!.push(p);
  }

  const snapPhoto = (p: PhotoRow) => ({
    id: p.id,
    caption: p.caption ?? null,
    contentType: p.content_type,
    width: p.width,
    height: p.height,
  });

  const outSections = REPORT_SECTIONS.map((sec) => {
    const secRow = sectionByKey.get(sec.key);
    const performed = secRow?.performed ?? 'performed';
    return {
      key: sec.key,
      title: sec.title,
      performed,
      notPerformedReason: performed === 'performed' ? null : (secRow?.not_performed_reason ?? null),
      summary: secRow?.summary_note ?? null,
      items:
        performed === 'not_performed'
          ? []
          : sec.items.map((d) => {
              const row = itemByKey.get(d.key);
              return {
                key: d.key,
                label: d.label,
                result: row?.result ?? 'not_inspected',
                notInspectedReason: row?.result === 'not_inspected' ? (row?.not_inspected_reason ?? null) : null,
                note: row?.customer_note ?? null,
                measurement: row?.measurement_value
                  ? { value: row.measurement_value, unit: row.measurement_unit ?? d.measurement?.unit ?? null, label: d.measurement?.label ?? null }
                  : null,
                costLowCents: row?.cost_low_cents ?? null,
                costHighCents: row?.cost_high_cents ?? null,
                priority: row?.priority ?? null,
                safetyCritical: !!row?.safety_critical,
                negotiationItem: !!row?.negotiation_item,
                photos: (photosByItem.get(d.key) ?? []).map(snapPhoto),
              };
            }),
    };
  });

  // Rollups for the summary blocks.
  const flat = outSections.flatMap((s) => s.items);
  const safety = flat.filter((i) => i.safetyCritical && (i.result === 'fail' || i.result === 'attention'));
  const immediate = flat.filter((i) => i.priority === 'immediate' && !safety.includes(i));
  const soon = flat.filter((i) => i.priority === 'soon');
  const monitor = flat.filter((i) => i.priority === 'monitor');
  const negotiation = flat.filter((i) => i.negotiationItem);
  const withCosts = flat.filter((i) => i.costLowCents !== null || i.costHighCents !== null);
  const costLow = withCosts.reduce((sum, i) => sum + (i.costLowCents ?? i.costHighCents ?? 0), 0);
  const costHigh = withCosts.reduce((sum, i) => sum + (i.costHighCents ?? i.costLowCents ?? 0), 0);

  const counts = {
    pass: flat.filter((i) => i.result === 'pass').length,
    attention: flat.filter((i) => i.result === 'attention').length,
    fail: flat.filter((i) => i.result === 'fail').length,
    notInspected: flat.filter((i) => i.result === 'not_inspected').length,
    notApplicable: flat.filter((i) => i.result === 'not_applicable').length,
  };

  return {
    schema: 'autoclarity.ppi.report',
    schemaVersion: 1,
    templateKey: report.template_key,
    templateVersion: report.template_version,
    version: meta.version,
    kind: meta.kind,
    amendmentReason: meta.amendmentReason ?? null,
    publishedAt: meta.publishedAt,
    inspector: meta.inspectorName,
    ref: ctx.ref,
    customer: { name: ctx.customer_name },
    vehicle: {
      year: ctx.year,
      make: ctx.make,
      model: ctx.model,
      trim: ctx.trim,
      vin: report.vin_observed ?? ctx.vin,
      vinCheck: report.vin_check,
      odometerMiles: report.odometer_miles ?? null,
      plate: report.plate,
      plateState: report.plate_state,
      titleStatus: ctx.title_status,
      titleDisclosureNotes: report.title_disclosure_notes,
    },
    seller: { type: ctx.seller_type, name: ctx.seller_name, notes: report.seller_notes },
    location: { city: ctx.loc_city, state: ctx.loc_state },
    inspectedAt: report.inspected_at,
    appointment: { startsAt: ctx.starts_at, endsAt: ctx.ends_at },
    overall: {
      score: report.score,
      verdict: report.verdict,
      verdictLabel: report.verdict ? VERDICT_LABELS[report.verdict] : null,
      executiveSummary: report.executive_summary,
      positiveFindings: report.positive_findings,
      negotiationSummary: report.negotiation_summary,
    },
    rollups: {
      counts,
      safetyItems: safety.map((i) => i.key),
      immediateItems: immediate.map((i) => i.key),
      soonItems: soon.map((i) => i.key),
      monitorItems: monitor.map((i) => i.key),
      negotiationItems: negotiation.map((i) => i.key),
      estimatedCostLowCents: withCosts.length > 0 ? costLow : null,
      estimatedCostHighCents: withCosts.length > 0 ? costHigh : null,
    },
    sections: outSections,
    generalPhotos: (photosByItem.get('') ?? []).map(snapPhoto),
    limitations: {
      standard: STANDARD_LIMITATIONS,
      additional: report.limitations_notes,
    },
  };
}

// -------------------------------------------------------------- publication

export interface PublishOutcome {
  ok: boolean;
  versionId?: string;
  version?: number;
  error?: string;
  problems?: string[];
}

/**
 * Publish the current draft as an immutable version. The caller has already
 * verified admin auth and the explicit confirmation phrase.
 */
export async function publishReport(
  env: Env,
  report: ReportRow,
  actor: string,
  opts: { amendmentReason?: string | null; inspectorName: string },
): Promise<PublishOutcome> {
  const db = env.DB;
  if (report.state !== 'ready_for_review') {
    return { ok: false, error: 'Move the report to "Ready for review" before publishing.' };
  }
  const ctx = await getRequestContext(db, report.request_id);
  if (!ctx) return { ok: false, error: 'The underlying request no longer exists.' };

  const [sections, items, photos] = await Promise.all([getSections(db, report.id), getItems(db, report.id), getPhotos(db, report.id)]);
  const readiness = publishReadiness(report, sections, items);
  if (!readiness.ok) return { ok: false, error: 'The report is not ready to publish.', problems: readiness.problems };

  const prevMax = await db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM report_versions WHERE report_id = ?`)
    .bind(report.id)
    .first<{ v: number }>();
  const version = (prevMax?.v ?? 0) + 1;
  const kind = version === 1 ? 'original' : 'amendment';
  const publishedAt = nowIso();

  const payload = buildSnapshot(report, ctx, sections, items, photos, {
    version,
    kind,
    amendmentReason: opts.amendmentReason ?? null,
    publishedAt,
    inspectorName: opts.inspectorName,
  });
  const payloadJson = JSON.stringify(payload);
  const sha = await sha256Hex(payloadJson);
  const versionId = newId('rv');

  await db.batch([
    db
      .prepare(`UPDATE report_versions SET status = 'superseded', superseded_at = ? WHERE report_id = ? AND status = 'published'`)
      .bind(publishedAt, report.id),
    db
      .prepare(
        `INSERT INTO report_versions (id, report_id, request_id, version, status, kind, amendment_reason, payload_json,
           payload_sha256, published_by, published_at)
         VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(versionId, report.id, report.request_id, version, kind, opts.amendmentReason ?? null, payloadJson, sha, actor, publishedAt),
    db
      .prepare(
        `UPDATE inspection_reports SET state = 'published', published_version_id = ?,
           published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`,
      )
      .bind(versionId, publishedAt, publishedAt, report.id),
  ]);

  await reportAudit(db, actor, kind === 'original' ? 'publish' : 'publish_amendment', {
    reportId: report.id,
    requestId: report.request_id,
    versionId,
  }, { prev: 'ready_for_review', next: 'published' }, { version, sha256: sha, warnings: readiness.warnings });

  return { ok: true, versionId, version };
}

/** The latest published version for a request — the ONLY thing customers see. */
export async function getPublishedVersion(
  db: D1Database,
  requestId: string,
): Promise<{ id: string; report_id: string; version: number; kind: string; payload_json: string; pdf_object_key: string | null; published_at: string } | null> {
  return db
    .prepare(
      `SELECT id, report_id, version, kind, payload_json, pdf_object_key, published_at
       FROM report_versions WHERE request_id = ? AND status = 'published'
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(requestId)
    .first();
}
