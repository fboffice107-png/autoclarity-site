// POST /api/ppi/waitlist — launch-list signup (used in PPI_MODE=waitlist).

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { verifyTurnstile } from '../../lib/turnstile.ts';
import { rateLimit } from '../../lib/ratelimit.ts';
import { validEmail } from '../../lib/validate.ts';
import { clampStr, clientIp, errorJson, json, newId, nowIso, originAllowed } from '../../lib/util.ts';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const flags = modeFlags(env);

  if (!originAllowed(request, env.PUBLIC_BASE_URL)) {
    return errorJson('bad_origin', 'Cross-origin submissions are not accepted.', 403);
  }
  const ip = clientIp(request);
  const limited = await rateLimit(env.DB, ip, 'waitlist', 10, 3600);
  if (!limited.allowed) return errorJson('rate_limited', 'Too many attempts. Please try again later.', 429);

  let body: { email?: string; zip?: string; turnstileToken?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }

  const turnstile = await verifyTurnstile(
    env.TURNSTILE_SECRET_KEY,
    flags.env === 'production',
    String(body.turnstileToken ?? ''),
    ip,
  );
  if (!turnstile.ok) return errorJson('turnstile_failed', 'Human verification failed. Please retry.', 403);

  const email = clampStr(body.email, 254).toLowerCase();
  if (!validEmail(email)) return errorJson('validation', 'Please enter a valid email address.', 422);
  const zip = clampStr(body.zip, 10);

  await env.DB
    .prepare(`INSERT INTO waitlist (id, email, zip, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`)
    .bind(newId('wl'), email, zip || null, nowIso())
    .run();

  return json({ ok: true, message: 'You are on the Las Vegas launch list. We will email you when booking opens.' });
};
