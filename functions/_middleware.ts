// Global middleware for every Pages Functions response.
// - Security headers on all dynamic responses (static files get theirs from _headers)
// - noindex everywhere except production
// - Production gate on the admin UI's static assets (defense-in-depth; the
//   primary control is Cloudflare Access in front of /ppi/admin and /api/admin)

import type { Env } from './lib/types.ts';
import { requireAdmin } from './lib/auth.ts';

export const onRequest: PagesFunction<Env>[] = [
  async (context) => {
    const url = new URL(context.request.url);
    const isProduction = context.env.PPI_ENV === 'production';

    // In production, the admin UI itself is never served without authorization.
    if (isProduction && url.pathname.startsWith('/ppi/admin')) {
      const auth = await requireAdmin(context.request, context.env);
      if (!auth.ok) return auth.response;
    }

    const response = await context.next();

    // Only decorate dynamic responses; leave static asset headers to _headers.
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers(response.headers);
      headers.set('x-content-type-options', 'nosniff');
      headers.set('referrer-policy', 'no-referrer');
      headers.set('cache-control', 'no-store');
      headers.set('x-robots-tag', 'noindex, nofollow');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (!isProduction) {
      const headers = new Headers(response.headers);
      headers.set('x-robots-tag', 'noindex, nofollow');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
];
