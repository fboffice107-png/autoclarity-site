// Cross-origin support for the PUBLIC form APIs only.
//
// While getautoclarity.com is still served by GitHub Pages (static), the
// landing-page form submits to this Cloudflare deployment cross-origin. Only
// the origins in PUBLIC_FORM_ORIGINS (plus PUBLIC_BASE_URL) are allowed, and
// only the public surfaces get CORS headers — admin and inspector APIs never
// do. After the custom-domain cutover everything is same-origin again and
// these headers simply stop being emitted (no Origin mismatch → no header).

import type { Env } from './types.ts';

/** Extra origins allowed to use the public form APIs (beyond same-origin). */
export function formOrigins(env: Env): string[] {
  const out: string[] = [];
  for (const raw of String(env.PUBLIC_FORM_ORIGINS ?? '').split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      out.push(new URL(trimmed).origin);
    } catch {
      /* malformed entry — ignore */
    }
  }
  return out;
}

function allowedCorsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (origin === new URL(request.url).origin) return null; // same-origin: no CORS needed
  const allowed = new Set(formOrigins(env));
  if (env.PUBLIC_BASE_URL) {
    try {
      allowed.add(new URL(env.PUBLIC_BASE_URL).origin);
    } catch {
      /* ignore */
    }
  }
  return allowed.has(origin) ? origin : null;
}

/** Response headers letting an allowlisted origin read a public API response. */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = allowedCorsOrigin(request, env);
  if (!origin) return {};
  return { 'access-control-allow-origin': origin, vary: 'origin' };
}

/** Answer a CORS preflight for a public form endpoint. */
export function corsPreflight(request: Request, env: Env): Response {
  const origin = allowedCorsOrigin(request, env);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
      vary: 'origin',
    },
  });
}
