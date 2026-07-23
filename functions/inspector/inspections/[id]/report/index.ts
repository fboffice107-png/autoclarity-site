// Serves the report editor shell at the clean private URL
// /inspector/inspections/:requestId/report — the page JS reads the id from
// the path and talks to /api/inspector/*. Auth: Cloudflare Access in
// production (middleware-gated), dev key in preview.

import type { Env } from '../../../../lib/types.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const shellUrl = new URL('/inspector/editor-shell.html', context.request.url);
  const res = await context.env.ASSETS.fetch(new Request(shellUrl.toString(), { headers: context.request.headers }));
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' },
  });
};
