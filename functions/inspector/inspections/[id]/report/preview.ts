// Serves the pre-publication preview at
// /inspector/inspections/:requestId/report/preview — renders the report
// exactly as the customer will see it, plus the readiness checklist and the
// confirmed publish action.

import type { Env } from '../../../../lib/types.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const shellUrl = new URL('/inspector/preview-shell.html', context.request.url);
  const res = await context.env.ASSETS.fetch(new Request(shellUrl.toString(), { headers: context.request.headers }));
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' },
  });
};
