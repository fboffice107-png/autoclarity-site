# Production preflight — 2026-09-07

This is a read-only release record. It contains no customer records, secret
values, signed download URL, Access token, or Time Travel bookmark. The
access-restricted evidence bundle is stored outside the repository.

## Release decision

**BLOCKED — no deployment and no remote migration performed.**

The production Pages project still contains an `ADMIN_DEV_KEY` secret. The
release policy requires that development bypass to be absent—not merely unused—
from production. The database also contains 10 explicitly fixture-labeled
requests and one integration-pattern request. Owner/legal/insurance, App Store
privacy-label, Google Business Profile, and fulfillment evidence gates also
remain open. The candidate's hard fulfillment gate keeps production Checkout
closed even under the observed live environment tuple. IndexNow was not
submitted because the candidate was not deployed.

## Current live application

- Pages project: `autoclarity-site`
- Environment/branch: production / `main`
- Deployment ID: `e7a9c599-8136-4a1a-9fd1-99d8ce7b5ee6`
- Created: `2026-09-03T22:06:57.058389Z`
- Status: successful
- Source revision: `ce931b0724b05f7483566c7e95602934ca32a5db`
- Public build header observed `2026-09-08T06:16:16Z`:
  `ac-prod-20260903-r3`
- `/ppi/admin/` remained protected by Cloudflare Access.

## Production configuration (values not reproduced)

- The exact live tuple passed: production environment, live PPI mode, payments
  enabled, live Stripe mode, and canonical apex public base URL.
- Required encrypted Stripe, webhook, Turnstile, email, and Access secret names
  were present. Encrypted values and Stripe-key prefixes cannot be retrieved by
  this audit and therefore were not represented as verified.
- D1 binding `DB` resolves to production database `autoclarity_ppi` with the
  independently observed production database ID.
- R2 binding `UPLOADS` resolves to `autoclarity-ppi-uploads`.
- Blocker: encrypted secret name `ADMIN_DEV_KEY` is present in production.
- There is no stored PPI configuration override row, so current runtime public
  pricing/travel/scan behavior derives from the deployed code defaults.

## D1 journal and non-personal baseline

The production migration journal contains `0001_init.sql` through
`0008_quote_payment_integrity.sql`. `0009_request_attribution.sql` has not been
applied.

Read-only aggregate snapshot:

| Measure | Value |
|---|---:|
| customers / vehicles / requests | 23 / 23 / 23 |
| request uploads / quotes / bookings | 1 / 8 / 5 |
| payments / messages / Stripe events | 4 / 36 / 3 |
| provider refunds / payment disputes | 0 / 0 |
| gross captured | $697.00 |
| legacy confirmed refunds | $398.00 |
| provider-ledger confirmed refunds | $0.00 |

The resulting overall post-refund amount is $299.00, but it is entirely within
the explicit fixture/integration-pattern cohort and is not defensible customer
revenue. That cohort has 11 requests, three bookings, three payments, $498.00
captured, and $199.00 refunded. It was left untouched for owner review.

After excluding only those obvious identifiers, the unlabeled 90-day cohort has
12 requests, four qualified requests, four sent-quote milestones, one checkout,
one captured payment/confirmed booking, no completed inspection, $199.00 gross,
and $199.00 refunded: $0.00 post-refund. The 30-day cohort has one request and no
later milestone; the 7-day cohort is zero throughout. App Store outbound events
are zero in all three windows. This exclusion is conservative but not an
identity audit: unlabeled rows were not opened, so they are not asserted to be
real customers. Production also has no source column until `0009` is applied.

## Backup and migration rehearsal

At `2026-09-08T06:02:11Z`, production D1 was exported before any schema change
to an access-restricted, non-repository directory. The export is 378,040 bytes
with SHA-256
`ab1cda43364de9d5db817a54e3af9e9993bb8cbb56dbb8e4588ffc4637f6e5fe`.
A current D1 Time Travel bookmark was captured in the private evidence bundle.

The export restored successfully into a disposable local SQLite database:

- integrity check: `ok`
- foreign-key violations: none
- all recorded row counts and money totals: exact match to the remote snapshot

`0009_request_attribution.sql` was then rehearsed on a copy of that restored
database. The rehearsal completed cleanly; integrity and foreign keys remained
clean; all counts and money totals were unchanged; all 23 existing requests
received the conservative `ppi_unknown` default; no source was null; and
`idx_requests_attribution_source` was present. This rehearsal did not change
production.

## Rollback record

- Application rollback target: the successful deployment ID and source revision
  recorded above. Use a Pages rollback/promotion in a reviewed release window;
  do not change DNS or delete production data.
- Database rollback evidence: the private pre-`0009` export plus its verified
  checksum and captured Time Travel bookmark. A restore is an emergency owner-
  approved operation; it was not exercised against production.
- Commerce containment: if a future verification fails, disable payments while
  allowing authentic late Stripe events to reconcile. Never delete or rewrite
  completed payment evidence.

## Candidate

Branch: `agent/ai-discovery-indexing-2026-09-07`. The exact final candidate
revision is recorded in the release handoff after review; this in-revision
record intentionally does not attempt to identify its own commit. Final test
counts are recorded in `docs/AI_DISCOVERY_AUDIT_2026-09-07.md`.
