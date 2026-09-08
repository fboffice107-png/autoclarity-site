# PPI Portal — Data & Retention

This file records the PPI data flow and operator-managed retention targets.
The application does not automatically enforce the target periods below; the
owner should keep them aligned with current operating and recordkeeping needs.

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
| Emails sent (template, recipient, body) | D1 `messages` | Support and delivery audit. Some bodies contain a 14-day portal bearer URL; the credential table itself stores only its hash. |
| Funnel counters (event name only) | D1 `analytics_events` | Conversion measurement — schema has no PII columns |
| Admin actions | D1 `admin_audit_log` | Accountability |
| In-progress intake draft | Customer browser `localStorage` for up to 7 days | Resume a form on the same device; cleared after confirmed submission or by the customer |
| Portal secure-link token | Customer browser tab `sessionStorage` | Preserve portal access across the Stripe Checkout redirect for that tab session |

Third parties: Stripe (payments), Resend or equivalent (email delivery),
Cloudflare (hosting/DB/storage/Turnstile), and NHTSA vPIC (the VIN is sent for
decoding; customer contact and seller details are not). No sale of personal
information.

## Operator-managed retention targets (not hardcoded)

| Data | Recommended retention | Rationale |
|---|---|---|
| Completed/cancelled request records incl. agreements & payments | 7 years | Accounting, payment, refund, and dispute records |
| Uploaded images | 12 months after request closes | Short useful life; admin can delete anytime |
| Magic links | expire at 14 days; purge rows 90 days after expiry | Access control hygiene |
| Outbound email bodies containing portal URLs | redact by day 13, before the linked token's 14-day expiry; retain non-secret delivery metadata as required | Prevent expired/live bearer URLs from accumulating in backups and admin views |
| `rate_limits` | hours (auto-pruned opportunistically) | Transient |
| `analytics_events` | 24 months | Trend analysis, no PII |
| `vin_cache` | 30 days freshness; purge at 12 months | Public data cache |
| Waitlist emails | until launch + 6 months or unsubscribe | Purpose-bound |

Deletion requests: locate the request by email in admin, delete eligible uploads
with the built-in tool, soft-delete the request (`deleted_at`), and redact
customer fields where linked payment or operating records must remain. Do not
delete a customer row while referenced records still depend on it. Document
each completed request.

There is no automated purge job. Before live operation, the owner must assign a
named operator and calendar a linked-email body redaction pass at least every
24 hours, with missed-run alerts, plus the broader quarterly retention pass.
The day-13 cutoff leaves a one-day buffer before link expiry. SQL snippets live
in `PPI_ADMIN_GUIDE.md`; retain evidence that each pass ran and automate it
before scale.
