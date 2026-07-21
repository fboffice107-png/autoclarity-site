# Production Checklist — Las Vegas PPI

**Nothing goes live until every box is checked and the owner explicitly
states: `APPROVE PRODUCTION DEPLOYMENT`.** Technical readiness of the website
does NOT imply legal or insurance readiness — those are real-world facts only
the owner can confirm.

## Business & legal (owner + counsel)

- [ ] Nevada and local (Clark County / City of Las Vegas) business licensing
      confirmed for mobile vehicle inspection work
- [ ] Nevada garage-registration status confirmed (whether NRS 487 garage
      registration applies to inspection-only mobile work — ask counsel/DMV)
- [ ] Insurance active (general liability; garagekeepers/on-hook if road tests
      are performed; commercial auto as applicable)
- [ ] All customer documents in `functions/lib/agreements.ts` + privacy
      supplement reviewed by a Nevada-licensed attorney
- [ ] Cancellation/refund policy approved
- [ ] Privacy policy updated and published (see legal/PPI_PRIVACY_SUPPLEMENT.md)
- [ ] PPI service agreement published
- [ ] Public business details approved (support email; NO private home address
      anywhere public)

## Payments

- [ ] Stripe account fully activated (identity, bank account)
- [ ] Live webhook endpoint configured + `STRIPE_WEBHOOK_SECRET` (live) set
- [ ] `STRIPE_SECRET_KEY` (live) set in the **production** environment only
- [ ] One controlled live-payment test completed and refunded (owner-approved)

## Infrastructure

- [ ] Production D1 database created, migrations applied, binding verified
- [ ] Production R2 bucket created, binding verified
- [ ] Turnstile production keys set (site + secret) and verified on the form
- [ ] Cloudflare Access protecting `/ppi/admin*` and `/api/admin*`
      (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` set; dev key absent in prod)
- [ ] Email domain authenticated (SPF/DKIM for the sending domain) and
      `RESEND_API_KEY`/`EMAIL_FROM`/`ADMIN_NOTIFY_EMAIL` set
- [ ] Production env vars: `PPI_ENV=production`, `PUBLIC_BASE_URL=https://getautoclarity.com`,
      `PPI_MODE` per launch plan (`request` first; `live` only when §Payments done)
- [ ] NO fixture/test data in production DB

## Verification

- [ ] Full test booking completed end-to-end in preview
- [ ] Test refund completed in preview
- [ ] Existing site verified after cutover: homepage, App Store links,
      privacy, terms
- [ ] `/las-vegas-pre-purchase-inspection` + `/ppi` + `/pre-purchase-inspection`
      redirects verified on production
- [ ] Automated tests green (`npm test`), typecheck green (`npm run typecheck`)
- [ ] Monitoring active (Cloudflare Pages analytics + Stripe email alerts at
      minimum; optional: healthcheck on `/api/ppi/runtime-config`)
- [ ] Backup/rollback documented and understood (DNS back to GitHub Pages;
      D1 `wrangler d1 export` snapshot taken pre-launch)

## Launch order (after approval)

1. `PPI_MODE=request`, `PAYMENTS_ENABLED=false` — collect real requests, quote
   manually, no money movement.
2. Flip `PAYMENTS_ENABLED=true`, `STRIPE_ENV=live`, `PPI_MODE=live` only after
   the Payments section is fully checked.
