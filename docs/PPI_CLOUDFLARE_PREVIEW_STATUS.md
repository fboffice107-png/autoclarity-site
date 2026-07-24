# Cloudflare Preview — Current State & Remaining Steps

_Generated during the hosted-preview build. The customer domain
getautoclarity.com is UNCHANGED (still GitHub Pages). Nothing below touches DNS._

## What is live now

- **Cloudflare account:** fboffice107@gmail.com (`4da1d0fcf199fe1e467359d304bd02fb`)
- **Pages project:** `autoclarity-site`
- **Hosted preview URL:** https://autoclarity-site.pages.dev (noindex; not the customer domain)
- **D1 database:** `autoclarity_ppi` (`0ae44d57-1a4c-4fd9-96e9-629b1570af26`), migrations applied, patched into `wrangler.toml`.
- **Secrets set (Pages "production" environment):** `ADMIN_DEV_KEY`, `TURNSTILE_SECRET_KEY` (test always-pass), `PUBLIC_BASE_URL=https://autoclarity-site.pages.dev`.
- **App env:** `PPI_ENV=preview` (so admin uses the dev key + pages are noindex), `PAYMENTS_ENABLED=false`, `STRIPE_ENV=test`, `UPLOADS_ENABLED=false`.

> Note: the Cloudflare Pages **"production" environment** here just means the
> deployment served at `autoclarity-site.pages.dev`. It is NOT the customer
> domain and is NOT indexable. The CLI can only set secrets for that
> environment (no `--preview` flag in this wrangler), which is why the hosted
> test runs there. The app still behaves as a preview because `PPI_ENV=preview`.

## Verified on the hosted preview

- D1-backed API responds (`/api/ppi/runtime-config`) with safe defaults (payments off, scan off, no reviews, launch off).
- Real **301 redirects** (`/ppi`, `/pre-purchase-inspection` → canonical) — better than GitHub Pages' meta-refresh stubs.
- Full flow: public intake → portal (magic link uses the pages.dev base) → admin reissue link → **slot hold** → **9 agreements accepted** → `awaiting_payment` → honest **payments-disabled** gate.
- Admin API: 401 without the key, 200 with `ADMIN_DEV_KEY`; fixtures seed.
- Security: `.dev.vars`, `wrangler.toml`, `functions/*`, `migrations/*`, `docs/*`, `_config.yml`, `package.json` all **404**; Stripe webhook **rejects unsigned** (400); every page `noindex`.

## Stripe sandbox test — verified on the hosted preview (2026-07-23)

Ran against `https://autoclarity-site.pages.dev` with the owner's Stripe
**sandbox/test** keys, `STRIPE_ENV=test`, real-money payments never enabled.

1. ✅ Real Stripe Checkout session created (`checkout.stripe.com`, `cs_test_…`).
2. ✅ Completed checkout with test card `4242 4242 4242 4242` (Sandbox badge shown, $199.00, correct ref/email).
3. ✅ Signed webhook received and verified (`STRIPE_WEBHOOK_SECRET`).
4. ✅ Appointment → **Confirmed only after the webhook** — history shows `awaiting_payment → confirmed | system:stripe-webhook`; the browser success page did **not** confirm it. Payment `succeeded`, `pi_3TwAZh2MY…`.
5. ◻ Duplicate-webhook idempotency: proven by the integration suite's replay-guard test (same `event_id` twice → `{received:true, replay:true}`, one payment row, one confirm) and by the observed single-confirm/single-payment on the live run. A live duplicate requires Stripe's dashboard **Resend** (owner) — optional.
6. ✅ Two customers cannot hold the same slot time — second got `slot_taken` (DB partial-unique index).
7. ✅ Cancellation + slot release — `customer_cancelled`, slot `released`, freed time re-bookable.
8. ✅ Refund workflow — admin refund → `charge.refunded` webhook → `refunded` (async, not the admin action directly).

Afterwards: diagnostics reverted, `PAYMENTS_ENABLED=false` restored, redeployed clean. The `stripeKey` guard was improved to accept Stripe test/sandbox/restricted secret keys while still refusing live keys in test mode.

> Note on env vars: `wrangler pages secret put` and `--branch main` target the
> Cloudflare **Production** environment (served at `autoclarity-site.pages.dev`,
> still not the customer domain). The CLI has no preview-env flag; set
> preview-env values in the dashboard if you use branch-alias previews.

## 2026-07-23 (third pass — neon grid + cutover prep) — hosted preview state

- Deployed the neon energized-grid build + canonicalization middleware
  (commit `b6656ba` at deploy time). Verified hosted: asset hashes match
  local, neon grid live (screenshots in `docs/neon-grid-2026-07-23/`),
  noindex intact, 301s intact, blocked paths 404, admin 401 without key,
  fresh cross-origin intake stored (`PPI-260724-35MR`, duplicate-safe,
  in admin). `www.getautoclarity.com` requests hitting the app now 301 to
  the apex with path+query preserved (Host-header verified locally; full
  proof possible only after the domain attach).
- **Custom domain still NOT attached** — stopped at the Cloudflare Access
  gate (secrets absent; CLI has no Zero Trust scope). Owner runbook:
  `docs/domain-cutover-2026-07-23/CUTOVER_RUNBOOK.md`.

## 2026-07-23 (pre-launch infrastructure pass) — what changed on the hosted preview

- **Cross-origin form support deployed and verified**: `/api/ppi/*` +
  `/api/portal/upload` answer CORS preflights for `https://getautoclarity.com`
  and `https://www.getautoclarity.com` only (`PUBLIC_FORM_ORIGINS` in
  `wrangler.toml`; `functions/lib/cors.ts`). Verified live with curl: preflight
  204 + correct headers from the allowed origin, 403 from a foreign origin, a
  full cross-origin submission stored in D1 (`PPI-260724-TXVX`) and visible in
  admin, and **no CORS headers ever on admin/inspector APIs** (OPTIONS → 405).
- **`ADMIN_NOTIFY_EMAIL` secret set** (owner email) — owner notices now record
  on the hosted preview (status `recorded` until the Resend key exists).
- The full inspector publish cycle was re-verified against the hosted preview
  (start → 104 items → autosave/conflict → publish gates → portal + PDF →
  immutability 423 → amendment v2), see the session handoff.
- Fixture data was re-seeded; test requests from this session remain in the
  preview D1 (harmless; re-seeding cleans fixtures).

## Remaining owner actions

### 1. Enable R2 (for customer photo uploads) — dashboard, ~1 min
Cloudflare Dashboard → **R2** → Enable (accept terms; may require a card even for the free tier). Then:
```
npx wrangler r2 bucket create autoclarity-ppi-uploads
```
Un-comment the `[[r2_buckets]]` block in `wrangler.toml`, set `UPLOADS_ENABLED=true`, and redeploy. Everything except photo uploads works without this.

### 2. Complete the real Stripe TEST checkout on the preview — needs your test keys
The whole flow is verified through the payment gate, and the full Stripe path
(session creation → signature-verified, replay-guarded webhook → booking
confirmation → refund) is proven by the 34 integration tests against a faithful
mock. To exercise a **real** Stripe test Checkout on the hosted preview:

1. Stripe dashboard (**Test mode**) → Developers → API keys → copy the **Secret key** (`sk_test_...`). Set it yourself so it never transits chat:
   ```
   npx wrangler pages secret put STRIPE_SECRET_KEY --project-name autoclarity-site
   ```
2. Developers → Webhooks → Add endpoint `https://autoclarity-site.pages.dev/api/stripe/webhook`, events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`. Copy the signing secret:
   ```
   npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name autoclarity-site
   ```
3. Tell me, and I'll flip `PAYMENTS_ENABLED=true` (test), redeploy, and run one full test-card checkout (`4242 4242 4242 4242`) end-to-end incl. webhook confirmation. Live keys are refused by code — this stays test-only.

### 3. Protect the admin route with Cloudflare Access — dashboard, before the custom-domain cutover
Access apps are created in the Zero Trust dashboard (not via this CLI token):

1. Cloudflare **Zero Trust** → Access → Applications → **Add → Self-hosted**.
2. **Preview lock (recommended):** application domain `autoclarity-site.pages.dev`, path `/*`; policy: **Allow** → Emails → your email. Makes the whole hosted preview owner-only.
3. **Admin lock (required before production):** a self-hosted app covering `getautoclarity.com/ppi/admin*` **and** `getautoclarity.com/api/admin*`; policy Allow → your email.
4. Copy the admin app's **AUD tag** + your team domain into Pages env vars `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` (production). The API then verifies the Access JWT on every admin call; with `PPI_ENV=production` the dev key is refused and admin fails closed without Access.

## Custom-domain migration (GitHub Pages → Cloudflare Pages) — the final cutover, owner-gated

**Do not do this until the preview is fully signed off and you're ready.** DNS is
not touched before then; GitHub Pages remains the live site and the rollback.

1. Merge is already done (main has the code). Ensure the Pages **production** deploy is from `main`:
   ```
   npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
   ```
2. Set **production** env for the real domain: `PPI_ENV=production`, `PUBLIC_BASE_URL=https://getautoclarity.com`, keep `PAYMENTS_ENABLED=false` until §2/§ live-Stripe are done, and ensure Cloudflare Access (§3) is active. Restore the R2 binding (§1).
3. Verify everything on `autoclarity-site.pages.dev` one more time with production env.
4. Cloudflare Pages → the project → **Custom domains** → add `getautoclarity.com` (and `www`). Because DNS for the zone is already on Cloudflare, this updates the records to point at Pages — **this is the actual cutover**. SSL is issued automatically.
5. Smoke-test on getautoclarity.com: homepage, privacy, terms, App Store links, `/las-vegas-pre-purchase-inspection`, `/ppi` + `/pre-purchase-inspection` redirects, one intake, admin behind Access.

### Rollback (either direction)
- **Before cutover:** nothing to undo — getautoclarity.com is still GitHub Pages.
- **After cutover, to revert to GitHub Pages:** in the Cloudflare Pages project remove the `getautoclarity.com` custom domain (or point the DNS records back to the GitHub Pages IPs `185.199.108–111.153` and `www` CNAME → `fboffice107-png.github.io`). The GitHub Pages deployment (tag `pre-ppi-production` = commit `15a121c`, plus current `main`) is untouched and serves immediately.
