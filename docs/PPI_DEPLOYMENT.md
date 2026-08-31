# PPI Portal — Deployment

## Environments

| | Hosting | Data | Payments | Admin auth |
|---|---|---|---|---|
| **Production today** | Cloudflare Pages direct upload + custom domains | production D1/R2 | Request mode; payments disabled | Cloudflare Access only |
| **Local** | `wrangler pages dev` | local D1/R2 emulation | Stripe TEST; payments disabled by default | `ADMIN_DEV_KEY` |
| **Hosted preview** | Cloudflare Pages branch deploy (`*.pages.dev`) | preview-only D1/R2 required before write testing | Stripe TEST; payments disabled by default | `ADMIN_DEV_KEY` or Access |

## Mode switches (env vars)

`PPI_ENV` (preview|production), `PPI_MODE` (waitlist|request|live),
`PAYMENTS_ENABLED`, `STRIPE_ENV` (test|live), `BOOKING_ENABLED`,
`UPLOADS_ENABLED`, `SMS_ENABLED`, `PUBLIC_BASE_URL`, `TURNSTILE_SITE_KEY`,
`SUPPORT_EMAIL`.
The local schema/binding template is `wrangler.local.toml`; `npm run dev`
passes its matching safe values explicitly because Pages dev does not accept a
custom config path. Request mode, payments off, test Stripe, booking and uploads
are the defaults. The nonstandard filename prevents these values from silently
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
the live acquisition funnel, so deploy only after the production checklist and
an owner-approved release window. Enabling payments remains a separate decision.

**Release blocker:** the currently published app-oriented privacy policy and
terms do not cover the PPI service and conflict with its professional-service
positioning. The owner and counsel must approve and publish PPI-specific privacy
and service terms before this release. This repository does not supply or
publish replacement legal text.

1. Clear the legal release blocker above and record owner approval for the
   release window.
2. Back up production D1 and record the current successful Pages deployment.
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
6. Export or reconstruct the actual production Pages configuration outside the
   repository and review every project name, binding name/ID, bucket, variable,
   route, branch, and compatibility setting. There is intentionally no tracked
   default `wrangler.toml`; never use `wrangler.local.toml` or the generated
   preview configuration for production.
7. Confirm production variables/secrets and Access protection; set
   `PUBLIC_BASE_URL=https://getautoclarity.com`, and keep
   `PPI_MODE=request`, `PAYMENTS_ENABLED=false`, and `STRIPE_ENV=test` unless the
   owner separately approves the live-payment checklist.
8. Deploy the reviewed build to the production branch using only that audited
   production configuration.
9. Smoke-test homepage, PPI page, redirects, runtime config, admin lock, and a
   controlled non-customer request flow. Do not use real customer data in tests.
10. Roll back by promoting/redeploying the previously recorded Pages deployment;
   do not change DNS or delete production data.

## Optional enhancement (documented, not built)

Automated appointment-reminder emails need a scheduled trigger, which Pages
alone doesn't provide. No reminder job or admin reminder action exists in this
release. A future implementation needs a separately configured Cron Worker,
deduplication, delivery monitoring, and its own review before deployment.
