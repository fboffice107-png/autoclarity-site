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
import { corsHeaders, corsPreflight } from './lib/cors.ts';

// Anything matching these is repo scaffolding, never website content. This
// middleware runs before static-asset serving on both `wrangler pages dev`
// and hosted Pages, so a 404 here holds regardless of how the site was
// uploaded (direct `wrangler pages deploy .` would otherwise ship .dev.vars).
const BLOCKED_EXACT = new Set([
  '/wrangler.toml',
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
const BLOCKED_PREFIXES = ['/functions/', '/migrations/', '/tests/', '/scripts/', '/docs/', '/legal/', '/.wrangler/', '/node_modules/'];

function isBlockedPath(pathname: string): boolean {
  if (BLOCKED_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/.dev.vars') || pathname.startsWith('/.env')) return true;
  return BLOCKED_PREFIXES.some((p) => pathname.startsWith(p));
}

// Public form surfaces that the static marketing site may call cross-origin
// (allowlisted origins only — see lib/cors.ts). Admin/inspector APIs are
// deliberately NOT here and never receive CORS headers.
function isPublicCorsPath(pathname: string): boolean {
  return pathname.startsWith('/api/ppi/') || pathname === '/api/portal/upload';
}

export const onRequest: PagesFunction<Env>[] = [
  async (context) => {
    const url = new URL(context.request.url);
    const isProduction = context.env.PPI_ENV === 'production';

    if (isBlockedPath(url.pathname)) {
      return new Response('Not found', { status: 404, headers: { 'x-robots-tag': 'noindex, nofollow', 'content-type': 'text/plain' } });
    }

    // CORS preflight for the public form endpoints (no route handler exports
    // onRequestOptions, so answer here before routing). Every other API path
    // refuses OPTIONS outright — admin/inspector surfaces must never pick up
    // permissive preflight headers from any lower layer (wrangler dev adds
    // `access-control-allow-origin: *` to unhandled OPTIONS).
    if (context.request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      if (isPublicCorsPath(url.pathname)) return corsPreflight(context.request, context.env);
      return new Response(null, { status: 405 });
    }

    // In production, the admin and inspector UIs are never served without
    // authorization (primary control: Cloudflare Access in front of
    // /ppi/admin*, /inspector* and /api/admin*, /api/inspector*).
    if (isProduction && (url.pathname.startsWith('/ppi/admin') || url.pathname.startsWith('/inspector'))) {
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
      if (isPublicCorsPath(url.pathname)) {
        for (const [k, v] of Object.entries(corsHeaders(context.request, context.env))) headers.set(k, v);
      }
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
