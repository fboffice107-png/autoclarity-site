# Stripe Setup

**Preview uses TEST MODE ONLY. Live keys are refused by code unless
`PPI_ENV=production` AND `PPI_MODE=live` AND `STRIPE_ENV=live` — and switching
those on is an owner decision gated by the production checklist.**

## Test mode (preview) — ~10 minutes

1. Create/log into the Stripe account → toggle **Test mode**.
2. Developers → API keys → copy the **Secret key** (`sk_test_...`).
   - Set it: `npx wrangler pages secret put STRIPE_SECRET_KEY --project-name autoclarity-site`
     (choose the Preview environment when prompted, or set it in the dashboard).
3. Developers → Webhooks → Add endpoint:
   - URL: `https://<preview-host>/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`,
     `charge.refunded`, `charge.dispute.created`
   - Copy the **Signing secret** (`whsec_...`) → secret `STRIPE_WEBHOOK_SECRET`.
4. Set Pages env var `PAYMENTS_ENABLED=true` for the preview environment when
   you want to exercise the full checkout (default is `false`; the portal then
   stops honestly at the payment step).
5. Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

## What the integration does (for reference)

- Fresh Checkout Session per attempt; `client_reference_id` = internal booking id.
- Metadata carries internal ids only — never VIN, address, notes.
- Success/cancel URLs come from `PUBLIC_BASE_URL` (allowlisted), not request headers.
- The **webhook** is the only thing that confirms bookings. Signatures are
  HMAC-verified with a 5-minute tolerance; event ids are recorded in
  `stripe_events` so replays are acknowledged but never reprocessed.
- Refunds are initiated from the admin dashboard; the final refund state is
  recorded when Stripe's `charge.refunded` webhook arrives.
- No card data ever touches the AutoClarity database.

## Going live (LATER — owner-gated)

Do not do any of this until the production checklist passes and you have
explicitly approved production deployment:

1. Activate the Stripe account (business details, bank account).
2. Live mode → API keys → `sk_live_...` → set as the **Production** secret.
3. Live webhook endpoint at `https://getautoclarity.com/api/stripe/webhook`
   with the same six events → live `whsec_...` secret.
4. Production env vars: `STRIPE_ENV=live`, `PAYMENTS_ENABLED=true`,
   `PPI_MODE=live`, `PPI_ENV=production`.
5. One small controlled live payment test with immediate refund (checklist item).
