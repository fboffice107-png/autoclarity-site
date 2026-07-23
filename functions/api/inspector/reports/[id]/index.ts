// GET /api/inspector/reports/:id — the complete working report for the editor:
// report row, request/vehicle context, sections, items, photos, versions,
// readiness. :id may be a report id or a request id.

import type { Env } from '../../../../lib/types.ts';
import { requireInspectorReport, r2OrNull } from '../../../../lib/inspector.ts';
import {
  getItems,
  getPhotos,
  getRequestContext,
  getSections,
  getVersions,
  publishReadiness,
  displayState,
} from '../../../../lib/report.ts';
import { REPORT_SECTIONS, NOT_INSPECTED_REASON_LABELS, PRIORITY_LABELS, VERDICT_LABELS } from '../../../../lib/report-template.ts';
import { errorJson, json } from '../../../../lib/util.ts';

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

  return json({
    report,
    context: ctx,
    sections,
    items,
    photos: photos.map((p) => ({
      id: p.id,
      itemKey: p.item_key,
      caption: p.caption,
      sort: p.sort,
      contentType: p.content_type,
      sizeBytes: p.size_bytes,
      width: p.width,
      height: p.height,
    })),
    versions,
    readiness: publishReadiness(report, sections, items),
    displayState: displayState(report.state, versions.length),
    uploadsEnabled: r2OrNull(context.env) !== null,
    template: {
      sections: REPORT_SECTIONS,
      labels: {
        notInspectedReasons: NOT_INSPECTED_REASON_LABELS,
        priorities: PRIORITY_LABELS,
        verdicts: VERDICT_LABELS,
      },
    },
  });
};
