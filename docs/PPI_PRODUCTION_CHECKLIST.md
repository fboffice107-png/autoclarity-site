# Production Operations Checklist — Las Vegas PPI

Use this checklist for a production release and for activating Stripe payments.
Production commerce must remain fail-closed until the environment, database,
webhook, quote, agreement, and notification checks below are complete.

## Business and customer policy

- [ ] Public pricing and the production configuration agree, including any
      intentionally active, time-bounded launch pricing or promotion; every
      applicable package remains presented as “Starting at”
- [ ] Travel bands are 0–15 miles included, 16–25 +$25, 26–40 +$50, and beyond
      40 miles custom review; custom-distance quotes contain an explicit amount
- [ ] Cancellation, rescheduling, vehicle-transfer, mobile-service, and refund
      wording matches the owner-approved operating policy
- [ ] Current PPI agreements and privacy disclosures are published as explicit
      versions and contain no draft, test-mode, or pre-launch warning copy
- [ ] Public business details approved (support email; NO private home address
      anywhere public)

## Payments

- [ ] Stripe account fully activated (identity, bank account)
- [ ] Live webhook endpoint configured with the thirteen events in
      `PPI_STRIPE_SETUP.md`, including all Refund lifecycle and Dispute
      lifecycle/funds events, a compatible webhook API version, and
      `STRIPE_WEBHOOK_SECRET` (live)
- [ ] `STRIPE_SECRET_KEY` (live) set in the **production** environment only
- [ ] Live Checkout initialization verified without completing a charge, using
      only a genuine approved quote. A charge/refund test requires separate,
      explicit authorization and is not a prerequisite for activation.

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
- [ ] `0005_provider_refund_ledger.sql` applied after `0004`; legacy refund
      balances, provider Refund rows, guards, and foreign keys verified without
      changing captured/refunded totals
- [ ] `0006_payment_disputes.sql` applied after `0005`; dispute identity guards,
      independent status/funds clocks, indexes, and foreign keys verified with
      existing payment and request state unchanged
- [ ] `0007_agreement_version_immutability.sql` applied after `0006`; existing
      agreement versions preserved, UPDATE/DELETE blocked, and new versions
      published only as explicit append-only source definitions
- [ ] `0008_quote_payment_integrity.sql` applied after `0007`; positive USD
      quote/payment amounts, exact quote component and line-item totals, and
      immutable sent-quote/payment identity verified before application rollout
- [ ] Production D1 binding verified and migrations applied only through the
      independently reviewed production configuration
- [ ] Production R2 bucket created, binding verified
- [ ] Turnstile production keys set (site + secret) and verified on the form
- [ ] Cloudflare Access protecting `/ppi/admin*` and `/api/admin*`
      (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` set; dev key absent in prod)
- [ ] Email domain authenticated (SPF/DKIM for the sending domain) and
      `RESEND_API_KEY`/`EMAIL_FROM`/`ADMIN_NOTIFY_EMAIL` set
- [ ] Production env vars form the complete live-payment tuple:
      `PPI_ENV=production`, `PPI_MODE=live`, `PAYMENTS_ENABLED=true`,
      `STRIPE_ENV=live`, `PUBLIC_BASE_URL=https://getautoclarity.com`; the Stripe
      secret begins with `sk_live_`
- [ ] NO fixture/test data in production DB

## Verification

- [ ] Full test booking completed end-to-end in preview
- [ ] Test refund completed in preview
- [ ] Production smoke flow proves: reviewed quote and times → customer-selected
      appointment → all current quote-bound agreements accepted → Stripe receives
      the exact server-approved total → webhook confirms payment and appointment
- [ ] Production smoke testing creates no fixture/customer record and completes
      no payment. The first genuine paid booking is monitored end-to-end; the
      full paid/refund lifecycle has already passed in isolated Stripe test mode.
- [ ] Existing site verified after cutover: homepage, App Store links,
      privacy, terms
- [ ] `/las-vegas-pre-purchase-inspection` + `/ppi` + `/pre-purchase-inspection`
      redirects verified on production
- [ ] Automated tests green (`npm test`), typecheck green (`npm run typecheck`)
- [ ] Monitoring active (Cloudflare Pages analytics + Stripe email alerts at
      minimum; optional: healthcheck on `/api/ppi/runtime-config`)
- [ ] Backup/rollback documented and understood (previous successful Cloudflare
      Pages deployment recorded; D1 export snapshot taken before schema work)

## Payment activation and rollback

1. Keep `PAYMENTS_ENABLED=false` while migrations, secrets, webhook events,
   agreements, and the production configuration are verified.
2. Activate only the complete production tuple listed above. Any partial or
   mixed test/live tuple must continue to expose payments as unavailable.
3. If verification fails, set `PAYMENTS_ENABLED=false`; continue reconciling
   authentic late Stripe events and do not alter completed payment evidence.
