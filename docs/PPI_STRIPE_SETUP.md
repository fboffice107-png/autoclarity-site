# Stripe Setup

**Preview uses TEST MODE ONLY. Live keys are refused by code unless
`PPI_ENV=production` AND `PPI_MODE=live` AND `STRIPE_ENV=live`. Production is
already intentionally configured with that live tuple; unrelated releases must
preserve it rather than treating the effective Checkout capability as an intake
charge trigger.**

## Test mode (preview) — ~10 minutes

1. Create/log into the Stripe account → toggle **Test mode**.
2. Developers → API keys → copy the **Secret key** (`sk_test_...`).
   - Set it only on the isolated `autoclarity-site-preview` Pages project, either
     in that project's dashboard or with:
     `npx --no-install wrangler pages secret put STRIPE_SECRET_KEY --project-name autoclarity-site-preview`.
     Never target the production `autoclarity-site` project during preview setup.
3. Developers → Webhooks → Add endpoint:
   - URL: `https://<preview-host>/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`,
     `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
     `charge.dispute.closed`, `charge.dispute.funds_reinstated`,
     `charge.dispute.funds_withdrawn`, `refund.created`, `refund.updated`, and
     `refund.failed`
   - Set the webhook endpoint to Stripe API version `2024-10-28.acacia` or a
     later compatible version, then exercise the refund tests before rollout.
   - Copy the **Signing secret** (`whsec_...`) → secret `STRIPE_WEBHOOK_SECRET`.
4. Set Pages env var `PAYMENTS_ENABLED=true` for the preview environment when
   you want to exercise the full checkout (default is `false`; the portal then
   stops honestly at the payment step).
5. Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

## What the integration does (for reference)

- A durable D1 checkout claim is created before Stripe is called. Retries after
  a recoverable interruption reuse the same provider idempotency key;
  `client_reference_id` remains the internal booking id.
- Metadata carries internal ids only — never VIN, address, notes.
- Success/cancel URLs come from the production-configured `PUBLIC_BASE_URL`, not
  request headers.
- The **webhook** is the only thing that confirms bookings. Signatures are
  HMAC-verified with a 5-minute tolerance; event ids are recorded in
  `stripe_events` so replays are acknowledged but never reprocessed.
- Individual Stripe Refund objects are recorded from `refund.created`,
  `refund.updated`, and `refund.failed`. Payment totals are rebuilt from the
  currently succeeded Refund ledger, so a later authoritative failure can
  reduce a previously reported refund. `charge.refunded` remains a
  compatibility/final-balance cross-check and cannot override a newer Refund
  event.
- Stripe Dispute lifecycle and funds movement are recorded on independent,
  ordered clocks from `charge.dispute.created`, `charge.dispute.updated`,
  `charge.dispute.closed`, `charge.dispute.funds_reinstated`, and
  `charge.dispute.funds_withdrawn`. A favorable outcome can release only the
  payment's economic dispute latch after reinstated funds are recorded. It
  never reopens a request, booking, slot, portal link, or capacity; those
  require deliberate manual follow-up.
- No card data ever touches the AutoClarity database.

## Production preservation and verification

The live account, key, webhook, and variables were already configured and used
before this growth release. Verify them through owner-authorized account access;
do not rotate or replace them as part of this release:

1. Confirm the Stripe account remains active and payout details remain
   owner-approved without exposing them in release evidence.
2. Confirm the encrypted production key binding remains present; do not reveal
   or change its value.
3. Confirm the live webhook remains configured at
   `https://getautoclarity.com/api/stripe/webhook` for the same thirteen events
   and a compatible API version; do not reveal or change its signing secret.
4. Preserve production variables: `STRIPE_ENV=live`,
   `PAYMENTS_ENABLED=true`, `PPI_MODE=live`, `PPI_ENV=production`.
5. Verify the no-store runtime response still reports payments available and
   rely on the existing signed-event and prior gated-Checkout evidence for this
   no-charge release check. Do not create a new Checkout Session, use a live
   card, complete a charge, or issue a refund without separate explicit owner
   authorization.
