# PPI Portal — Security Notes

## Trust boundaries

| Surface | Auth | Notes |
|---|---|---|
| Public API (`/api/ppi/*`) | none | Turnstile (server-verified) + rate limits + validation |
| Customer API (`/api/portal/*`) | magic token | 256-bit token; credential table stores SHA-256 only; TTL 14d; rotation on reissue; verification rate-limited. Sent-email outbox bodies necessarily contain the bearer URL until the documented redaction pass. |
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
- **Uploads**: private R2 bucket; total multipart bodies are stream-counted and
  capped before parsing; MIME allowlist + magic-byte sniffing; 8 MB and
  6-file caps; randomized object keys; filenames sanitized to display-only;
  served back only through authenticated endpoints with
  `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `no-store`.
  Never public, never executed, never listed.
- **Rate limiting** (D1 fixed-window, daily-salted hashed identity — raw IPs
  are not stored in the limits table): submissions 5/h, VIN 30/h, token
  verification 60/h, messages 20/h, analytics 120/h.
- **CSRF/origin**: mutation endpoints reject cross-origin browser requests.
  Admin mutations require an Origin header matching the deployment or
  `PUBLIC_BASE_URL` before Access authentication/body parsing and accept JSON
  only. Customer mutations apply the same exact-origin comparison; customer
  auth is a bearer token rather than a cookie.
- **Request bodies**: actual stream bytes are counted before JSON, Stripe
  webhook or multipart parsing. Ordinary JSON is capped at 32 KiB, analytics
  at 8 KiB, VIN at 4 KiB, Stripe webhooks at 1 MiB, and multipart at the
  configured file maximum plus 1 MiB of bounded overhead.
- **Headers**: CSP per path (`_headers` for static, middleware for API),
  `nosniff`, `DENY` framing, strict referrer policy, HSTS, restrictive
  Permissions-Policy (camera allowed only on the intake page for VIN scan).
- **Secrets**: only in Cloudflare secret bindings / `.dev.vars` (gitignored).
  `.env.example` contains placeholders exclusively. Frontend bundles contain
  only the public Turnstile site key. Logs redact: no VINs, addresses or
  customer names are logged; webhook/API errors log truncated technical detail.
- **Repo files are never served**: `functions/_middleware.ts` returns 404 for
  `.dev.vars`, `.env*`, `wrangler.toml`, `wrangler.local.toml`, `package.json`, `tsconfig.json`,
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
  portal pages, immediate removal from the browser address/history after
  capture, `noindex`, token rotation on every re-issue, expiry, and hashes in
  the credential table. The exact sent email (including its bearer URL) is
  retained in the restricted D1 outbox for support/retry until redaction; the
  portal warns the customer not to share it.
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
- Restricted outbox rows contain still-live bearer URLs until expiry. The
  operator must redact linked message bodies no later than link expiry while
  retaining non-secret delivery/audit metadata; automation is future work.
- No custom WAF rules are tracked in this repository; Cloudflare edge controls
  are configured and reviewed separately from application releases.

## Dependency posture

Runtime worker code: zero npm dependencies. Dev-only: wrangler, vitest,
typescript, @cloudflare/workers-types (`npm audit`: 0 vulnerabilities at build
time). Re-run `npm audit` before production.
