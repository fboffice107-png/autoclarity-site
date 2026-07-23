// GET /api/portal/report-pdf — download the branded PDF of the customer's
// latest PUBLISHED report version. Magic-token authorized; same immutable
// snapshot as the HTML report; stored privately in R2 when enabled, otherwise
// rendered on demand. Never public, never enumerable.

import type { Env } from '../../lib/types.ts';
import { requirePortal } from '../../lib/portal.ts';
import { getPublishedVersion } from '../../lib/report.ts';
import { versionPdfResponse } from '../../lib/report-pdf.ts';
import { errorJson } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requirePortal(context.request, context.env);
  if (!auth.ok) return auth.response;

  const version = await getPublishedVersion(context.env.DB, auth.requestId);
  if (!version) return errorJson('not_ready', 'Your inspection report has not been published yet.', 404);

  const ref = await context.env.DB.prepare(`SELECT ref FROM ppi_requests WHERE id = ?`).bind(auth.requestId).first<{ ref: string }>();
  return versionPdfResponse(context.env, version, ref?.ref ?? 'report');
};
