# PPI Portal — Architecture

## The one-paragraph version

getautoclarity.com is served by an existing **Cloudflare Pages** direct-upload
project from the `fboffice107-png/autoclarity-site` repository. Pages serves the
static HTML/CSS/JavaScript and Pages Functions (`/functions`) together. The PPI
system uses **D1** (SQLite) for durable request data, **R2** for private uploads,
**Turnstile** for bot protection, **Resend** for transactional email, **Stripe
Checkout** for the owner-gated payment path, and **Cloudflare Access** for the
admin. No frontend framework was introduced.

## Why this shape

- **Least disruption:** the existing site is plain HTML/CSS/JS; the PPI pages
  are too. Same design tokens (`assets/css/site.css`), same nav/footer.
- **One deployment story:** Cloudflare Pages serves *both* the static site and
  API. Direct uploads produce immutable deployments; production promotion and
  rollback are described in `PPI_DEPLOYMENT.md`.
- **No heavy dependencies:** the Worker runtime code has zero npm runtime
  dependencies. Stripe is called through its REST API with WebCrypto signature
  verification; Turnstile and NHTSA vPIC are plain fetches.

## Map

| Path | What it is |
|---|---|
| `las-vegas-pre-purchase-inspection/` | Public landing page + multi-step intake form |
| `ppi/portal/` | Magic-link customer portal (no passwords) |
| `ppi/admin/` | Owner dashboard (Cloudflare Access / preview dev key) |
| `pre-purchase-inspection/`, `ppi/index.html` | Redirect stubs (static hosting); real 301s in `_redirects` |
| `functions/lib/` | Shared TypeScript modules (not served as assets) |
| `functions/api/ppi/*` | Public API: submit, VIN decode, waitlist, analytics |
| `functions/api/portal/*` | Customer API (magic-token auth) |
| `functions/api/admin/*` | Admin API (Access JWT / dev key, fail-closed) |
| `functions/api/stripe/webhook.ts` | Payment source of truth |
| `migrations/` | D1 schema |
| `scripts/` | Setup/verification helpers |
| `tests/` | Vitest unit + integration suites |

## Key modules (functions/lib)

- `config.ts` — every price, travel band, slot template, expiry and policy
  number in one place; admin overrides stored in the `configuration` table and
  deep-merged over code defaults.
- `status.ts` — the request state machine (19 states). All changes go through
  `applyStatus`, which enforces the transition table with an optimistic
  `WHERE status = expected` guard and writes `status_history`.
- `pricing.ts` — tier suggestion (complexity-based, never price-based), travel
  banding from ZIP centroids (`zips.ts`, no external geocoder), quote totals,
  cancellation policy calculator.
- `magic.ts` — 256-bit tokens, SHA-256 hashes only at rest, TTL, rotation.
- `stripe.ts` — Checkout Session creation, refunds, HMAC webhook verification,
  `stripe_events` replay guard. `stripeKey()` refuses live keys outside
  production live mode.
- `auth.ts` — Cloudflare Access JWT verification (JWKS cached, RS256, aud/iss/
  exp checked); preview-only `ADMIN_DEV_KEY`; production fails closed (503).
- `agreements.ts` — versioned owner-review legal drafts seeded idempotently;
  acceptances record doc hash, typed name, IP, UA, timestamps.

## The money path (the part that must never lie)

1. Admin sends a versioned quote → customer picks an offered slot.
2. Slot hold is atomic. The original exact-start partial index is supplemented
   by database triggers that reject any overlap between offered, held, or
   confirmed windows after travel and report buffers are applied.
3. Agreements accepted (per-document rows, doc hash + typed name).
4. `checkout` re-validates everything (quote unexpired, hold alive, agreements
   complete, payments enabled), creates a durable D1 attempt claim, then calls
   Stripe with a stable idempotency key. A recoverable retry resumes that claim;
   cancellation fails closed while provider state is unresolved. The hold is
   extended to cover Stripe's 30-minute Session window.
5. **Only the signature-verified, replay-guarded webhook confirms anything**:
   payment → slot confirmed → siblings released → booking confirmed → emails.
   The browser success page just polls the portal until the webhook lands.
6. Edge case handled: payment succeeds after the hold lapsed and the time was
   taken — payment stands, request returns to time-selection, owner is alerted.

## Scheduled work

There is no cron in v1 by design. Holds and quote expiries are enforced
**lazily** (checked on every read/mutation that cares). No appointment-reminder
job or admin reminder action is shipped. A dedicated Cron Worker would be a
separately reviewed future enhancement and is not required for correctness.

## What would change at scale

D1 rate-limit table → Durable Objects or the Rate Limiting API; JSON config
textarea → form UI; reminder cron Worker; report PDF generation. None of these
block a single-operator launch.
