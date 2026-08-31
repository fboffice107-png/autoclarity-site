# Production Operations Checklist — Las Vegas PPI

The request-mode PPI funnel is already live on Cloudflare Pages and production
payments remain disabled. Use this checklist for production releases and for
any later decision to enable Stripe. Technical readiness does NOT imply legal
or insurance readiness — those are real-world facts only the owner can confirm.

> **RELEASE BLOCKER:** the currently published privacy policy and terms are
> app-oriented and do not cover the PPI service; their professional-service
> framing also conflicts with the PPI offer. Do not deploy this release until
> the owner and counsel approve and publish the required PPI privacy and service
> terms. Engineering must not invent or publish substitute legal language.

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
- [ ] Live webhook endpoint configured with the eight events in
      `PPI_STRIPE_SETUP.md`, including `refund.updated` and `refund.failed`, a
      compatible webhook API version, and `STRIPE_WEBHOOK_SECRET` (live)
- [ ] `STRIPE_SECRET_KEY` (live) set in the **production** environment only
- [ ] One controlled live-payment test completed and refunded (owner-approved)

## Infrastructure

- [ ] Audited production Pages configuration obtained outside the repository;
      project, branch, variables, compatibility settings, D1/R2 binding names
      and resource IDs independently reviewed. Neither `wrangler.local.toml`
      nor `.wrangler/preview/wrangler.toml` is approved for production.
- [ ] Production D1 backup/export captured before schema work
- [ ] Production D1 migration history reviewed: if `0002` is absent, exact live
      report table columns/constraints/foreign keys/indexes/trigger and
      `messages.dedupe_key` match source, with no duplicate non-null dedupe keys.
      Any drift blocks migration; do not edit `d1_migrations` directly.
- [ ] After `0002` reconciliation, `0003_intake_idempotency.sql` applied and its
      request column, unique index, claim table, and expiry index verified before
      application deployment
- [ ] `0004_payment_slot_integrity.sql` applied only after `0003`; any buffered
      active-slot overlap reported by its preflight explicitly resolved before
      retry; stored PPI configuration JSON validated; both buffered columns,
      both overlap triggers, checkout-attempt unique index, both refund tables,
      and both refund lookup indexes verified
- [ ] Production D1 binding verified and migrations applied only through the
      independently reviewed production configuration
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
- [ ] Backup/rollback documented and understood (previous successful Cloudflare
      Pages deployment recorded; D1 export snapshot taken before schema work)

## Payment enablement order (after separate owner approval)

1. `PPI_MODE=request`, `PAYMENTS_ENABLED=false` — collect real requests, quote
   manually, no money movement.
2. Flip `PAYMENTS_ENABLED=true`, `STRIPE_ENV=live`, `PPI_MODE=live` only after
   the Payments section is fully checked.
