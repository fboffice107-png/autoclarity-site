# Production Operations Checklist — Las Vegas PPI

The PPI funnel observed 2026-09-07 is live on Cloudflare Pages with runtime
payment and booking flags enabled. That observation is not evidence of owner
approval. Use this checklist for production releases and any payment-setting
change. Technical readiness does NOT imply legal
or insurance readiness — those are real-world facts only the owner can confirm.

> **RELEASE BLOCKER:** the privacy policy and terms observed 2026-09-07 contain
> both app and PPI sections, but owner/counsel approval, licensing, and insurance
> are not evidenced in the repository. Record the approvals below before
> deployment. Engineering must not infer legal readiness from published text.

## Business and customer policy

- [ ] Nevada and applicable Clark County/city business licenses are current for
      the actual operating entity, service area, and mobile work performed
- [ ] Written Nevada-qualified counsel/DMV determination recorded on whether
      the offered visual PPI work triggers any NRS 487 garage/repair-dealer
      registration or other occupational requirement; every required approval
      is in hand before accepting another booking
- [ ] Insurer confirms in writing that the active policies cover the actual
      mobile inspection work, road tests, customer/seller vehicles, custody or
      control, and any lift/facility activity that will really be offered
- [ ] Nevada-qualified counsel approved the current PPI terms, privacy notice,
      quote-bound agreements, cancellation/refund policy, and operating flow
- [ ] Owner evidence register supports current founder experience/capacity,
      founder-performed service, response-time, independence, report-content,
      and service-area claims; unsupported claims are softened before release
- [ ] The shipped iOS binary/SDK data flow, website privacy statement, and App
      Store privacy answers have been reconciled in App Store Connect and
      approved by the owner; a public “Data Not Collected” label is not treated
      as proof without that audit
- [ ] Public pricing and the production configuration agree, including any
      intentionally active, time-bounded launch pricing or promotion; every
      applicable package remains presented as “Starting at”
- [ ] Travel bands are 0–15 miles included, 16–25 +$25, 26–40 +$50, and beyond
      40 miles custom review; custom-distance quotes contain an explicit amount
- [ ] Owner approves the non-private distance origin and documented distance
      method used for those bands; no home address or inferred private location
      is disclosed
- [ ] Cancellation, rescheduling, vehicle-transfer, mobile-service, and refund
      wording matches the owner-approved operating policy
- [ ] Current PPI agreements and privacy disclosures are published as explicit
      versions and contain no draft, test-mode, or pre-launch warning copy
- [ ] Public business details approved (support email; NO private home address
      anywhere public)
- [ ] Any customer review shown publicly has a traceable authentic source,
      explicit publication permission, faithful wording and attribution, and a
      separately reviewed code release; runtime configuration alone cannot
      enable reviews

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
- [ ] Production D1 backup/export captured before schema work in a non-repo,
      access-restricted location; UTC timestamp, byte size, SHA-256, current
      Time Travel bookmark, database identity, and operator are recorded
- [ ] Backup restored into a disposable local database; `integrity_check`,
      `foreign_key_check`, table counts, request/payment counts, gross captured,
      and refund totals reconcile to the pre-migration read-only snapshot
- [ ] Candidate migration rehearsed against a copy of that restored backup;
      post-migration integrity/foreign-key checks and all recorded counts/money
      invariants match, except for the explicitly reviewed additive schema/data
      defaults
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
- [ ] `0009_request_attribution.sql` applied after `0008`; source column,
      unknown default, exact source allowlist constraint, and source index
      verified before application deployment
- [ ] Production D1 binding verified and migrations applied only through the
      independently reviewed production configuration
- [ ] Production R2 bucket created, binding verified
- [ ] Turnstile production keys set (site + secret) and verified on the form
- [ ] Cloudflare Access protecting `/ppi/admin*` and `/api/admin*`
      (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` set; `ADMIN_DEV_KEY` secret is
      absent—not merely unused—from production)
- [ ] Email domain authenticated (SPF/DKIM for the sending domain) and
      `RESEND_API_KEY`/`EMAIL_FROM`/`ADMIN_NOTIFY_EMAIL` set
- [ ] Production env vars form the complete live-payment tuple:
      `PPI_ENV=production`, `PPI_MODE=live`, `PAYMENTS_ENABLED=true`,
      `STRIPE_ENV=live`, `PUBLIC_BASE_URL=https://getautoclarity.com`; the Stripe
      secret begins with `sk_live_` and the endpoint signing secret begins with
      `whsec_`. Missing/invalid mode values keep commerce fail-closed.
- [ ] Admin mutations reject missing, null, malformed, and cross-origin Origin
      headers before auth/body parsing; JSON/webhook/upload body limits pass
      preview adversarial tests
- [ ] A named operator owns the linked-email body redaction pass at least every
      24 hours with a day-13 cutoff and missed-run alert; the first run is
      scheduled and recorded
- [ ] NO fixture/test data in production DB

## Verification

- [ ] Full test booking completed end-to-end in preview
- [ ] Test refund completed in preview
- [ ] Completion is rejected unless an immutable, same-request published report
      exists; the authenticated portal exposes only that report, and the
      deduplicated report-ready notice is recorded exactly once
- [ ] Operator report authoring, review, publication, and private photo delivery
      exist and pass a real preview rehearsal; only then does a separately
      reviewed code release set `PPI_FULFILLMENT_RELEASED=true`
- [ ] Production smoke flow proves: reviewed quote and times → customer-selected
      appointment → all current quote-bound agreements accepted → Stripe receives
      the exact server-approved total → webhook confirms payment and appointment
- [ ] Production smoke testing creates no fixture/customer record and completes
      no payment. The first genuine paid booking is monitored end-to-end; the
      full paid/refund lifecycle has already passed in isolated Stripe test mode.
- [ ] Existing site verified after cutover: homepage, App Store links,
      privacy, terms, `/llms.txt`, and `/autoclarity-services.json`
- [ ] `/las-vegas-pre-purchase-inspection` + `/ppi` + `/pre-purchase-inspection`
      redirects verified on production
- [ ] Automated tests green (`npm test`), typecheck green (`npm run typecheck`)
- [ ] IndexNow key file and every submitted URL return 2xx; only then run the
      staged submission. Record the response; do not describe submission as indexing.
- [ ] Monitoring active (Cloudflare Pages analytics + Stripe email alerts at
      minimum; optional: healthcheck on `/api/ppi/runtime-config`)
- [ ] Backup/rollback documented and understood (previous successful Cloudflare
      Pages deployment recorded; D1 export snapshot taken before schema work)

## Payment activation and rollback

1. Keep `PAYMENTS_ENABLED=false` while migrations, secrets, webhook events,
   agreements, fulfillment, and the production configuration are verified.
2. Keep `PPI_FULFILLMENT_RELEASED=false` until authenticated report authoring,
   review/publication, private photo delivery, and a real preview rehearsal pass.
3. Activate only the complete production tuple in the same separately reviewed
   release that changes that hard gate. Any partial or mixed test/live tuple
   must continue to expose payments as unavailable.
4. If verification fails, set `PAYMENTS_ENABLED=false`; continue reconciling
   authentic late Stripe events and do not alter completed payment evidence.
