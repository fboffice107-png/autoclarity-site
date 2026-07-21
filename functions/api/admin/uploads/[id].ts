// GET /api/admin/uploads/:id — stream a customer upload to the admin.

import type { Env } from '../../../lib/types.ts';
import { requireAdmin } from '../../../lib/auth.ts';
import { errorJson } from '../../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;

  const id = String(context.params['id'] ?? '');
  const row = await context.env.DB
    .prepare(`SELECT object_key, content_type, original_name FROM request_uploads WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ object_key: string; content_type: string; original_name: string }>();
  if (!row) return errorJson('not_found', 'Upload not found.', 404);

  const object = await context.env.UPLOADS.get(row.object_key);
  if (!object) return errorJson('not_found', 'Object missing from storage.', 404);

  return new Response(object.body, {
    headers: {
      'content-type': row.content_type,
      'content-disposition': `inline; filename="${row.original_name.replaceAll('"', '')}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
};
