# PPI Admin Guide (for the owner)

Open `/ppi/admin/`. In preview, unlock with the `ADMIN_DEV_KEY`; in production
you'll sign in through Cloudflare Access with your email instead.

## Daily flow

1. **Overview** shows new requests, waiting states, upcoming appointments,
   30-day revenue and the conversion funnel. ⚠ marks manual-review requests
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
- Launch promo: `pricing.promo.enabled: true`, `priceCents: 14900`,
  `endsAt: "2026-08-31"` — shows a truthful time-limited price on the page.
- Travel: `travel.bands` (`maxMiles`/`feeCents`), origin lat/lng (keep it the
  public central-Vegas point, never your home).
- Schedule: `scheduling.slotTemplates`, `daysOfOperation` (0=Sun…6=Sat),
  `blackoutDates: ["2026-12-25"]`, `minLeadHours`, `holdMinutes`.
- Quote expiry: `quotes.expiryHours` (48 by default).

Every save is audit-logged. Unknown keys are ignored; broken JSON is rejected.

## Useful SQL (via `npx wrangler d1 execute autoclarity_ppi --remote --command "..."`)

- Deletion request (after removing uploads in the UI):
  `UPDATE ppi_requests SET deleted_at = datetime('now') WHERE ref = 'PPI-...';`
  then redact the customer:
  `UPDATE customers SET full_name='deleted', email='deleted@example.invalid', phone='' WHERE id = '...';`
- Purge stale magic links:
  `DELETE FROM magic_links WHERE expires_at < datetime('now','-90 days');`

## Analytics event definitions (no PII by design)

| Event | Fired when |
|---|---|
| `ppi_page_view` | Landing page loaded with the API reachable |
| `ppi_cta_click` | A "Request" CTA clicked (`step`: hero/final) |
| `ppi_form_started` | First keystroke/interaction in the intake form |
| `ppi_form_step_completed` | A step passes validation (`step`: buyer/vehicle/location/access/timing) |
| `ppi_request_submitted` | Server accepted the submission |
| `ppi_quote_sent` | Admin sent a quote (server-side) |
| `ppi_slot_selected` | Customer held a window |
| `ppi_agreement_accepted` | All documents accepted |
| `ppi_checkout_started` | Customer tapped the pay button |
| `ppi_payment_confirmed` / `ppi_booking_confirmed` | Webhook confirmed payment/booking (server-side) |
| `ppi_cancelled` | Customer cancel action |
| `ppi_completed` | Request marked completed |
| `ppi_waitlist_joined` | Waitlist signup (waitlist mode) |

Stored as counters in `analytics_events` (event, step, source, timestamp) —
the table has no columns for names, emails, VINs or addresses.

## Things the system will NOT do (on purpose)

- Confirm an appointment without a verified Stripe webhook.
- Let two bookings share a start time (database constraint).
- Send marketing email (only transactional templates exist).
- Auto-enforce late-cancellation forfeitures.
- Seed fixtures into production.
