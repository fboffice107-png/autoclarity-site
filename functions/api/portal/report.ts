// GET /api/portal/report — the customer's PUBLISHED inspection report.
// Magic-token authorized; scoped to the token's own request; only ever serves
// the immutable published snapshot (drafts and internal notes do not exist on
// this path). 404 until a version is published.

import type { Env } from '../../lib/types.ts';
import { requirePortal } from '../../lib/portal.ts';
import { getPublishedVersion } from '../../lib/report.ts';
import { errorJson, json } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requirePortal(context.request, context.env);
  if (!auth.ok) return auth.response;
  const db = context.env.DB;

  const version = await getPublishedVersion(db, auth.requestId);
  if (!version) return errorJson('not_ready', 'Your inspection report has not been published yet.', 404);

  const history = await db
    .prepare(
      `SELECT version, kind, amendment_reason, published_at, status FROM report_versions
       WHERE request_id = ? ORDER BY version DESC`,
    )
    .bind(auth.requestId)
    .all<Record<string, unknown>>();

  return json({
    payload: JSON.parse(version.payload_json),
    version: version.version,
    kind: version.kind,
    publishedAt: version.published_at,
    pdfAvailable: true,
    history: history.results ?? [],
  });
};
