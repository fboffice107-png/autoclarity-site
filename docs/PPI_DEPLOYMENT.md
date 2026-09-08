# PPI Portal — Deployment

## Environments

| | Hosting | Data | Payments | Admin auth |
|---|---|---|---|---|
| **Production observed 2026-09-07** | Cloudflare Pages direct upload + custom domains | production D1/R2 | Live Stripe only with the complete production tuple | Cloudflare Access only |
| **Local** | `wrangler pages dev` | local D1/R2 emulation | Stripe TEST; payments disabled by default | `ADMIN_DEV_KEY` |
| **Hosted preview** | Cloudflare Pages branch deploy (`*.pages.dev`) | preview-only D1/R2 required before write testing | Stripe TEST; payments disabled by default | `ADMIN_DEV_KEY` or Access |

## Mode switches (env vars)

`PPI_ENV` (preview|production), `PPI_MODE` (waitlist|request|live),
`PAYMENTS_ENABLED`, `STRIPE_ENV` (test|live), `BOOKING_ENABLED`,
`UPLOADS_ENABLED`, `SMS_ENABLED`, `PUBLIC_BASE_URL`, `TURNSTILE_SITE_KEY`,
`SUPPORT_EMAIL`.
The local schema/binding template is `wrangler.local.toml`; `npm run dev`
passes its matching safe values explicitly because Pages dev does not accept a
custom config path. Unset production mode becomes waitlist, payments remain
off, and booking/uploads require explicit `true`. The nonstandard filename prevents these values from silently
becoming the production Pages deployment configuration.

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

## Hosted preview deployment

The production Pages project is direct-upload (not Git-connected). Never deploy
it with `wrangler.local.toml`. Create an isolated preview project, D1 database,
and R2 bucket with distinct names. The guarded setup script refuses the known
production names and requires an explicit confirmation:

```bash
AC_PREVIEW_PROJECT=autoclarity-site-preview \
AC_PREVIEW_DB=autoclarity-ppi-preview \
AC_PREVIEW_BUCKET=autoclarity-ppi-uploads-preview \
AC_PREVIEW_BRANCH=review \
AC_PREVIEW_PUBLIC_BASE_URL=https://review.autoclarity-site-preview.pages.dev \
CONFIRM_ISOLATED_PREVIEW=YES \
./scripts/cloudflare-setup.sh
```

The generated deployment configuration stays under `.wrangler/preview/` and
is gitignored. Validate names without creating files or contacting Cloudflare by
adding `--validate-only` to the command. Verify the resulting IDs and Access
policy before write testing.

## Production release (owner-gated)

The custom domains and production data bindings already exist. A release changes
the live acquisition funnel, so deploy only in an owner-approved release window
after completing `PPI_PRODUCTION_CHECKLIST.md`. Do not infer approval from a
runtime flag or silently change the current environment during an unrelated code
release.

**Release blocker:** the public privacy policy and terms observed 2026-09-07 do
contain app and PPI sections, but publication does not prove owner/counsel
approval or the licensing and insurance checks in the production checklist.
Record those approvals before release; engineering must not infer them.

1. Clear the business/legal approval blocker above and record owner approval for
   the release window, public pricing/policy copy, and any intentionally active,
   time-bounded launch price or promotion.
2. Record the current successful Pages deployment ID, exact creation time,
   source revision, and build ID. Export production D1 to a non-repository,
   access-restricted location; record UTC time, database identity, byte size,
   SHA-256, and the current Time Travel bookmark. Restore the export into a
   disposable local database and require a clean integrity check, no foreign-key
   violations, and exact agreement with the read-only production snapshot for
   table counts, request/payment counts, gross captured, and refund totals.
   Rehearse the next migration on a copy of that restored database and repeat
   the checks before any remote migration command.
3. Reconcile the recovered `0002` migration before code rollout. Using only an
   independently reviewed production configuration, confirm the intended D1
   database name and ID, inspect its migration history, and compare the live
   report table columns, foreign keys, indexes, immutable-version trigger, and
   `messages.dedupe_key` with source. Check for duplicate non-null dedupe keys.
   Idempotent `CREATE` statements prevent name collisions; they do **not** prove
   that an existing object has the expected definition. Stop on any drift. Only
   after an exact match and backup may an operator apply `0002` so Wrangler
   journals it. Never edit `d1_migrations` directly.
4. After `0002` is reconciled and journaled, apply
   `0003_intake_idempotency.sql` through that same independently reviewed
   production configuration. Verify the `ppi_requests.submission_key` column,
   its partial unique index, and the `intake_submission_claims` table/index
   before deploying application code. Stop on any migration error.
5. Apply `0004_payment_slot_integrity.sql` only after `0003`. Its preflight
   deliberately aborts when existing offered, held, or confirmed appointment
   windows overlap after the configured travel/report buffers are applied.
   Inspect and explicitly resolve any reported conflicts before retrying; do not
   bypass the guard. Verify both buffered slot columns, both overlap triggers,
   the checkout-attempt unique index, `refund_operations` and its payment index,
   and `refund_operation_attempts` and its operation index before deploying
   application code. Confirm the stored PPI configuration JSON is valid before
   applying the migration; invalid JSON must be repaired or explicitly reviewed
   so the documented default buffers are used.
6. Apply `0005_provider_refund_ledger.sql`, then
   `0006_payment_disputes.sql`, then
   `0007_agreement_version_immutability.sql`. Verify the refund and dispute
   ledgers, their guards/indexes, and the append-only agreement-version triggers
   after each migration before proceeding.
7. Apply `0008_quote_payment_integrity.sql` after `0007`. Verify database-bound
   positive USD quote/payment amounts, exact component and line-item totals, and
   immutable sent-quote/payment identity before application rollout.
8. Apply `0009_request_attribution.sql` only after `0008`. Verify the
   `ppi_requests.attribution_source` column has the `ppi_unknown` default and
   the source index exists before deploying code that writes the field.
9. Export or reconstruct the actual production Pages configuration outside the
   repository and review every project name, binding name/ID, bucket, variable,
   route, branch, and compatibility setting. There is intentionally no tracked
   default `wrangler.toml`; never use `wrangler.local.toml` or the generated
   preview configuration for production.
10. Confirm Access protection, remove the `ADMIN_DEV_KEY` secret entirely from
   production, and verify the future payment tuple without activating it:
   `PPI_ENV=production`, `PPI_MODE=live`, `PAYMENTS_ENABLED=false`,
   `STRIPE_ENV=live`, `PUBLIC_BASE_URL=https://getautoclarity.com`, and an
   `sk_live_` Stripe secret plus the matching `whsec_` webhook secret. Partial,
   missing, or mixed test/live combinations must remain fail-closed. Confirm the
   live endpoint and signing secret without creating a charge.
11. Deploy the reviewed build to the production branch using only that audited
   production configuration. `PPI_FULFILLMENT_RELEASED=false` keeps production
   Checkout closed even if an environment value is accidentally changed.
12. Smoke-test homepage, PPI page, redirects, runtime config, admin lock, public
   fact documents, webhook
   signature rejection, and failure handling without creating a production
   fixture/customer or completing a charge. Runtime config must report payments
   unavailable. The full paid confirmation/refund workflow must pass in isolated
   Stripe test mode.
13. Only after the authenticated report author/review/publish and private photo
   delivery workflow passes a real preview rehearsal may a separately reviewed
   code release set `PPI_FULFILLMENT_RELEASED=true` and activate
   `PAYMENTS_ENABLED=true`. Monitor the first genuine paid booking end-to-end.
14. If commerce verification fails, set `PAYMENTS_ENABLED=false` while authentic
   late Stripe events continue to reconcile. Roll back application code by
   promoting/redeploying the previously recorded Pages deployment; do not change
   DNS or delete production data.

## Optional enhancement (documented, not built)

Automated appointment-reminder emails need a scheduled trigger, which Pages
alone doesn't provide. No reminder job or admin reminder action exists in this
release. A future implementation needs a separately configured Cron Worker,
deduplication, delivery monitoring, and its own review before deployment.
