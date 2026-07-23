// GET /api/inspector/reports/:id/preview — exactly what publishing would
// produce (same snapshot builder), plus the readiness checklist. Nothing is
// stored; drafts remain invisible to customers.

import type { Env } from '../../../../lib/types.ts';
import { requireInspectorReport } from '../../../../lib/inspector.ts';
import { buildSnapshot, getItems, getPhotos, getRequestContext, getSections, getVersions, publishReadiness } from '../../../../lib/report.ts';
import { errorJson, json, nowIso } from '../../../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''));
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  const report = auth.report;

  const [ctx, sections, items, photos, versions] = await Promise.all([
    getRequestContext(db, report.request_id),
    getSections(db, report.id),
    getItems(db, report.id),
    getPhotos(db, report.id),
    getVersions(db, report.id),
  ]);
  if (!ctx) return errorJson('not_found', 'The underlying request no longer exists.', 404);

  const nextVersion = versions.length + 1;
  const payload = buildSnapshot(report, ctx, sections, items, photos, {
    version: nextVersion,
    kind: nextVersion === 1 ? 'original' : 'amendment',
    amendmentReason: null,
    publishedAt: nowIso(),
    inspectorName: 'Faheb Brown — Founder & Lead Technician, AutoClarity',
  });

  return json({
    preview: true,
    payload,
    readiness: publishReadiness(report, sections, items),
    state: report.state,
    versionCount: versions.length,
    confirmPhrase: ctx.ref,
  });
};
