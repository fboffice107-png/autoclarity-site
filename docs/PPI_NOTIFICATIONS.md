# PPI notification delivery

## Email

Transactional emails are written to D1 before provider delivery. Intake uses
the Pages `waitUntil` lifetime so the customer sees a success response after
the lead and message record are durable, without waiting on Resend.

- `recorded`: D1 has the message; provider delivery is pending or no provider
  is configured.
- `sent`: Resend accepted the message.
- `failed`: D1 kept the message and error for an admin retry.

Each business notification has a stable `messages.dedupe_key`. Resend receives
the stable message ID as `Idempotency-Key`. Provider-protected replay is
allowed only while that key is still inside Resend's 24-hour retention window.
At or after 24 hours, the admin retry fails closed: the dashboard explains
that delivery is ambiguous, asks the owner to review provider history, and
requires a second explicit confirmation before creating a fresh outbox row
with a new provider key. The confirmation is deduplicated, so a double-click
does not create two fresh messages.

Routine notification links are additive and do not revoke a customer's other
working portal links. Before any admin retry, the stored portal token is checked
without consuming it. A revoked or expired token is never replayed; a new
non-rotating token is written into a deduplicated successor message instead.

The overview's `notificationIssues` count is the number of affected requests,
not the number of raw rows. It includes failed email, email still recorded
after five minutes, and durable audit fallbacks created when an email or secure
link could not be recorded at all. The affected request and source action are
shown directly on the overview.

The central outbox fallback is keyed by the notification dedupe key when one is
available, and callers enrich that same audit row with action context. This
keeps intake lead persistence independent from email while making both customer
and owner confirmation failures visible after navigation. A later outbox row
with the same dedupe key clears the recording alert immediately; a later
successful admin notification writes an action-resolution audit. Orphan audit
alerts without a resolvable outbox row remain visible for seven days, then age
out so the dashboard cannot accumulate permanent false positives. Stored failed
messages remain visible until sent or explicitly superseded by a sent retry.

## Transactional SMS (inactive)

`functions/lib/sms.ts` is only a provider-neutral Cloudflare Queue producer.
No queue binding, consumer, phone number, or paid SMS provider is shipped.
`SMS_ENABLED` defaults to `false`. The public contact selector mounts “Text
message” only when the flag, queue binding, and owner configuration all agree;
the server rejects a stale/crafted text preference otherwise and explains that
email carries transaction records.

Do not enable or bind `SMS_QUEUE` until all of the following are complete:

1. Register and approve the applicable sender/campaign with the chosen
   provider and US carrier ecosystem.
2. Preserve evidence of explicit transactional consent and the customer's
   request to use text as the contact channel.
3. Implement the queue consumer with durable delivery status, provider
   idempotency, retry/dead-letter handling, and monitoring.
4. Implement and test STOP/START/HELP handling and a suppression list before
   any outbound delivery. A queued message already carries AutoClarity brand,
   purpose, STOP/HELP, and message/data-rate language; the consumer must not
   remove it.
5. Review quiet hours, throughput limits, privacy/retention, and all applicable
   federal, state, carrier, and provider requirements.

The producer refuses to queue unless transactional consent is true, the
customer selected text contact, `SMS_ENABLED=true`, and `SMS_QUEUE` exists.

## Booking proposal delivery ledger (0019)

`sendBookingProposalDelivery` is the single proposal communication path for
initial sends, retrying the current stored email, and explicitly confirmed
resends. It reads contacts, vehicle, quote and offered slots from D1. Quote,
appointment, agreement, checkout and payment logic are unchanged. The existing
branded customer email template is rendered once into the existing outbox;
text uses that exact persisted canonical portal URL. Safe email-link refreshes
are read back from their successor outbox record before any first text handoff.

The additive `proposal_deliveries` table holds operation/channel status, message
references, timestamps, exact text snapshot and the text destination/job ID.
Email content and destination stay in `messages`. The authenticated dashboard
masks summary destinations and hides bearer URLs in snapshots. Owner email
includes the full canonical URL, original customer email body and exact text
body, plus customer/vehicle/request/proposal details and channel outcomes.
The owner email is separate (one per delivery operation), never a duplicate
customer recipient. Owner failure cannot undo customer acceptance. Owner-only
retries preserve historical links and never send to the customer.

Email `accepted` means Resend accepted the API call, not mailbox delivery.
`recorded` means no provider acceptance is confirmed. Text `queued` means only
Cloudflare Queue acceptance; this repository still has no SMS provider,
consumer or delivery webhook. `unknown` means queue handoff threw or timed out
and may have succeeded. Neither state is described as a sent text. Missing
contact data, disabled SMS, missing binding, and consent/preference gates have
separate safe reasons. No new credentials are needed for email.

Each operation is claimed in D1 before sending. Initial sends retain the
existing proposal and outbox idempotency keys. Retry/resend requests carry the
latest delivery ID. A unique parent-operation constraint prevents two browser
tabs from starting different operations from the same observed state. Resend
also requires an explicit confirmation and operation key, reuses the saved
quote/email content, and rejects expired, superseded or no-longer-open offers.
Retries preserve any queued or ambiguous prior text instead of enqueuing again.
After an ambiguous text handoff, review the queue/provider before explicitly
resending. A `processing` operation is not automatically reclaimed after a
crash: inspect its outbox/queue before operational reconciliation. A failed
tracking write is shown as interrupted, never blanket delivery success.

No old proposal is backfilled or sent by GET. Existing sent proposals continue
to show their original outbox snapshot; an intentional resend is available
under Advanced delivery actions. Generic failed-email retry routes proposal
mail through this service. Retry after Resend's 24-hour key window still needs
explicit fresh-copy confirmation. Provider error bodies and exception strings
are not persisted in the new delivery ledger or logged from its error paths.
