// POST /api/inspector/reports/:id/photos — attach an inspection photo to a
// report (optionally to a specific finding via itemKey). Feature-flagged on
// R2: when the bucket is unavailable this endpoint reports it honestly and
// text/checklist reports keep working. Validation: size cap, MIME allowlist,
// magic-byte sniffing. Keys are randomized — nothing is enumerable or public.

import type { Env } from '../../../../../lib/types.ts';
import { requireInspectorReport, r2OrNull } from '../../../../../lib/inspector.ts';
import { itemDef } from '../../../../../lib/report-template.ts';
import { reportAudit } from '../../../../../lib/report.ts';
import { jpegDimensions } from '../../../../../lib/pdf.ts';
import { clampStr, errorJson, json, newId, nowIso, originAllowed } from '../../../../../lib/util.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PHOTOS_PER_REPORT = 120;

function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!originAllowed(request, env.PUBLIC_BASE_URL)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  const auth = await requireInspectorReport(request, env, String(context.params['id'] ?? ''), { mutation: true });
  if (!auth.ok) return auth.response;
  const report = auth.report;

  const r2 = r2OrNull(env);
  if (!r2) {
    return errorJson(
      'uploads_disabled',
      'Photo storage (R2) is not enabled on this deployment yet. The report works without photos; see docs/PPI_R2_SETUP.md for the owner activation steps.',
      409,
    );
  }
  if (report.state === 'published') {
    return errorJson('locked', 'This report is published. Create an amendment to change photos.', 423);
  }

  const db = env.DB;
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM report_photos WHERE report_id = ? AND deleted_at IS NULL`)
    .bind(report.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PHOTOS_PER_REPORT) {
    return errorJson('photo_limit', `Up to ${MAX_PHOTOS_PER_REPORT} photos per report.`, 409);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorJson('bad_form', 'Expected multipart form data.', 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return errorJson('validation', 'No file provided.', 422);
  if (file.size > MAX_BYTES) return errorJson('too_large', 'Each photo must be under 10 MB.', 413);

  const itemKeyRaw = clampStr(form.get('itemKey'), 80);
  if (itemKeyRaw && !itemDef(itemKeyRaw)) return errorJson('validation', 'Unknown checklist item for this photo.', 422);
  const caption = clampStr(form.get('caption'), 200);

  const buffer = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImage(buffer);
  if (!sniffed) return errorJson('bad_type', 'Only JPEG, PNG or WebP images are accepted.', 422);

  // JPEG dimensions recorded when parseable (used for PDF layout).
  const dims = sniffed === 'image/jpeg' ? jpegDimensions(buffer) : null;

  const ext = sniffed === 'image/jpeg' ? 'jpg' : sniffed === 'image/png' ? 'png' : 'webp';
  const objectKey = `reports/${report.id}/photos/${crypto.randomUUID()}.${ext}`;
  await r2.put(objectKey, buffer, { httpMetadata: { contentType: sniffed } });

  const maxSort = await db
    .prepare(`SELECT COALESCE(MAX(sort), 0) AS s FROM report_photos WHERE report_id = ?`)
    .bind(report.id)
    .first<{ s: number }>();

  const id = newId('rph');
  await db
    .prepare(
      `INSERT INTO report_photos (id, report_id, item_key, object_key, content_type, size_bytes, width, height, caption, sort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, report.id, itemKeyRaw || null, objectKey, sniffed, buffer.byteLength, dims?.width ?? null, dims?.height ?? null, caption || null, (maxSort?.s ?? 0) + 1, nowIso())
    .run();

  await reportAudit(db, auth.actor, 'photo_added', { reportId: report.id, requestId: report.request_id }, undefined, {
    photoId: id,
    itemKey: itemKeyRaw || null,
    bytes: buffer.byteLength,
  });
  return json({ ok: true, id, itemKey: itemKeyRaw || null, caption: caption || null, contentType: sniffed, width: dims?.width ?? null, height: dims?.height ?? null });
};
