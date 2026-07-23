// Shared helpers for the /api/inspector endpoints: owner/staff auth plus
// report resolution. The editor addresses reports by REQUEST id (the private
// URL is /inspector/inspections/:requestId/report), so lookups accept either
// a report id (rpt_…) or a request id (req_…).

import type { Env } from './types.ts';
import { requireAdmin } from './auth.ts';
import { getReport, getReportByRequest, type ReportRow } from './report.ts';
import { errorJson, originAllowed } from './util.ts';

export type InspectorReportAuth =
  | { ok: true; actor: string; report: ReportRow }
  | { ok: false; response: Response };

export async function requireInspectorReport(
  request: Request,
  env: Env,
  id: string,
  opts: { mutation?: boolean } = {},
): Promise<InspectorReportAuth> {
  if (opts.mutation && !originAllowed(request, env.PUBLIC_BASE_URL)) {
    return { ok: false, response: errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403) };
  }
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return { ok: false, response: auth.response };

  let report = id.startsWith('rpt_') ? await getReport(env.DB, id) : null;
  if (!report) report = await getReportByRequest(env.DB, id);
  if (!report && id.startsWith('rpt_')) {
    // A report id that no longer resolves — nothing further to try.
    return { ok: false, response: errorJson('not_found', 'Report not found.', 404) };
  }
  if (!report) return { ok: false, response: errorJson('not_found', 'No report exists for this request yet. Start the inspection first.', 404) };
  return { ok: true, actor: auth.actor, report };
}

/** R2 bucket when uploads are enabled AND the binding exists, else null. */
export function r2OrNull(env: Env): R2Bucket | null {
  if (env.UPLOADS_ENABLED === 'false') return null;
  return env.UPLOADS ?? null;
}
