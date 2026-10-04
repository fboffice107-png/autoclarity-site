# Booking proposal delivery release — ac-delivery-20261003-r1

This is a staged release, not an authorization to deploy. The current manual,
owner-approved deployment workflow in PPI_DEPLOYMENT.md still applies. Do not
resend an existing customer proposal as a smoke test.

## Production prerequisites and rollout

- The read-only configuration inspection found RESEND_API_KEY, EMAIL_FROM and
  ADMIN_NOTIFY_EMAIL configured. Reuse them; no new email secrets or provider.
- SMS_ENABLED is false, contact.smsEnabled is false, and no queue binding exists.
  Keep them disabled. The application truthfully reports text as disabled.
- Live SMS requires a separately implemented provider/consumer, approved sender,
  consent/preference handling, queue deduplication using the stable job ID, and
  provider-result persistence/webhooks. See PPI_NOTIFICATIONS.md. Do not enable
  SMS merely to remove the dashboard's disabled label.
- In an owner-approved release window, apply ONLY
  migrations/0019_proposal_delivery.sql to the existing production D1 database,
  using the existing migration runner. Verify the table/index and ledger columns
  exist and prior row counts are unchanged. No reset, reseed or backfill.
- If migration fails, stop before deployment. Otherwise deploy the exact
  stage-release manifest's public directory using the existing Pages direct
  upload process. No production secrets, pricing or scheduling config changes.
- Read-only smoke: load intake/admin, open the existing sent request, inspect
  its original email snapshot, and confirm no new messages/payments/proposals.
  Earlier proposals have no invented channel history. Test all actual sends
  only against synthetic contacts and mocked providers outside production.
- If deployment fails, keep the additive table. Revert application code if
  needed; never destructively roll back customer data.

## Validation

The real-handler unit fixture uses local SQLite with every migration and a
mocked Resend endpoint; SMS tests use a mock queue. Integration tests start fresh
local D1/R2 and mock Stripe with RESEND_API_KEY empty. They cannot email a real
customer. Coverage includes independent channel failures/timeout, missing and
invalid contacts, disabled/unavailable SMS, consent/preferences, owner-only
retry, original-content copies, canonical URL reuse and refresh, double-clicks,
concurrent retries, explicitly confirmed resend, authorization/origin checks,
expired offers, DB claim/result failures and additive populated-schema checks.

Run npm test, npm run typecheck, node --check assets/js/ppi-admin.js,
git diff --check, and the link/header scripts against the local preview. There
is no lint script in package.json. The locked Wrangler Pages compiler and the
compiled worker syntax check are run by scripts/stage-release.mjs after a clean
commit. Deployment evidence and exact totals belong in the release report.
