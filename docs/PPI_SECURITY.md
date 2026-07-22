# PPI Portal — Security Notes

## Trust boundaries

| Surface | Auth | Notes |
|---|---|---|
| Public API (`/api/ppi/*`) | none | Turnstile (server-verified) + rate limits + validation |
| Customer API (`/api/portal/*`) | magic token | 256-bit token, SHA-256 hash at rest, TTL 14d, rotation on reissue, verification rate-limited |
| Admin API (`/api/admin/*`) + `/ppi/admin` | Cloudflare Access JWT | RS256 verified against team JWKS, aud/iss/exp checked. Preview fallback: `ADMIN_DEV_KEY` bearer (≥16 chars, constant-time compare). **Production without Access = 503 fail-closed.** |
| Stripe webhook | HMAC signature | `stripe-signature` v1 HMAC-SHA256, 300s tolerance, constant-time compare, replay guard via `stripe_events` PK |

## Controls implemented

- **Input validation** server-side for every field (`functions/lib/validate.ts`);
  client-side is UX only. Enums are allowlisted, lengths clamped, prices parsed
  defensively, URLs restricted to http(s).
- **SQL**: 100% prepared statements with bound parameters; no string-built SQL.
- **XSS**: portal/admin escape `& < > " '` on every server-derived string
  before it enters `innerHTML` (`esc()`), so values interpolated into HTML
  attributes cannot break out; agreement bodies rendered as escaped text. The
  strict `script-src 'self'` CSP (no `unsafe-inline`) is a second layer, not
  the only one. Listing URLs are additionally normalized through the URL
  parser server-side before storage.
- **Uploads**: private R2 bucket; MIME allowlist + magic-byte sniffing; 8 MB and
  6-file caps; randomized object keys; filenames sanitized to display-only;
  served back only through authenticated endpoints with
  `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `no-store`.
  Never public, never executed, never listed.
- **Rate limiting** (D1 fixed-window, daily-salted hashed identity — raw IPs
  are not stored in the limits table): submissions 5/h, VIN 30/h, token
  verification 60/h, messages 20/h, analytics 120/h.
- **CSRF/origin**: mutation endpoints reject cross-origin browser requests
  (Origin must match the deployment or `PUBLIC_BASE_URL`); customer auth is a
  bearer token, not cookies, so classic CSRF doesn't apply.
- **Headers**: CSP per path (`_headers` for static, middleware for API),
  `nosniff`, `DENY` framing, strict referrer policy, HSTS, restrictive
  Permissions-Policy (camera allowed only on the intake page for VIN scan).
- **Secrets**: only in Cloudflare secret bindings / `.dev.vars` (gitignored).
  `.env.example` contains placeholders exclusively. Frontend bundles contain
  only the public Turnstile site key. Logs redact: no VINs, addresses or
  customer names are logged; webhook/API errors log truncated technical detail.
- **Repo files are never served**: `functions/_middleware.ts` returns 404 for
  `.dev.vars`, `.env*`, `wrangler.toml`, `package.json`, `tsconfig.json`,
  `functions/`, `migrations/`, `tests/`, `scripts/`, `docs/`, `legal/`,
  `node_modules/`, etc. This runs before static-asset serving on both
  `wrangler pages dev` and hosted Pages, so it holds regardless of deploy
  method. `.assetsignore` additionally keeps them out of direct uploads.
  (Do not rely on `_redirects` denylists for this — they are ignored by the
  dev server.)
- **Privacy in analytics**: `analytics_events` schema physically has no PII
  columns; event names and step labels are allowlisted server-side.
- **Magic-link URLs**: tokens are secrets-in-URL by design (standard for
  passwordless email links). Mitigations: `Referrer-Policy: no-referrer` on
  portal pages, `noindex`, token rotation on every re-issue, expiry, and hashes
  (not tokens) at rest. The portal page warns the customer not to share it.
- **State machine**: all transitions validated (`status.ts`); concurrent
  transitions guarded by conditional UPDATE; every change lands in
  `status_history`. Double-booking is prevented by a partial unique index —
  not application logic alone.
- **Stripe key hygiene**: test env refuses `sk_live_`; live keys refused
  outside production live mode; metadata restricted to internal ids.
- **Fixtures**: seeding endpoint refuses `PPI_ENV=production`.

## Known limitations (accepted for v1, single-operator)

- D1 rate limiting is best-effort under extreme concurrency (window counter
  races add at most a few extra requests) — acceptable at this scale.
- Admin config editor accepts JSON; malformed values fall back to code
  defaults, and unknown keys are ignored, but there is no per-field schema
  validation UI yet.
- Magic-link tokens live in email; email account compromise = request access.
  This is inherent to passwordless email links.
- No WAF custom rules shipped; Cloudflare's default WAF applies once traffic
  moves to Cloudflare.

## Dependency posture

Runtime worker code: zero npm dependencies. Dev-only: wrangler, vitest,
typescript, @cloudflare/workers-types (`npm audit`: 0 vulnerabilities at build
time). Re-run `npm audit` before production.
