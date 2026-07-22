// GET /api/portal — the customer's secure view of their request.

import type { Env } from '../../lib/types.ts';
import { getConfig } from '../../lib/config.ts';
import { requirePortal, loadPortalView } from '../../lib/portal.ts';
import { errorJson, json } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requirePortal(context.request, context.env);
  if (!auth.ok) return auth.response;

  const config = await getConfig(context.env.DB);
  const view = await loadPortalView(context.env, config, auth.requestId);
  if (!view) return errorJson('not_found', 'This request no longer exists.', 404);
  return json(view);
};
