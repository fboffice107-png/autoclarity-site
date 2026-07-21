# PPI Portal — Deployment

## Environments

| | Hosting | Data | Payments | Admin auth |
|---|---|---|---|---|
| **Production today** | GitHub Pages (static only) | — | — | — |
| **Preview** | Cloudflare Pages branch deploy (`*.pages.dev`) | preview D1/R2 | Stripe TEST, `PAYMENTS_ENABLED=false` by default | `ADMIN_DEV_KEY` (or Access) |
| **Production later** | Cloudflare Pages + custom domain | production D1/R2 | Stripe LIVE (owner-gated) | Cloudflare Access only |

## Mode switches (env vars)

`PPI_ENV` (preview|production), `PPI_MODE` (waitlist|request|live),
`PAYMENTS_ENABLED`, `STRIPE_ENV` (test|live), `BOOKING_ENABLED`,
`UPLOADS_ENABLED`, `PUBLIC_BASE_URL`, `TURNSTILE_SITE_KEY`, `SUPPORT_EMAIL`.
Preview defaults (in `wrangler.toml`): request mode, payments off, test Stripe,
booking and uploads on.

## Local development

```bash
npm install
npm run db:migrate:local     # applies migrations to the local D1 (SQLite)
npm run dev                  # wrangler pages dev → http://127.0.0.1:8788
```
Optional `.dev.vars` (gitignored) for local secrets; without it, Turnstile
uses always-pass test keys (non-production only) and emails are recorded in
the `messages` table instead of sent. Seed fixtures: open
`http://127.0.0.1:8788/ppi/admin/`, unlock with your local `ADMIN_DEV_KEY`
from `.dev.vars` (or any value if unset — preview auth requires the var, so DO
set one), Overview → "Seed preview fixtures".

## Preview deployment

See PPI_CLOUDFLARE_SETUP.md (one-time). Redeploys afterwards:

```bash
npx wrangler pages deploy . --project-name autoclarity-site --branch feature/las-vegas-ppi-portal
npm run db:migrate:preview   # when migrations changed
```

## Production cutover (LATER — requires explicit owner approval)

Production means moving the domain from GitHub Pages to Cloudflare Pages so the
API works on getautoclarity.com. Gate: `docs/PPI_PRODUCTION_CHECKLIST.md` fully
checked and the owner has explicitly stated `APPROVE PRODUCTION DEPLOYMENT`.

1. Merge the PR to `main` (after preview sign-off).
2. Create **production** D1/R2 (separate from preview), apply migrations,
   configure production secrets (live Stripe only per PPI_STRIPE_SETUP.md),
   set production vars: `PPI_ENV=production`, `PUBLIC_BASE_URL=https://getautoclarity.com`.
3. Ensure Cloudflare Access protects `/ppi/admin*` + `/api/admin*` (fail-closed
   otherwise, but don't rely on the 503).
4. Deploy `main` to Pages production; verify on `autoclarity-site.pages.dev`.
5. Pages → Custom domains → add `getautoclarity.com` + `www` → Cloudflare
   updates the DNS records (this is the actual cutover; GitHub Pages stops
   receiving traffic). CNAME file stays harmlessly in the repo.
6. Smoke tests: homepage, privacy, terms, App Store links, `/las-vegas-pre-purchase-inspection`,
   both redirects, one full test request, admin lock.
7. Rollback: point the DNS records back at GitHub Pages
   (`fboffice107-png.github.io`) — the static site is byte-identical there.

## Optional enhancement (documented, not built)

Automated appointment-reminder emails need a scheduled trigger, which Pages
alone doesn't provide. Add a tiny Worker with a cron trigger
(`wrangler.toml`: `[triggers] crons = ["0 15 * * *"]`) bound to the same D1,
selecting confirmed bookings 24h out and calling the same email templates.
Reminders are currently a one-click admin action instead.
