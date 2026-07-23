// POST /api/inspector/reports/:id/publish — the explicit, confirmed
// publication step. Requires state=ready_for_review AND the request ref typed
// back as the confirmation phrase (no accidental publishes). Creates the
// immutable version, stores the branded PDF (R2 when enabled), walks the
// request status to completed, and sends idempotent notifications.

import type { Env } from '../../../../lib/types.ts';
import { requireInspectorReport, r2OrNull } from '../../../../lib/inspector.ts';
import { getRequestContext, publishReport, reportAudit } from '../../../../lib/report.ts';
import { renderReportPdf } from '../../../../lib/report-pdf.ts';
import { applyStatus, type Status } from '../../../../lib/status.ts';
import { getConfig } from '../../../../lib/config.ts';
import { issueMagicLink, portalUrl } from '../../../../lib/magic.ts';
import { sendTemplate } from '../../../../lib/email.ts';
import { clampStr, errorJson, json, newId, nowIso } from '../../../../lib/util.ts';

const INSPECTOR_NAME = 'Faheb Brown — Founder & Lead Technician, AutoClarity';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env } = context;
  const auth = await requireInspectorReport(context.request, env, String(context.params['id'] ?? ''), { mutation: true });
  if (!auth.ok) return auth.response;
  const db = env.DB;
  const report = auth.report;

  let body: { confirm?: string; amendmentReason?: string };
  try {
    body = (await context.request.json()) as { confirm?: string; amendmentReason?: string };
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }

  const ctx = await getRequestContext(db, report.request_id);
  if (!ctx) return errorJson('not_found', 'The underlying request no longer exists.', 404);

  // Explicit confirmation: the inspector types the request ref back.
  if (clampStr(body.confirm, 40).toUpperCase() !== ctx.ref.toUpperCase()) {
    return errorJson('confirm_required', `Type the request reference (${ctx.ref}) to confirm publication.`, 422);
  }

  const isAmendment = report.published_version_id !== null || report.published_at !== null;
  const amendmentReason = isAmendment ? clampStr(body.amendmentReason, 500) || null : null;
  if (isAmendment && !amendmentReason) {
    return errorJson('validation', 'Give the reason for this amendment (shown in the version history).', 422);
  }

  const outcome = await publishReport(env, report, auth.actor, { amendmentReason, inspectorName: INSPECTOR_NAME });
  if (!outcome.ok) {
    return errorJson('not_ready', outcome.error ?? 'The report is not ready to publish.', 409, { problems: outcome.problems ?? [] });
  }

  // Store the branded PDF in R2 when available (on-demand rendering from the
  // immutable snapshot is the fallback — same payload, same output).
  const r2 = r2OrNull(env);
  let pdfStored = false;
  if (r2) {
    try {
      const version = await db
        .prepare(`SELECT id, payload_json FROM report_versions WHERE id = ?`)
        .bind(outcome.versionId!)
        .first<{ id: string; payload_json: string }>();
      if (version) {
        const payload = JSON.parse(version.payload_json) as Record<string, unknown>;
        const bytes = await renderReportPdf(payload, async (photoId) => {
          const row = await db.prepare(`SELECT object_key FROM report_photos WHERE id = ? AND report_id = ?`).bind(photoId, report.id).first<{ object_key: string }>();
          if (!row) return null;
          const obj = await r2.get(row.object_key);
          return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
        });
        const key = `reports/${report.id}/${outcome.versionId}-${newId('pdf')}.pdf`;
        await r2.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
        await db.prepare(`UPDATE report_versions SET pdf_object_key = ? WHERE id = ?`).bind(key, outcome.versionId).run();
        pdfStored = true;
      }
    } catch (e) {
      // PDF storage is best-effort; on-demand rendering still serves customers.
      await reportAudit(db, auth.actor, 'pdf_store_failed', { reportId: report.id, versionId: outcome.versionId }, undefined, { error: String(e).slice(0, 300) });
    }
  }

  // Walk the request status to completed through legal steps (best effort).
  const reqRow = await db.prepare(`SELECT status FROM ppi_requests WHERE id = ?`).bind(report.request_id).first<{ status: string }>();
  let status = reqRow?.status as Status | undefined;
  if (status === 'inspection_in_progress') {
    if (await applyStatus(db, report.request_id, status, 'report_in_progress', auth.actor, 'Report publication', report.id)) status = 'report_in_progress';
  }
  if (status === 'report_in_progress') {
    await applyStatus(db, report.request_id, status, 'completed', auth.actor, `Report v${outcome.version} published`, outcome.versionId);
  }

  // Idempotent notifications (dedupe key = version id → once per publication).
  const config = await getConfig(db);
  const base = (env.PUBLIC_BASE_URL ?? new URL(context.request.url).origin).replace(/\/$/, '');
  const { token } = await issueMagicLink(db, report.request_id, config);
  const template = outcome.version === 1 ? 'report_ready' : 'report_amended';
  await sendTemplate(env, db, report.request_id, template, ctx.customer_email, {
    ref: ctx.ref,
    portalUrl: portalUrl(base, token),
    supportEmail: config.supportEmail,
    extra: { version: String(outcome.version) },
  }, undefined, `${template}:${outcome.versionId}`);
  if (env.ADMIN_NOTIFY_EMAIL) {
    await sendTemplate(env, db, report.request_id, 'owner_notify', env.ADMIN_NOTIFY_EMAIL, {
      ref: ctx.ref,
      supportEmail: config.supportEmail,
      extra: { kind: outcome.version === 1 ? 'report_published' : 'amended_report_published', detail: `Version ${outcome.version} published at ${nowIso()}` },
    }, undefined, `report_published_owner:${outcome.versionId}`);
  }

  return json({ ok: true, versionId: outcome.versionId, version: outcome.version, pdfStored });
};
