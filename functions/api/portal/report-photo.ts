// GET /api/portal/report-photo?id=… — stream a report photo to the customer.
// Authorization chain: magic token → that customer's request → its report →
// the photo row → AND the photo must appear in a PUBLISHED version snapshot.
// Draft-only photos are invisible; other customers' photos are unreachable.

import type { Env } from '../../lib/types.ts';
import { requirePortal } from '../../lib/portal.ts';
import { getPublishedVersion } from '../../lib/report.ts';
import { errorJson } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requirePortal(context.request, context.env);
  if (!auth.ok) return auth.response;
  const db = context.env.DB;

  const id = new URL(context.request.url).searchParams.get('id') ?? '';
  const version = await getPublishedVersion(db, auth.requestId);
  if (!version) return errorJson('not_found', 'Photo not found.', 404);
  if (!version.payload_json.includes(`"${id}"`)) return errorJson('not_found', 'Photo not found.', 404);

  const photo = await db
    .prepare(`SELECT object_key, content_type FROM report_photos WHERE id = ? AND report_id = ?`)
    .bind(id, version.report_id)
    .first<{ object_key: string; content_type: string }>();
  if (!photo) return errorJson('not_found', 'Photo not found.', 404);

  if (context.env.UPLOADS_ENABLED === 'false' || !context.env.UPLOADS) {
    return errorJson('uploads_disabled', 'Photo storage is not enabled.', 409);
  }
  const obj = await context.env.UPLOADS.get(photo.object_key);
  if (!obj) return errorJson('not_found', 'Photo not found.', 404);

  return new Response(obj.body, {
    headers: {
      'content-type': photo.content_type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
};
