// Single-domain canonicalization helpers (imported by the global middleware;
// kept out of functions/_middleware.ts because the Pages functions compiler
// only tolerates route exports there).

// The one public customer domain. www and every non-canonical host must not
// serve (or get indexed with) duplicate content.
export const CANONICAL_HOST = 'getautoclarity.com';

// www → apex: standards-compliant permanent redirect preserving the full
// path and query string (incl. UTM parameters and portal tokens). Only ever
// matches the real www host, so localhost dev and *.pages.dev are untouched
// and a redirect loop is impossible (the apex host never matches).
export function canonicalHostRedirect(url: URL): Response | null {
  if (url.hostname !== `www.${CANONICAL_HOST}`) return null;
  const to = new URL(url.toString());
  to.protocol = 'https:';
  to.hostname = CANONICAL_HOST;
  to.port = '';
  return Response.redirect(to.toString(), 301);
}

// After the custom-domain cutover the same production deployment also stays
// reachable at autoclarity-site.pages.dev (and per-deployment aliases). Those
// hosts must never be indexed — only the canonical domain may be.
export function isNonCanonicalProductionHost(hostname: string): boolean {
  return hostname !== CANONICAL_HOST;
}
