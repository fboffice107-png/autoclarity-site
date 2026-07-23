// POST /api/inspector/reports/:id/save — autosave a batch of edits.
// Optimistic concurrency: the client sends baseSeq (the autosave_seq it loaded)
// and receives the new seq back. A mismatch means another device/tab saved
// first → 409 so the client reloads instead of clobbering. Published reports
// are locked (amend first).

import type { Env } from '../../../../lib/types.ts';
import { requireInspectorReport } from '../../../../lib/inspector.ts';
import { applySave, reportAudit, type SaveItemPatch, type SaveReportPatch, type SaveSectionPatch } from '../../../../lib/report.ts';
import { errorJson, json } from '../../../../lib/util.ts';

interface SaveBody {
  baseSeq?: number;
  report?: SaveReportPatch;
  sections?: SaveSectionPatch[];
  items?: SaveItemPatch[];
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''), { mutation: true });
  if (!auth.ok) return auth.response;

  let body: SaveBody;
  try {
    body = (await context.request.json()) as SaveBody;
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }
  if ((body.items?.length ?? 0) > 60 || (body.sections?.length ?? 0) > 40) {
    return errorJson('validation', 'Save batch too large — split it up.', 422);
  }

  const result = await applySave(context.env.DB, auth.report, Number(body.baseSeq), {
    report: body.report,
    sections: body.sections,
    items: body.items,
  });

  if (!result.ok) {
    const status = result.code === 'conflict' ? 409 : result.code === 'locked' ? 423 : 422;
    return errorJson(result.code, result.message, status);
  }

  // Autosaves are frequent; audit sparsely (first save + every 25th).
  if (result.seq === 1 || result.seq % 25 === 0) {
    await reportAudit(context.env.DB, auth.actor, 'autosave', { reportId: auth.report.id, requestId: auth.report.request_id }, undefined, {
      seq: result.seq,
      items: body.items?.length ?? 0,
    });
  }
  return json({ ok: true, seq: result.seq });
};
