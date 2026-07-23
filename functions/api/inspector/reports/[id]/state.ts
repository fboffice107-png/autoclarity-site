// POST /api/inspector/reports/:id/state — move the authoring state
// (in_progress ⇄ draft_complete ⇄ ready_for_review). Publishing and amending
// have dedicated endpoints with their own guards.

import type { Env } from '../../../../lib/types.ts';
import { requireInspectorReport } from '../../../../lib/inspector.ts';
import { canMoveState, reportAudit, REPORT_STATES, type ReportState } from '../../../../lib/report.ts';
import { applyStatus, type Status } from '../../../../lib/status.ts';
import { errorJson, json, nowIso } from '../../../../lib/util.ts';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''), { mutation: true });
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  const report = auth.report;

  let body: { to?: string };
  try {
    body = (await context.request.json()) as { to?: string };
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }
  const to = String(body.to ?? '') as ReportState;
  if (!(REPORT_STATES as readonly string[]).includes(to)) return errorJson('validation', 'Unknown report state.', 422);
  if (to === 'published') return errorJson('validation', 'Use the publish endpoint (it requires explicit confirmation).', 422);
  if (report.state === 'published') return errorJson('locked', 'This report is published. Create an amendment to make changes.', 423);
  if (!canMoveState(report.state, to)) {
    return errorJson('invalid_transition', `Cannot move from ${report.state} to ${to}.`, 409);
  }

  const upd = await db
    .prepare(`UPDATE inspection_reports SET state = ?, updated_at = ? WHERE id = ? AND state = ?`)
    .bind(to, nowIso(), report.id, report.state)
    .run();
  if ((upd.meta?.changes ?? 0) !== 1) return errorJson('conflict', 'The report state changed concurrently — reload.', 409);

  await reportAudit(db, auth.actor, 'set_state', { reportId: report.id, requestId: report.request_id }, { prev: report.state, next: to });

  // Walk the request status alongside (best effort; report state is primary).
  if (to === 'draft_complete' || to === 'ready_for_review') {
    const reqRow = await db.prepare(`SELECT status FROM ppi_requests WHERE id = ?`).bind(report.request_id).first<{ status: string }>();
    if (reqRow?.status === 'inspection_in_progress') {
      await applyStatus(db, report.request_id, 'inspection_in_progress' as Status, 'report_in_progress', auth.actor, `Report ${to}`, report.id);
    }
  }

  return json({ ok: true, state: to });
};
