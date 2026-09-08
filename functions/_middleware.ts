// Global middleware for every Pages Functions response.
// - Never serve repository housekeeping files as static assets (fail-closed,
//   deploy-method independent; `_redirects` denylists are not honored by
//   `wrangler pages dev` and are an easy-to-miss allowlist to maintain)
// - Security headers on all dynamic responses (static files get theirs from _headers)
// - noindex everywhere except production
// - Production gate on the admin UI's static assets (defense-in-depth; the
//   primary control is Cloudflare Access in front of /ppi/admin and /api/admin)

import type { Env } from './lib/types.ts';
import { requireAdmin } from './lib/auth.ts';

const BUILD_ID = 'ac-ai-20260907-r2';

// Anything matching these is repo scaffolding, never website content. This
// middleware runs before static-asset serving on both `wrangler pages dev`
// and hosted Pages, so a 404 here holds regardless of how the site was
// uploaded (direct `wrangler pages deploy .` would otherwise ship .dev.vars).
const BLOCKED_EXACT = new Set([
  '/wrangler.toml',
  '/wrangler.local.toml',
  '/package.json',
  '/package-lock.json',
  '/tsconfig.json',
  '/vitest.config.ts',
  '/vitest.integration.config.ts',
  '/.env.example',
  '/.gitignore',
  '/_config.yml',
  '/.assetsignore',
]);
const BLOCKED_PREFIXES = [
  '/functions/',
  '/migrations/',
  '/tests/',
  '/scripts/',
  '/docs/',
  '/legal/',
  '/.git/',
  '/.github/',
  '/.claude/',
  '/.codex/',
  '/.wrangler/',
  '/node_modules/',
  '/coverage/',
];

function isBlockedPath(pathname: string): boolean {
  if (BLOCKED_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/.dev.vars') || pathname.startsWith('/.env')) return true;
  return BLOCKED_PREFIXES.some((p) => pathname.startsWith(p));
}

export const onRequest: PagesFunction<Env>[] = [
  async (context) => {
    const url = new URL(context.request.url);
    const isProduction = context.env.PPI_ENV === 'production';

    if (isBlockedPath(url.pathname)) {
      return new Response('Not found', { status: 404, headers: { 'x-robots-tag': 'noindex, nofollow', 'content-type': 'text/plain' } });
    }

    // Consolidate public page signals on the canonical apex host. Restrict the
    // redirect to safe navigation methods so API clients never have a request
    // body replayed across origins.
    if (
      isProduction &&
      url.hostname === 'www.getautoclarity.com' &&
      (context.request.method === 'GET' || context.request.method === 'HEAD')
    ) {
      url.protocol = 'https:';
      url.hostname = 'getautoclarity.com';
      url.port = '';
      return new Response(null, {
        status: 308,
        headers: {
          location: url.toString(),
          'cache-control': 'public, max-age=3600',
          'x-autoclarity-build': BUILD_ID,
        },
      });
    }

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
      headers.set('x-autoclarity-build', BUILD_ID);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (!isProduction) {
      const headers = new Headers(response.headers);
      headers.set('x-robots-tag', 'noindex, nofollow');
      headers.set('x-autoclarity-build', BUILD_ID);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
];
