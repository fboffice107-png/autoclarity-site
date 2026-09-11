# Report fulfillment release — approval required

Base: `ecc0e5a2a19663462ed05114fd217e62a787354b`. Production source baseline: `ce931b0724b05f7483566c7e95602934ca32a5db`. Release fingerprint: `ac-ai-20260911-r1`.

This release is prepared locally only. It does not authorize production deployment, migration, secret removal, provider transactions, or customer messages. The owner must explicitly approve production deployment.

## Scope and operation

The existing PPI Admin now contains the inspector workspace; `/inspector` and `/inspector/` redirect there under the existing Cloudflare Access policy. Unsupported legacy subpaths remain private 404s. Open a confirmed, captured booking, start the inspection, save findings progressively, attach authorized private photos, review the customer preview, mark review-ready, publish and prepare secure portal notification. The report-backed completion guard remains mandatory.

Use six explicit finding states. Buyer guidance and condition score are independently human-selected; no automatic purchase recommendation or inspection-count marketing claim is introduced. Internal notes never enter the customer snapshot. JPEG/PNG/WebP photos are limited to 8 MiB each and 60 per report; export HEIC first. A mistaken never-published attachment may be soft-removed from an editable draft, with its private object and audit retained. Published evidence cannot be removed.

Autosave uses a server sequence and atomic conditional writes. A stale tab cannot overwrite another edit. Recover unsaved text before navigating away on a conflict. Review is invalidated by subsequent edits/uploads. An amendment requires a reason and creates a distinct immutable version; the existing published version remains available while drafting. Historical 104-item reports with no normalized section rows remain editable without replacing their findings with the new blank template.

## Exact database sequence

1. `0009_request_attribution.sql` — bounded attribution; historical unknown default.
2. `0010_lead_classification.sql` — metadata only; historical `needs_owner_review` default.
3. `0011_report_fulfillment_integrity.sql` — report metadata, private photo manifests, durable portal-delivery references, immutable evidence/pointers, `report_notification_evidence` view, deletion/REPLACE guards, completion evidence guard.
4. `0012_agreement_acceptance_integrity.sql` — append-only quote-bound agreement acceptance, immutable accepted quote identity, version/acceptance REPLACE guards.

The first two migrations must be rehearsed separately on a fresh production export. The latter two are an additional rehearsal from that exact pair result. All original row/column hashes, commerce and lifecycle aggregates, indexes/triggers/views/FKs and journal entries are compared. No migration backfills classifications, payment events, agreement history, delivery history or report content. Only new metadata defaults are applied to legacy rows. Existing completed records are not retroactively rejected or rewritten.

## Payment boundary

Production remains `PPI_ENV=production`, `PPI_MODE=live`, `PAYMENTS_ENABLED=true`, `STRIPE_ENV=live`, with effective booking and payments enabled. No fulfillment-release switch is introduced.

Free intake → owner review and exact quote → owner-offered window → customer selection and time-limited hold → current quote-bound agreements → awaiting_payment → Stripe Checkout → verified webhook confirmation remains unchanged. Browser success navigation is not payment authority. New report code does not create Checkout sessions or PaymentIntents. Existing webhook/refund/dispute tests remain part of the complete suite.

## Security and notification boundaries

Admin APIs retain production Access JWT validation; the preview-only development key is ignored in production. Photo reads authenticate the request's customer, same-request version and immutable manifest, then verify stored size and SHA-256. Keys are opaque and never exposed through customer JSON. Private responses are no-store/noindex/nosniff; image responses are sandboxed. Photo traffic has its own bounded allowance and cannot consume ordinary portal-action limits. Invalid tokens remain rate-limited.

Publication creates immutable content and a durable portal delivery; the transactional Report Ready outbox contains only a secure portal link and orientation details. `recorded` means queued, not proven sent. Failed delivery remains visible for owner retry. Revoked/expired links use the existing safe successor mechanism, preserving original messages; post-idempotency-window retries require explicit owner confirmation. Completion recognizes valid current outbox/successor evidence without rewriting delivery history. There is no duplicate new-workflow Report Ready email on completion.

Application immutability protects normal APIs and database writes, including REPLACE and deletion. It is not administrative WORM storage: a privileged Cloudflare administrator can still change infrastructure. R2 public endpoints must remain disabled and no completed-evidence deletion lifecycle should be enabled. Hash verification detects changed/missing bytes and fails closed.

## Packaging and rollback

`scripts/stage-release.mjs EXACT_COMMIT NEW_ABSOLUTE_OUTPUT_DIR` requires a clean matching HEAD. It copies approved public assets and isolated Functions sources from git objects, verifies compiler versions against the lockfile, builds locally, emits a per-file checksum manifest, and keeps migrations/source/logs outside the public payload. It has no deployment or migration command. Never deploy this repository root, a backup directory, or a local test-state directory.

The approval packet outside this repository identifies the final commit/tree, exact public manifest, encrypted fresh backup/checksum/bookmark, observed production project/bindings and test results. If approval is delayed or production activity changes, refresh the protected export/bookmark and repeat the invariant rehearsal immediately before release.

After explicit approval only: verify the owner can open production admin pages and APIs through Access; preserve all live payment variables and bindings; apply the four exact pending migrations to the verified D1 database, checking its journal and invariants; then deploy only the staged public payload to the existing Pages project. No secret values should appear in output. Remove production ADMIN_DEV_KEY only after the owner Access checks pass; preview/local authentication remains separate.

Code rollback target is the existing production deployment `a7b0fcb6-37aa-49fb-b1d0-7013a1a8ccde`. An additive-schema code rollback normally leaves the new schema/evidence in place. Do not automatically reverse migrations or restore an old snapshot over new customer activity. If data restoration is required, first preserve the current database, pause only affected writes with explicit owner authority, assess/reconcile all post-bookmark activity, then use the verified encrypted backup/Time Travel point under a separate reviewed recovery action. Never delete report/photo/agreement evidence to make rollback easier.

## Human decisions

Production Access policy configuration and local JWT tests do not replace an authenticated owner page/API smoke check before ADMIN_DEV_KEY removal. Nevada/DMV classification/licensing, insurance coverage and counsel approval of exact agreement language remain owner/professional decisions. The release preserves the exact nine currently live agreement bodies, including scope/underbody version 2. Unapproved scope/underbody version 3 proposals remain solely in [the non-runtime counsel draft](AGREEMENT_PROPOSALS_NOT_ACTIVE.md); they are not automatically seeded or customer-required. Their future activation requires documented owner/counsel approval and a separately reviewed source-version change. Historical accepted versions remain intact.

The known real completed paid inspection is not zero revenue merely because a conservative attributable cohort cannot prove it. Its historical completion, captured payment, report versions and amounts remain authoritative. Missing deterministic conversion-event/cohort metadata must not be fabricated. Review classification through the owner-only lead-review interface with a reason; retain unknown attribution where unknown.
