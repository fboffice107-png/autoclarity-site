// POST /api/inspector/reports/:id/amend — reopen a PUBLISHED report for
// correction. The working draft becomes editable again; the customer keeps
// seeing the latest published version until the amendment is published as a
// NEW version. Published versions are never modified.

import type { Env } from '../../../../lib/types.ts';
import { requireInspectorReport } from '../../../../lib/inspector.ts';
import { reportAudit } from '../../../../lib/report.ts';
import { clampStr, errorJson, json, nowIso } from '../../../../lib/util.ts';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''), { mutation: true });
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  const report = auth.report;

  let body: { reason?: string };
  try {
    body = (await context.request.json()) as { reason?: string };
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }
  const reason = clampStr(body.reason, 500);
  if (report.state !== 'published') return errorJson('wrong_state', 'Only a published report can be amended.', 409);
  if (reason.length < 5) return errorJson('validation', 'Give a short reason for the amendment.', 422);

  const upd = await db
    .prepare(`UPDATE inspection_reports SET state = 'in_progress', updated_at = ? WHERE id = ? AND state = 'published'`)
    .bind(nowIso(), report.id)
    .run();
  if ((upd.meta?.changes ?? 0) !== 1) return errorJson('conflict', 'The report state changed concurrently — reload.', 409);

  await reportAudit(db, auth.actor, 'amend_opened', { reportId: report.id, requestId: report.request_id }, { prev: 'published', next: 'in_progress' }, { reason });
  return json({ ok: true, state: 'in_progress', note: 'The customer keeps seeing the current published version until you publish the amendment.' });
};
