// /api/portal/upload — customer image uploads, magic-token authenticated.
// POST multipart/form-data (field "file", optional "kind") → private R2 object
// with a randomized key. GET ?id= streams the customer's own upload back.
// Validation: count cap, size cap, MIME allowlist AND magic-byte sniffing.
// Uploaded content is never executed, never public, never indexed.

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { getConfig } from '../../lib/config.ts';
import { requirePortal } from '../../lib/portal.ts';
import { errorJson, json, newId, nowIso, clampStr, originAllowed } from '../../lib/util.ts';
import { formOrigins } from '../../lib/cors.ts';

const KIND_OPTIONS = ['listing', 'vin', 'dashboard', 'damage', 'other'] as const;

function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  // HEIC/HEIF: ....ftyp + brand (heic/heix/hevc/mif1/msf1)
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!originAllowed(request, env.PUBLIC_BASE_URL, formOrigins(env))) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  const flags = modeFlags(env);
  if (!flags.uploadsEnabled) return errorJson('uploads_disabled', 'Uploads are switched off right now.', 409);

  const auth = await requirePortal(request, env);
  if (!auth.ok) return auth.response;
  const config = await getConfig(env.DB);

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > config.uploads.maxBytes + 64 * 1024) {
    return errorJson('too_large', `Each image must be under ${Math.round(config.uploads.maxBytes / 1048576)} MB.`, 413);
  }

  const existing = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM request_uploads WHERE request_id = ? AND deleted_at IS NULL`)
    .bind(auth.requestId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) >= config.uploads.maxFiles) {
    return errorJson('upload_limit', `Up to ${config.uploads.maxFiles} images per request.`, 409);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorJson('bad_form', 'Expected multipart form data.', 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return errorJson('validation', 'No file provided.', 422);
  if (file.size > config.uploads.maxBytes) {
    return errorJson('too_large', `Each image must be under ${Math.round(config.uploads.maxBytes / 1048576)} MB.`, 413);
  }

  const declaredType = file.type.toLowerCase();
  if (!config.uploads.allowedTypes.includes(declaredType)) {
    return errorJson('bad_type', 'Only JPEG, PNG, WebP or HEIC images are accepted.', 422);
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImage(buffer);
  if (!sniffed) return errorJson('bad_type', 'The file does not look like a supported image.', 422);

  const kindRaw = clampStr(form.get('kind'), 20) as (typeof KIND_OPTIONS)[number];
  const kind = KIND_OPTIONS.includes(kindRaw) ? kindRaw : 'other';

  // Randomized key; original filename kept only as sanitized display text.
  const ext = EXT_BY_TYPE[sniffed] ?? 'bin';
  const objectKey = `uploads/${auth.requestId}/${crypto.randomUUID()}.${ext}`;
  const displayName = clampStr(file.name, 120).replace(/[^\w.\- ]/g, '_') || `photo.${ext}`;

  await env.UPLOADS.put(objectKey, buffer, { httpMetadata: { contentType: sniffed } });

  const id = newId('upl');
  await env.DB
    .prepare(
      `INSERT INTO request_uploads (id, request_id, object_key, original_name, content_type, size_bytes, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, auth.requestId, objectKey, displayName, sniffed, buffer.byteLength, kind, nowIso())
    .run();

  return json({ ok: true, id, name: displayName, kind });
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const auth = await requirePortal(request, env);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get('id') ?? '';
  const row = await env.DB
    .prepare(`SELECT object_key, content_type, original_name FROM request_uploads WHERE id = ? AND request_id = ? AND deleted_at IS NULL`)
    .bind(id, auth.requestId)
    .first<{ object_key: string; content_type: string; original_name: string }>();
  if (!row) return errorJson('not_found', 'Image not found.', 404);

  const object = await env.UPLOADS.get(row.object_key);
  if (!object) return errorJson('not_found', 'Image not found.', 404);

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
