# PPI Portal — Data & Retention

> LEGAL REVIEW REQUIRED: retention periods below are recommended defaults for
> the owner and counsel to confirm; nothing here is legal advice.

## What is collected, where, why

| Data | Store | Purpose |
|---|---|---|
| Buyer name, email, phone, contact preference, consents | D1 `customers` | Deliver the service; transactional messages |
| Vehicle details incl. VIN, prices, listing URL | D1 `vehicles` (+ `vin_cache` for decode results) | Quote accurately; confirm the inspected vehicle |
| Inspection address, seller contact info supplied by buyer | D1 `ppi_requests` | Perform the mobile inspection |
| Uploaded images | R2 (private) + reference row in `request_uploads` | Context for review/quoting |
| Quotes, slots, bookings, status history | D1 | Operate the workflow; dispute evidence |
| Agreement acceptances (doc version+hash, typed name, IP, UA, time) | D1 `agreement_acceptances` | Consent records |
| Payment status, Stripe ids, amounts (never card data) | D1 `payments`, `stripe_events` | Reconciliation, refunds, disputes |
| Emails sent (template, recipient, body) | D1 `messages` | Support and delivery audit |
| Funnel counters (event name only) | D1 `analytics_events` | Conversion measurement — schema has no PII columns |
| Admin actions | D1 `admin_audit_log` | Accountability |

Third parties: Stripe (payments), Resend or equivalent (email delivery),
Cloudflare (hosting/DB/storage/Turnstile), NHTSA vPIC (VIN only — no personal
data sent). No sale of personal information.

## Recommended retention defaults (configurable, not hardcoded)

| Data | Recommended retention | Rationale |
|---|---|---|
| Completed/cancelled request records incl. agreements & payments | 7 years | Tax/liability records (confirm with counsel/CPA) |
| Uploaded images | 12 months after request closes | Short useful life; admin can delete anytime |
| Magic links | expire at 14 days; purge rows 90 days after expiry | Access control hygiene |
| `rate_limits` | hours (auto-pruned opportunistically) | Transient |
| `analytics_events` | 24 months | Trend analysis, no PII |
| `vin_cache` | 30 days freshness; purge at 12 months | Public data cache |
| Waitlist emails | until launch + 6 months or unsubscribe | Purpose-bound |

Deletion requests: locate by email in admin → delete uploads (built-in tool),
soft-delete the request (`deleted_at`), erase customer row unless a payment
record must be retained for legal/accounting reasons (redact instead: replace
name/phone/email with `deleted-<id>`). Document each fulfilled request.

There is no automated purge job in v1; a quarterly manual pass (or the optional
cron Worker) covers it at launch volume. SQL snippets live in
PPI_ADMIN_GUIDE.md.
