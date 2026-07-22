// /api/admin/config — GET current effective config; PUT a partial override.
// Values persist in the `configuration` table; unknown keys are ignored.

import type { Env } from '../../lib/types.ts';
import { requireAdmin, auditLog } from '../../lib/auth.ts';
import { getConfig, setConfig } from '../../lib/config.ts';
import { errorJson, json } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  return json({ config: await getConfig(context.env.DB) });
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  let patch: unknown;
  try {
    patch = await context.request.json();
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }
  const updated = await setConfig(context.env.DB, patch, auth.actor);
  await auditLog(context.env.DB, auth.actor, 'update_config', 'configuration', 'ppi', patch);
  return json({ ok: true, config: updated });
};
