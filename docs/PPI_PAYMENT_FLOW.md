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
   charged, so a customer is never charged an amount they did not accept. This
   gate is defence in depth: the admin API refuses to re-quote a request that is
   mid-payment, so today it is unreachable over HTTP and is covered by unit
   tests rather than an end-to-end one.

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

Three controls, only the last of which is fully independent of the others:

1. **A server-side Stripe idempotency key.** `checkoutIdempotencyKey()` hashes
   the request id, the quote being charged, the window it reserves and the
   reserved payment-attempt row. Stripe replays the original response for a
   repeated key, so a retry after a timeout or a dropped response recovers the
   session Stripe already created instead of making a second payable one. Every
   field of the session request is therefore a pure function of the attempt —
   including `expires_at`, which is fixed at the attempt's `created_at` plus 60
   minutes, never derived from the clock (Stripe rejects a repeated key whose
   body differs, and requires at least 30 minutes of runway, so a replay up to
   the 25-minute retry cutoff still validates).
2. **Attempt reuse.** An open attempt for the same quote and window is retried
   as *itself*, so it replays the same key. This is not independent of (1) — the
   key is derived from the attempt row — but it is what makes the key reachable
   on a retry. A failed Stripe call therefore does **not** mark the attempt
   failed; only a `StripeConfigError`, which proves no request left the Worker,
   does.
3. **A database invariant.** The attempt row is written *before* Stripe is
   called, so a session can never exist without a row for its webhook to match,
   and the partial unique index `idx_payments_one_open_attempt` (migration 0003)
   caps a request at one open attempt. This one holds even if the other two are
   wrong.

UI debouncing is not on this list; the button state is a convenience, not a
control.

### Replacing an existing session

Discarding a session locally is the one move that can produce a double charge,
because our expiry estimate can lag a payment the customer has already made. So
before any replacement, the portal **asks Stripe** what the session is:

- paid or complete → `409 payment_processing`, nothing is replaced, and the
  customer is told their payment is going through;
- open → expire it at Stripe first, and refuse to replace it if that fails;
- expired → safe to replace;
- Stripe unreachable → `503 checkout_unavailable`. Unknown is never treated as
  dead.

Refunds carry an idempotency key too, seeded with the payment id, the amount
already refunded and the amount requested — a double-submitted refund replays,
while a genuine second partial refund still goes through.

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
  no-double-booking index refuses the confirmation because another customer now
  holds that exact start time — the payment is still recorded, the request
  returns to `awaiting_time_selection`, the customer sees a portal message, and
  the owner gets exactly one `PAID BUT SLOT LAPSED — action needed` email
  (deduped on the payment id). The customer can pick another window; the Pay button does **not** come
  back (gate 2 above), and the owner confirms the new time by hand.
- `checkout.session.expired` and `checkout.session.async_payment_failed`
  release the held window back to `offered` and return the request to time
  selection, unless a payment for that request has already settled.
- **A payment is never discarded because we had written the attempt off.**
  `expired` and `failed` are our conclusions, and Stripe overrules them: such a
  payment is still recorded as succeeded and raises a `PAYMENT ARRIVED ON A
  CLOSED ATTEMPT` alert. A paid session with no matching row at all raises
  `PAYMENT WITH NO LOCAL RECORD` rather than being silently acknowledged, and a
  request that ends up with two settled payments raises `DUPLICATE PAYMENT`.

## Double booking

Two guarantees, at different strengths:

- **Identical start times** are refused by the database: the partial unique
  index `idx_slots_no_double_booking` covers `starts_at` for slots in `held` or
  `confirmed`. This cannot be bypassed by any code path.
- **Overlapping windows** (an inspection runs about two hours) are refused by
  the application: `select_slot` places its hold first and then checks for an
  overlapping held/confirmed window belonging to another request, rolling the
  hold back if it finds one. Because the hold is already visible, two customers
  racing on overlapping times will each see the other; the worst case is that
  both step back and pick again, never that both are booked. The Stripe webhook
  repeats the same check before confirming.

Offering the same free window to two customers is deliberately allowed — the
race is resolved at selection, not at proposal. `propose_slots` additionally
refuses times that clash with an existing held or confirmed appointment,
including travel and report buffers.

## Before payments are ever enabled

1. Check that no request has two open payment attempts, or the unique index in
   migration 0003 will refuse to build:
   `SELECT request_id, COUNT(*) FROM payments WHERE status IN ('created','pending') GROUP BY request_id HAVING COUNT(*) > 1;`
2. Apply migration 0003 to the production database:
   `npx wrangler d1 migrations apply autoclarity_ppi --remote`.
   The columns and index it adds are only read when `PAYMENTS_ENABLED=true`, so
   production is unaffected until then — but the migration must land *before*
   the flag flips. Enabling payments first would 500 every checkout (failing
   closed, but loudly).
3. Follow `docs/PPI_STRIPE_SETUP.md` (test mode first, live mode owner-gated).

## Owner alerts that mean money needs a human

All are deduped, so each situation emails once:

| Subject contains | Meaning |
|---|---|
| `PAID BUT SLOT LAPSED` | Payment succeeded but the window could not be confirmed. Offer new windows. |
| `PAYMENT ARRIVED ON A CLOSED ATTEMPT` | Stripe paid a checkout this system had written off. Check no second payment was taken. |
| `DUPLICATE PAYMENT` | The request has more than one settled payment. Refund the extra one. |
| `PAYMENT WITH NO LOCAL RECORD` | A paid session matching no payment row. Reconcile by hand in Stripe. |
| `PAID AND SCHEDULED BUT STATUS DID NOT MOVE` | The booking is confirmed and the customer emailed, but the request status did not follow. Set it by hand. |
| `REFUND FOR AN UNKNOWN PAYMENT` / `DISPUTE ON AN UNKNOWN PAYMENT` | Stripe activity we cannot match locally. |

## One behaviour change that is live even with payments off

A refused checkout now performs its recovery transition *before* the
`PAYMENTS_ENABLED` check. In production today, a customer who clicks Pay after
their hold has lapsed moves from `awaiting_payment` back to
`awaiting_time_selection`, gets a portal message, and the owner gets one email —
where previously that click was an inert `409`. This is intended (it un-sticks
the customer), but it is a real change with payments disabled.

## Where the proof lives

- `tests/unit/checkout-gates.test.ts` — the full gate matrix, including refusals
  that cannot currently be reached over HTTP.
- `tests/integration/payment-gates.test.ts` — the end-to-end flow over real HTTP
  against a mock Stripe: free submission, every refused shortcut, duplicate
  clicks, forged webhooks, replays, expiry, admin schedule changes, re-quoting,
  double booking, a Stripe response lost *after* the session was created, and a
  paid session whose window a second customer now holds.
- `tests/unit/stripe.test.ts` — signature verification, live-key refusal, and the
  idempotency-key derivation.
- `tests/unit/production-config.test.ts` — production ships with payments off,
  Stripe in test mode, and no live key material anywhere in the repository.
