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
`SMS_ENABLED` defaults to `false`.

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
