// GET /api/inspector/reports/:id/pdf?version=N — the branded PDF of a
// published version, for the inspector's own verification. Defaults to the
// latest published version.

import type { Env } from '../../../../lib/types.ts';
import { requireInspectorReport } from '../../../../lib/inspector.ts';
import { getRequestContext } from '../../../../lib/report.ts';
import { versionPdfResponse, type VersionForPdf } from '../../../../lib/report-pdf.ts';
import { errorJson } from '../../../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''));
  if (!auth.ok) return auth.response;
  const db = context.env.DB;

  const url = new URL(context.request.url);
  const versionParam = Number(url.searchParams.get('version') ?? '');
  const version = Number.isInteger(versionParam) && versionParam > 0
    ? await db
        .prepare(`SELECT id, report_id, version, payload_json, pdf_object_key FROM report_versions WHERE report_id = ? AND version = ?`)
        .bind(auth.report.id, versionParam)
        .first<VersionForPdf>()
    : await db
        .prepare(`SELECT id, report_id, version, payload_json, pdf_object_key FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT 1`)
        .bind(auth.report.id)
        .first<VersionForPdf>();
  if (!version) return errorJson('not_found', 'No published version exists yet.', 404);

  const ctx = await getRequestContext(db, auth.report.request_id);
  return versionPdfResponse(context.env, version, ctx?.ref ?? auth.report.request_id);
};
