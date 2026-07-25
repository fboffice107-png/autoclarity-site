# The request-first payment flow (verified 2026-07-25)

**Submitting an inspection request is free and always has been.** Nothing in
the public form, the intake API or the confirmation emails creates a Stripe
Checkout Session, a payment record or a booking. Payment becomes possible only
after the owner has reviewed the request, sent an exact quote, offered real
appointment windows, and the customer has held one and accepted every current
agreement document.

This document is the reference for how that is enforced, what happens when
something goes wrong, and which owner actions the flow expects.

## The path a booking takes

| # | Step | Who | Request status afterwards |
|---|------|-----|---------------------------|
| 1 | Submits the intake form (free) | customer | `submitted` |
| 2 | Reviews vehicle, location, seller access, travel, complexity | owner | `ready_for_review` |
| 3 | Prepares the exact quote | owner | `quote_prepared` |
| 4 | Sends the quote (customer is emailed a fresh portal link) | owner | `quote_sent` |
| 5 | Offers 1–5 genuinely available windows | owner | unchanged |
| 6 | Selects one offered window — it is held atomically | customer | `awaiting_agreement` |
| 7 | Accepts every agreement document with a typed signature | customer | `awaiting_payment` |
| 8 | Opens Stripe Checkout | customer | unchanged |
| 9 | Stripe delivers a signature-verified webhook | Stripe | `confirmed` |

Every hop is a compare-and-swap in `functions/lib/status.ts`; an unexpected
current status fails the transition rather than overwriting it.

## The gates in front of Checkout

`functions/lib/checkout-gates.ts` is the single decision point, evaluated on
facts read from the database. In order:

1. **State** — the status must be `awaiting_payment`. That status is only
   reachable through review → quote → send → window held → agreements accepted,
   so this one check carries the whole earlier chain. Confirmed requests get
   `already_confirmed`; cancelled, expired, refunded or disputed ones get
   `request_closed`.
2. **Never twice** — a request with a settled payment (`succeeded`,
   `refunded`, `partially_refunded`, `disputed`) is refused with `already_paid`.
3. **Quote** — the highest-version quote must exist, be `sent` (not draft,
   superseded or cancelled), be unexpired, and have a positive integer total.
4. **Window** — a slot must currently be `held` for this request.
5. **Agreements** — every currently required agreement version id must have an
   `accepted = 1` acceptance. This is a set comparison, not a count, so a newly
   published document version cannot be satisfied by older acceptances.
6. **Quote stability** — those acceptances must be bound to the quote being
   charged, so a customer is never charged an amount they did not accept.

Only then is `PAYMENTS_ENABLED` consulted. With payments off (the production
setting today) the portal returns an honest "payment is switched off" message
and stops.

### Recovery instead of dead ends

A refused checkout puts the request back where the customer can act:

- `hold_lapsed` → back to `awaiting_time_selection`, a portal message explains
  the released window, and the owner is notified once.
- `agreements_missing` / `quote_changed` → back to `awaiting_agreement` so the
  current documents (and the current price) are re-accepted.

## One live Checkout Session per request

- The payment attempt row is written **before** Stripe is called, so a session
  can never exist without a row for its webhook to match.
- A partial unique index (`idx_payments_one_open_attempt`, migration 0003)
  makes "at most one open attempt per request" a database invariant.
- A repeat click on Pay returns the **same** session URL while it is still
  open; if the quote or window changed, the previous session is expired at
  Stripe before a replacement is created.

## The webhook is the only authority

`functions/api/stripe/webhook.ts` confirms bookings; the browser success page
cannot. `/ppi/portal/?checkout=success` only polls `GET /api/portal` and shows
whatever the server already believes.

- Signatures are HMAC-verified with a 5-minute tolerance; unsigned or wrongly
  signed events are rejected with 400.
- Event ids are recorded in `stripe_events`; a replay is acknowledged and never
  reprocessed. A duplicate delivery with a *different* event id is caught by the
  payment-row compare-and-swap.
- On success: the held slot is confirmed, every other proposed window for that
  request is released, the quote is marked accepted, and the confirmation emails
  are sent with dedupe keys.
- **If the window is gone** — the hold lapsed and the time was reassigned, or the
  no-double-booking index refuses the confirmation — the payment is still
  recorded, the request returns to `awaiting_time_selection`, the customer sees
  a portal message, and the owner gets a `PAID BUT SLOT LAPSED — action needed`
  email. The customer can pick another window; the Pay button does **not** come
  back (gate 2 above), and the owner confirms the new time by hand.
- `checkout.session.expired` and `checkout.session.async_payment_failed`
  release the held window back to `offered` and return the request to time
  selection, unless a payment for that request has already settled.

## Double booking

`idx_slots_no_double_booking` is a partial unique index over `starts_at` for
slots in `held` or `confirmed`. Offering the same free time to two customers is
allowed; the race is resolved when one of them selects it, and the loser gets a
409 asking them to pick again. `propose_slots` additionally refuses times that
clash with an existing held/confirmed appointment including travel and report
buffers.

## Before payments are ever enabled

1. Apply migration 0003 to the production database:
   `npx wrangler d1 migrations apply autoclarity_ppi --remote`.
   The columns and index it adds are only read when `PAYMENTS_ENABLED=true`, so
   production is unaffected until then — but the migration must land *before*
   the flag flips.
2. Follow `docs/PPI_STRIPE_SETUP.md` (test mode first, live mode owner-gated).

## Where the proof lives

- `tests/unit/checkout-gates.test.ts` — the full gate matrix, including refusals
  that cannot currently be reached over HTTP.
- `tests/integration/payment-gates.test.ts` — the end-to-end flow over real HTTP
  against a mock Stripe: free submission, every refused shortcut, duplicate
  clicks, forged webhooks, replays, expiry, admin schedule changes, re-quoting,
  double booking, and the paid-but-lost-window path.
- `tests/unit/production-config.test.ts` — production ships with payments off,
  Stripe in test mode, and no live key material anywhere in the repository.
