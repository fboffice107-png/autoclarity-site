# PPI Admin Guide (for the owner)

Open `/ppi/admin/`. In preview, unlock with the `ADMIN_DEV_KEY`; in production
you'll sign in through Cloudflare Access with your email instead.

## Daily flow

1. **Overview** shows new requests, waiting states, upcoming appointments,
   separate gross/refund/net/dispute totals, a verified 30-day service funnel,
   source cohorts, and interaction counters. ⚠ marks manual-review requests
   (exotic, classic, salvage, heavy mods, non-running); ⚡ marks same-day
   priority.
2. The **Requests** list answers "who acts next" on every card: customer,
   vehicle, location, package, current total, appointment and payment, with a
   plain-language stage — *Needs your review*, *Waiting for customer to choose
   a time*, *Time selected — awaiting payment*, *Paid — appointment confirmed*.
   Two labels are deliberately loud: **Proposal sent without times — customer
   cannot book** and **Paid — scheduling needs attention**.
3. Open a request → **At a glance** repeats the same facts, then everything the
   customer submitted, their uploads, travel estimate, the suggested package
   **with the reasons** (internal only) and the customer's own package choice.
4. If something's missing → Status → `needs_info` with a note (emails them a
   fresh portal link). Seller not confirmed → `seller_access_pending`.
5. **Review & send booking proposal** — the ordinary path, and one action.
   The package is prefilled (the customer's choice if they made one, otherwise
   the suggestion), the itemized total is calculated by the server, and Quick
   fill drops in the 9:00 / 12:30 / 4:00 Las Vegas templates. Press
   **Review & Send Booking Proposal — $TOTAL**.

   That single press writes one coherent proposal — quote, offered windows and
   the customer message, in one transaction — and sends **one** email with
   **one** link. A proposal with no usable times is refused outright and saves
   nothing, because a price with no times leaves the customer unable to book.

   Under **Advanced pricing**: base override, custom travel, add-ons, discount,
   offer expiry and an internal note that never reaches the customer. Typed
   work is kept if you navigate away before sending.

   After sending, the card keeps showing the saved price, the offered times,
   the timestamp and the honest delivery state — *saved*, *queued*, *sent* or
   *failed*. **Retry sending this proposal** reuses the same proposal and can
   never create a second one or a second email.

   Quotes stay versioned; a new proposal supersedes the old offer, releases its
   unclaimed windows, and any change after acceptance requires a new version by
   design. The older per-step tools (manual quote builder, manual time offers)
   are still there under the secondary panels.
6. The customer opens the one link and does everything on one page: choose a
   time → review the exact total → accept the agreements → pay. Payment
   confirms automatically via Stripe webhook: slot confirmed, other windows
   released, confirmation emails sent, status → Confirmed. You'll get an owner
   notification.
7. Day-of: move status to `inspection_in_progress` → `report_in_progress`.
   `completed` is rejected until this same request points to an immutable
   published report version. On successful completion, the secure portal shows
   that exact version and the system records one deduplicated “report ready”
   email. This repository has no authoring/publish UI; before deploying this
   guard, verify that the existing private inspector/report workflow produces a
   compatible immutable published version for the same request. Do not infer
   from the repository boundary that no real inspection has been completed.
8. Refunds: Payments section → Refund… (full or partial). The final state
   lands when Stripe's webhook confirms. Paid cancellations arrive as
   messages + email alerts and are never auto-forfeited — you decide within
   the policy.

## Configuration (Configuration tab)

All money values are **cents**. Common edits:

- Prices: `pricing.tiers.standard.priceCents` (19900 = $199), etc.
- Launch pricing: enable `pricing.launch`, set a real future `endsAt`, and set
  each tier's lower `launchPriceCents` as needed. The legacy Standard-only
  `pricing.promo` path also requires a real future `endsAt`; either active path
  is reflected on the public page and in the server-owned quote suggestion.
- Travel: `travel.bands` (`maxMiles`/`feeCents`). The origin is the AutoClarity
  service base (ZIP 89147 centroid, `travel.originLat/originLng`). It stays
  server-side — customers only ever see the derived mileage and band, never the
  coordinates — and it is a ZIP centroid rather than the exact street address.
- Schedule: `scheduling.slotTemplates`, `daysOfOperation` (0=Sun…6=Sat),
  `blackoutDates: ["2026-12-25"]`, `minLeadHours`, `holdMinutes`.
- Quote expiry: `quotes.expiryHours` (48 by default).

Every save is audit-logged. Unknown keys, wrong types, unsupported upload MIME
types, unsafe ranges, invalid dates/times, and inconsistent policy values are
rejected before persistence. Diagnostic-scan and public-review capabilities
also require separate code-reviewed releases. In production, pricing, fees,
travel rules, and public support identity must be changed in source and
regenerated together; a runtime-only edit is rejected to prevent visible copy,
JSON-LD, and the public catalog from drifting apart.

## Production data operations (owner-approved window only)

Do not let Wrangler infer a default configuration for production. Back up D1,
verify the approved database name and ID, and run any production SQL only with
the independently reviewed production configuration, for example:

```bash
npx --no-install wrangler d1 execute PRODUCTION_DB_BINDING --remote \
  --config /absolute/path/to/audited-production-config.toml --command "..."
```

The examples below are data-policy sketches, not unattended runbooks.

- Deletion request (after removing uploads in the UI):
  `UPDATE ppi_requests SET deleted_at = datetime('now') WHERE ref = 'PPI-...';`
  then redact the customer:
  `UPDATE customers SET full_name='deleted', email='deleted@example.invalid', phone='' WHERE id = '...';`
- Purge stale magic links:
  `DELETE FROM magic_links WHERE expires_at < datetime('now','-90 days');`
- Redact outbound bodies containing portal bearer URLs by day 13, before the
  linked credential's 14-day expiry, while retaining delivery metadata:
  `UPDATE messages SET body_text='[Outbound email body redacted before secure-link expiry.]' WHERE direction='outbound' AND channel='email' AND created_at < datetime('now','-13 days') AND body_text LIKE '%/ppi/portal/?t=%';`
  Run at least every 24 hours, record the row count, alert on a missed run, and
  review retention with counsel before changing the interval. Automate this
  before scale; until then, a named operator must own the daily pass.

## Analytics event definitions (no PII by design)

| Event | Fired when |
|---|---|
| `ppi_page_view` | Landing page loaded with the API reachable |
| `ppi_cta_click` | A "Request" CTA clicked (`step`: hero/final) |
| `app_store_outbound_click` | An App Store link was clicked; this does not prove install or purchase |
| `ppi_form_started` | First keystroke/interaction in the intake form |
| `ppi_form_step_completed` | A step passes validation (`step`: buyer/vehicle/location/access/timing) |
| `ppi_request_submitted` | Browser received a persisted request receipt; D1 request count is authoritative |
| `ppi_quote_sent` | Admin sent a quote (server-side) |
| `ppi_slot_selected` | Customer held a window |
| `ppi_agreement_accepted` | All documents accepted |
| `ppi_checkout_started` | Customer tapped the pay button |
| `ppi_payment_confirmed` / `ppi_booking_confirmed` | Webhook confirmed payment/booking (server-side) |
| `ppi_cancelled` | Customer cancel action |
| `ppi_completed` | Request marked completed |
| `ppi_waitlist_joined` | Waitlist signup (waitlist mode) |

Stored as counters in `analytics_events` (event, step, source, timestamp) —
the table has no columns for names, emails, VINs or addresses. Each request also
stores one client-derived, allowlisted first-touch category so payment and
completion can be grouped directionally by source. It is not independently
verified and must not be treated as payment-grade proof or the sole basis for
advertising spend. Raw URLs, campaign names, search terms, referrer paths, and
customer data are not attribution fields; invalid or missing sources become
`ppi_unknown` (“Unknown / unattributed”), while an observed direct visit is
stored and displayed separately as `ppi_direct` (“Direct”). The documented iOS
app handoff is reduced from the exact `utm_source=ios_app&utm_medium=owned` pair
to `ppi_ios_app` (“AutoClarity iOS app”); raw UTM values and the campaign name
are not retained.

The Overview exposes fixed 7-, 30-, and 90-day windows. Operational milestones
use their first server-recorded event time. Checkout starts require an actual
Stripe Session id; successful payment time comes from the deterministic webhook
event. A successful Refund enters a window by its latest succeeded provider
event, while a Dispute case enters by provider-created time. Payment-cohort
gross is the original captured amount, current refunds are shown separately,
and the post-refund/dispute collected amount subtracts refunds and
conservatively excludes the remaining balance of every payment still latched as
disputed. It is not profit: processor fees, tax, labor, travel, and overhead are
not deducted.
Missing webhook confirmation timestamps are surfaced as data-quality exceptions
rather than assigned a guessed time.

These windows describe exact events present in this system, not AutoClarity's
all-time operating history. A zero does not prove that no real paid or completed
PPI occurred, and `ready_for_review` is a lifecycle state rather than an
owner-verified genuine lead. Historical requests initially remain
`needs_owner_review`; use the protected Lead review page to verify identity and
set `genuine` without changing payment, refund, booking, completion, or status
history. If the lifecycle evidence lacks an exact completion event, leave that
measurement as not recorded instead of backfilling history in this release.

Source tables are request-created cohorts whose outcomes can mature after the
window closes. They show raw numerators; conversion percentages remain hidden
until a source has at least 20 requests. App Store outbound clicks remain a
separate directional interaction and never mean an install, subscription, or
revenue. Other interaction counters are diagnostics, not business outcomes.

## Things the system will NOT do (on purpose)

- Confirm an appointment without a verified Stripe webhook.
- Let two bookings share a start time (database constraint).
- Send marketing email (only transactional templates exist).
- Auto-enforce late-cancellation forfeitures.
- Seed fixtures into production.
