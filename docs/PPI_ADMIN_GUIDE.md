# PPI Admin Guide (for the owner)

Open `/ppi/admin/`. In preview, unlock with the `ADMIN_DEV_KEY`; in production
you'll sign in through Cloudflare Access with your email instead.

## Daily flow

1. **Overview** shows new requests, waiting states, upcoming appointments,
   separate gross/refund/net/dispute totals, a verified 30-day service funnel,
   source cohorts, and interaction counters. ⚠ marks manual-review requests
   (exotic, classic, salvage, heavy mods, non-running); ⚡ marks same-day
   priority.
2. Open a request → everything the customer submitted, their uploads, travel
   estimate and the suggested tier **with the reasons** (internal only).
3. If something's missing → Status → `needs_info` with a note (emails them a
   fresh portal link). Seller not confirmed → `seller_access_pending`.
4. **Quote**: pick the tier (suggestion shown), optionally override base price,
   travel, add-ons, discount; add a customer-facing note; Create draft →
   review → **Send to customer**. Sending emails them the quote + portal link.
   Quotes are versioned — a new version supersedes the old one automatically,
   and any change after acceptance requires a new version by design.
5. **Scheduling**: offer 2–3 windows (9:00 / 12:30 / 4:00 templates). The
   system rejects conflicts including your travel + report-writing buffers.
   The customer picks one → it's held for 60 minutes while they sign and pay.
6. Payment confirms automatically via Stripe webhook: slot confirmed, other
   windows released, confirmation emails sent, status → Confirmed. You'll get
   an owner notification.
7. Day-of: move status to `inspection_in_progress` → `report_in_progress` →
   `completed`. Use **Messages** to deliver the results link/summary
   ("report ready" email).
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
- Travel: `travel.bands` (`maxMiles`/`feeCents`), origin lat/lng (keep it the
  public central-Vegas point, never your home).
- Schedule: `scheduling.slotTemplates`, `daysOfOperation` (0=Sun…6=Sat),
  `blackoutDates: ["2026-12-25"]`, `minLeadHours`, `holdMinutes`.
- Quote expiry: `quotes.expiryHours` (48 by default).

Every save is audit-logged. Unknown keys are ignored; broken JSON is rejected.

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
- Redact outbound bodies containing portal bearer URLs after the 14-day link
  lifetime while retaining delivery metadata:
  `UPDATE messages SET body_text='[Outbound email body redacted after secure-link expiry.]' WHERE direction='outbound' AND channel='email' AND created_at < datetime('now','-14 days') AND body_text LIKE '%/ppi/portal/?t=%';`
  Run at least every 14 days, record the row count, and review retention with
  counsel before changing the interval.

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
`ppi_unknown` and display with direct traffic as “Direct / unknown.”

The Overview exposes fixed 7-, 30-, and 90-day windows. Operational milestones
use their first server-recorded event time. Checkout starts require an actual
Stripe Session id; successful payment time comes from the deterministic webhook
event. Successful Refund rows and Dispute cases use provider-created times.
Payment-cohort gross is the original captured amount, current refunds are shown
separately, and recognized net subtracts both refunds and currently withdrawn
disputes. It is collected revenue, not profit: processor fees, tax, labor,
travel, and overhead are not deducted. Missing webhook confirmation timestamps
are surfaced as data-quality exceptions rather than assigned a guessed time.

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
