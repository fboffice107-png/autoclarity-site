// /api/admin/config — GET current effective config; PUT a partial override.
// Values persist in the `configuration` table; unknown keys are ignored.

import type { Env } from '../../lib/types.ts';
import { requireAdmin, auditLog } from '../../lib/auth.ts';
import { ConfigValidationError, getConfig, patchTouchesPublicFacts, setConfig } from '../../lib/config.ts';
import { errorJson, json, originAllowed } from '../../lib/util.ts';
import { readJsonBody, requestBodyErrorResponse } from '../../lib/request-body.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  return json({ config: await getConfig(context.env.DB) });
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  if (!originAllowed(context.request, context.env.PUBLIC_BASE_URL, true)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  const auth = await requireAdmin(context.request, context.env);
  if (!auth.ok) return auth.response;
  let patch: unknown;
  try {
    patch = await readJsonBody<unknown>(context.request);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }
  if (context.env.PPI_ENV === 'production' && patchTouchesPublicFacts(patch)) {
    return errorJson(
      'coordinated_public_facts_release_required',
      'Production pricing, fees, travel rules, and public support identity must be changed in source and regenerated public facts in one reviewed deployment.',
      409,
    );
  }
  let updated;
  try {
    updated = await setConfig(context.env.DB, patch, auth.actor);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return errorJson(error.code, error.message, 422);
    }
    throw error;
  }
  await auditLog(context.env.DB, auth.actor, 'update_config', 'configuration', 'ppi', patch);
  return json({ ok: true, config: updated });
};
