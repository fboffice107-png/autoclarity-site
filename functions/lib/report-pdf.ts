// Renders a published report-version snapshot (payload_json) into the branded
// customer PDF. The SAME payload drives the HTML report — no divergence.
// Photos are embedded when they are JPEG and readable from R2; otherwise the
// caption is listed with a pointer to the online report (honest fallback).

import type { Env } from './types.ts';
import { PDF_COLORS, ReportPdf, jpegDimensions, type PdfJpeg, type Rgb } from './pdf.ts';
import { NOT_INSPECTED_REASON_LABELS, PRIORITY_LABELS } from './report-template.ts';

type Payload = Record<string, any>;

const RESULT_LABELS: Record<string, string> = {
  pass: 'Pass',
  attention: 'Attention',
  fail: 'Fail',
  not_inspected: 'Not inspected',
  not_applicable: 'N/A',
};

const RESULT_COLORS: Record<string, Rgb> = {
  pass: PDF_COLORS.green,
  attention: PDF_COLORS.amber,
  fail: PDF_COLORS.red,
  not_inspected: PDF_COLORS.grey,
  not_applicable: PDF_COLORS.grey,
};

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function costRange(low: number | null, high: number | null): string | null {
  if (low === null && high === null) return null;
  if (low !== null && high !== null && low !== high) return `${money(low)}-${money(high)}`;
  return money((low ?? high)!);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export type PhotoFetcher = (photoId: string) => Promise<Uint8Array | null>;

export async function renderReportPdf(payload: Payload, fetchPhoto: PhotoFetcher | null): Promise<Uint8Array> {
  const v = payload;
  const veh = v.vehicle ?? {};
  const overall = v.overall ?? {};
  const rollups = v.rollups ?? {};
  const vehicleTitle = [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(' ');

  const pdf = new ReportPdf({
    footerLeft: `AutoClarity Pre-Purchase Inspection · ${v.ref ?? ''} · getautoclarity.com`,
    footerRight: `Version ${v.version ?? 1} · Published ${fmtDate(v.publishedAt)}`,
  });

  pdf.brandHeader([
    `Report ${v.ref ?? ''}`,
    `Version ${v.version ?? 1}${v.kind === 'amendment' ? ' (amended)' : ''}`,
    `Published ${fmtDate(v.publishedAt)}`,
    `Inspector: ${v.inspector ?? ''}`,
  ]);

  // Verdict banner
  const verdictColor: Rgb =
    overall.verdict === 'proceed' ? PDF_COLORS.green : overall.verdict === 'do_not_proceed' ? PDF_COLORS.red : PDF_COLORS.amber;
  pdf.verdictBanner(`${overall.score ?? '—'} / 10`, overall.verdictLabel ?? '—', verdictColor);

  if (v.kind === 'amendment') {
    pdf.para(`This is an amended report (version ${v.version}). It replaces all earlier versions.${v.amendmentReason ? ` Reason: ${v.amendmentReason}` : ''}`, {
      size: 9,
      italic: true,
      color: PDF_COLORS.amber,
    });
  }

  pdf.heading('Executive summary');
  pdf.para(String(overall.executiveSummary ?? ''), { size: 10 });
  if (overall.positiveFindings) {
    pdf.para('What presents well:', { size: 10, bold: true, after: 1 });
    pdf.para(String(overall.positiveFindings), { size: 10 });
  }

  pdf.heading('Vehicle & inspection details');
  pdf.kv('Vehicle', vehicleTitle || '—');
  pdf.kv('VIN', veh.vin ?? '—');
  if (veh.vinCheck === 'matches') pdf.kv('VIN check', 'Matches paperwork');
  if (veh.vinCheck === 'mismatch') pdf.kv('VIN check', 'MISMATCH — see summary');
  pdf.kv('Odometer', veh.odometerMiles ? `${Number(veh.odometerMiles).toLocaleString('en-US')} mi` : '—');
  if (veh.plate) pdf.kv('Plate', `${veh.plate}${veh.plateState ? ` (${veh.plateState})` : ''}`);
  pdf.kv('Title status (reported)', veh.titleStatus === 'clean' ? 'Clean (as reported)' : veh.titleStatus === 'salvage_rebuilt' ? 'Salvage / rebuilt (as reported)' : 'Unknown');
  if (veh.titleDisclosureNotes) pdf.kv('Title / disclosure notes', String(veh.titleDisclosureNotes));
  if (v.seller?.type || v.seller?.name) pdf.kv('Seller', [v.seller?.name, v.seller?.type ? `(${v.seller.type})` : null].filter(Boolean).join(' '));
  if (v.seller?.notes) pdf.kv('Seller notes', String(v.seller.notes));
  pdf.kv('Location', [v.location?.city, v.location?.state].filter(Boolean).join(', ') || '—');
  pdf.kv('Inspected', fmtDate(v.inspectedAt ?? v.appointment?.startsAt));
  pdf.kv('Prepared for', v.customer?.name ?? '—');

  // Rollup summary
  const counts = rollups.counts ?? {};
  pdf.heading('Results at a glance');
  pdf.kv('Passed', String(counts.pass ?? 0));
  pdf.kv('Attention', String(counts.attention ?? 0));
  pdf.kv('Failed', String(counts.fail ?? 0));
  pdf.kv('Not inspected', String(counts.notInspected ?? 0));
  pdf.kv('Not applicable', String(counts.notApplicable ?? 0));
  const est = costRange(rollups.estimatedCostLowCents ?? null, rollups.estimatedCostHighCents ?? null);
  if (est) pdf.kv('Estimated repair costs', `${est} (good-faith estimate, not a repair quote)`);

  // Indexes for cross-referencing rollup keys → items
  const itemsByKey = new Map<string, any>();
  for (const sec of v.sections ?? []) for (const it of sec.items ?? []) itemsByKey.set(it.key, it);

  const listFindings = (title: string, keys: string[], sevLabel: string, color: Rgb, emptyText: string | null) => {
    pdf.heading(title);
    if (!keys || keys.length === 0) {
      if (emptyText) pdf.para(emptyText, { size: 10, color: PDF_COLORS.green, bold: true });
      else pdf.para('None noted.', { size: 10, color: PDF_COLORS.grey });
      return;
    }
    for (const k of keys) {
      const it = itemsByKey.get(k);
      if (!it) continue;
      pdf.finding(sevLabel, color, it.label, it.note, costRange(it.costLowCents, it.costHighCents));
    }
  };

  listFindings('Immediate safety concerns', rollups.safetyItems ?? [], 'Safety', PDF_COLORS.red, 'None observed at the time of inspection.');
  listFindings('High-priority repairs', rollups.immediateItems ?? [], 'Priority', PDF_COLORS.red, null);
  listFindings('Repairs expected soon', rollups.soonItems ?? [], 'Soon', PDF_COLORS.amber, null);
  listFindings('Monitor', rollups.monitorItems ?? [], 'Monitor', PDF_COLORS.grey, null);

  if ((rollups.negotiationItems ?? []).length > 0 || overall.negotiationSummary) {
    pdf.heading('Negotiation considerations');
    if (overall.negotiationSummary) pdf.para(String(overall.negotiationSummary), { size: 10 });
    for (const k of rollups.negotiationItems ?? []) {
      const it = itemsByKey.get(k);
      if (!it) continue;
      pdf.finding('Negotiate', PDF_COLORS.blue, it.label, it.note, costRange(it.costLowCents, it.costHighCents));
    }
  }

  // Full section detail
  pdf.heading('Findings by section');
  pdf.para('Every checklist area with its result. Anything not inspected is identified with the reason.', {
    size: 9,
    color: PDF_COLORS.grey,
  });
  for (const sec of v.sections ?? []) {
    pdf.gap(4);
    pdf.line(sec.title, { size: 11, bold: true });
    if (sec.performed === 'not_performed') {
      const reason = sec.notPerformedReason ? (NOT_INSPECTED_REASON_LABELS as Record<string, string>)[sec.notPerformedReason] ?? sec.notPerformedReason : 'not performed';
      pdf.para(`Not performed — ${reason}.${sec.summary ? ` ${sec.summary}` : ''}`, { size: 9.5, italic: true, color: PDF_COLORS.grey });
      continue;
    }
    if (sec.summary) pdf.para(String(sec.summary), { size: 9.5, color: PDF_COLORS.grey });
    for (const it of sec.items ?? []) {
      const parts: string[] = [];
      if (it.measurement?.value) parts.push(`${it.measurement.label ?? 'Measured'}: ${it.measurement.value}${it.measurement.unit ? ` ${it.measurement.unit}` : ''}`);
      if (it.note) parts.push(String(it.note));
      if (it.result === 'not_inspected' && it.notInspectedReason) {
        parts.push(`Reason: ${(NOT_INSPECTED_REASON_LABELS as Record<string, string>)[it.notInspectedReason] ?? it.notInspectedReason}`);
      }
      if (it.priority && it.result !== 'pass') parts.push(`Priority: ${(PRIORITY_LABELS as Record<string, string>)[it.priority] ?? it.priority}`);
      pdf.finding(
        RESULT_LABELS[it.result] ?? it.result,
        RESULT_COLORS[it.result] ?? PDF_COLORS.grey,
        it.label,
        parts.length > 0 ? parts.join('  ·  ') : null,
        costRange(it.costLowCents, it.costHighCents),
      );
    }
  }

  // Photos
  const allPhotos: Array<{ id: string; caption: string | null; label: string }> = [];
  for (const sec of v.sections ?? []) {
    for (const it of sec.items ?? []) {
      for (const p of it.photos ?? []) allPhotos.push({ id: p.id, caption: p.caption, label: it.label });
    }
  }
  for (const p of v.generalPhotos ?? []) allPhotos.push({ id: p.id, caption: p.caption, label: 'General' });

  if (allPhotos.length > 0) {
    pdf.heading('Photographs');
    for (const p of allPhotos) {
      let jpeg: PdfJpeg | null = null;
      if (fetchPhoto) {
        const data = await fetchPhoto(p.id);
        if (data) {
          const dims = jpegDimensions(data);
          if (dims) jpeg = { data, width: dims.width, height: dims.height };
        }
      }
      const caption = `${p.label}${p.caption ? ` — ${p.caption}` : ''}`;
      if (jpeg) pdf.photo(jpeg, caption);
      else pdf.para(`• ${caption} (photo available in your online report)`, { size: 9, color: PDF_COLORS.grey });
    }
  }

  pdf.heading('Inspection limitations & disclosures');
  pdf.para(String(v.limitations?.standard ?? ''), { size: 8.5, color: PDF_COLORS.grey });
  if (v.limitations?.additional) pdf.para(String(v.limitations.additional), { size: 8.5, color: PDF_COLORS.grey });
  pdf.para(`Inspector: ${v.inspector ?? ''} — AutoClarity, Las Vegas. Questions: support@getautoclarity.com`, {
    size: 8.5,
    color: PDF_COLORS.grey,
  });

  return pdf.bytes();
}

export interface VersionForPdf {
  id: string;
  report_id: string;
  version: number;
  payload_json: string;
  pdf_object_key: string | null;
}

/**
 * Serve a published version's PDF: from R2 when it was stored at publish time,
 * otherwise rendered on demand from the immutable snapshot (identical data →
 * consistent output). Never public, never enumerable — every caller has
 * already verified authorization for this specific report.
 */
export async function versionPdfResponse(env: Env, version: VersionForPdf, filenameRef: string): Promise<Response> {
  const filename = `AutoClarity-Inspection-Report-${filenameRef}-v${version.version}.pdf`;
  const headers = {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex, nofollow',
  };

  const r2Enabled = env.UPLOADS_ENABLED !== 'false' && env.UPLOADS;
  if (version.pdf_object_key && r2Enabled) {
    const obj = await env.UPLOADS.get(version.pdf_object_key);
    if (obj) return new Response(obj.body, { headers });
  }

  const payload = JSON.parse(version.payload_json) as Payload;
  const fetchPhoto: PhotoFetcher | null = r2Enabled
    ? async (photoId) => {
        const row = await env.DB
          .prepare(`SELECT object_key FROM report_photos WHERE id = ? AND report_id = ?`)
          .bind(photoId, version.report_id)
          .first<{ object_key: string }>();
        if (!row) return null;
        const obj = await env.UPLOADS.get(row.object_key);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      }
    : null;
  const bytes = await renderReportPdf(payload, fetchPhoto);
  return new Response(bytes, { headers });
}
