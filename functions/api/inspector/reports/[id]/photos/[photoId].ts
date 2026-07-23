// /api/inspector/reports/:id/photos/:photoId
//   GET    — stream the photo back to the inspector UI
//   PATCH  — update caption / finding assignment / sort order
//   DELETE — remove from the working draft. The R2 object is only deleted when
//            no published version references the photo (published evidence is
//            never destroyed; the row is soft-deleted either way).

import type { Env } from '../../../../../lib/types.ts';
import { requireInspectorReport, r2OrNull } from '../../../../../lib/inspector.ts';
import { itemDef } from '../../../../../lib/report-template.ts';
import { reportAudit } from '../../../../../lib/report.ts';
import { clampStr, errorJson, json, nowIso } from '../../../../../lib/util.ts';

interface PhotoRowLite {
  id: string;
  report_id: string;
  item_key: string | null;
  object_key: string;
  content_type: string;
  deleted_at: string | null;
}

async function loadPhoto(db: D1Database, reportId: string, photoId: string): Promise<PhotoRowLite | null> {
  return db
    .prepare(`SELECT id, report_id, item_key, object_key, content_type, deleted_at FROM report_photos WHERE id = ? AND report_id = ?`)
    .bind(photoId, reportId)
    .first<PhotoRowLite>();
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''));
  if (!auth.ok) return auth.response;
  const photo = await loadPhoto(context.env.DB, auth.report.id, String(context.params['photoId'] ?? ''));
  if (!photo || photo.deleted_at) return errorJson('not_found', 'Photo not found.', 404);
  const r2 = r2OrNull(context.env);
  if (!r2) return errorJson('uploads_disabled', 'Photo storage is not enabled.', 409);
  const obj = await r2.get(photo.object_key);
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

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''), { mutation: true });
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  if (auth.report.state === 'published') return errorJson('locked', 'This report is published. Create an amendment to change photos.', 423);
  const photo = await loadPhoto(db, auth.report.id, String(context.params['photoId'] ?? ''));
  if (!photo || photo.deleted_at) return errorJson('not_found', 'Photo not found.', 404);

  let body: { caption?: string | null; itemKey?: string | null; sort?: number };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if ('caption' in body) {
    sets.push('caption = ?');
    binds.push(clampStr(body.caption, 200) || null);
  }
  if ('itemKey' in body) {
    const key = clampStr(body.itemKey, 80);
    if (key && !itemDef(key)) return errorJson('validation', 'Unknown checklist item.', 422);
    sets.push('item_key = ?');
    binds.push(key || null);
  }
  if ('sort' in body && Number.isInteger(body.sort)) {
    sets.push('sort = ?');
    binds.push(body.sort);
  }
  if (sets.length === 0) return errorJson('validation', 'Nothing to update.', 422);
  await db.prepare(`UPDATE report_photos SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, photo.id).run();
  await reportAudit(db, auth.actor, 'photo_updated', { reportId: auth.report.id, requestId: auth.report.request_id }, undefined, { photoId: photo.id });
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = await requireInspectorReport(context.request, context.env, String(context.params['id'] ?? ''), { mutation: true });
  if (!auth.ok) return auth.response;
  const db = context.env.DB;
  if (auth.report.state === 'published') return errorJson('locked', 'This report is published. Create an amendment to change photos.', 423);
  const photo = await loadPhoto(db, auth.report.id, String(context.params['photoId'] ?? ''));
  if (!photo || photo.deleted_at) return errorJson('not_found', 'Photo not found.', 404);

  // Is this photo referenced by any published version snapshot?
  const referenced = await db
    .prepare(`SELECT id FROM report_versions WHERE report_id = ? AND payload_json LIKE ? LIMIT 1`)
    .bind(auth.report.id, `%"${photo.id}"%`)
    .first<{ id: string }>();

  await db.prepare(`UPDATE report_photos SET deleted_at = ? WHERE id = ?`).bind(nowIso(), photo.id).run();
  let objectDeleted = false;
  if (!referenced) {
    const r2 = r2OrNull(context.env);
    if (r2) {
      await r2.delete(photo.object_key);
      objectDeleted = true;
    }
  }
  await reportAudit(db, auth.actor, 'photo_removed', { reportId: auth.report.id, requestId: auth.report.request_id }, undefined, {
    photoId: photo.id,
    objectDeleted,
    retainedForVersions: !!referenced,
  });
  return json({ ok: true, retainedForVersions: !!referenced });
};
