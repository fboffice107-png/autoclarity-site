# Phase 1 — Real email delivery: evidence (2026-07-24)

## Owner-completed prerequisites (dashboard, values never in chat)

- Resend account created; domain `getautoclarity.com` **Verified** in Resend.
- Sending-access API key (restricted to the domain) created by the owner.
- Secrets set by the owner via hidden Wrangler prompts:
  `RESEND_API_KEY`, `EMAIL_FROM` (= `AutoClarity <support@getautoclarity.com>`).
- Pre-existing: `ADMIN_NOTIFY_EMAIL` (owner-private destination),
  `SUPPORT_EMAIL=support@getautoclarity.com` (public identity, wrangler.toml).

## Session verification (all against live production)

1. **Secret names confirmed** in the Pages production env (names only):
   `RESEND_API_KEY` and `EMAIL_FROM` both present alongside the 8 prior secrets.
2. **Redeployed** so secrets bind: deployment `3c20211d`, code unchanged
   (checkpoint commit `ac53d1d`, clean tree).
3. **Safety re-verified post-deploy** via live `/api/ppi/runtime-config`:
   `paymentsEnabled:false`, `uploadsEnabled:false`, `mode:request`,
   Turnstile still test sitekey. Stripe untouched.
4. **Real submission on https://getautoclarity.com** (same-origin POST):
   → `{ok:true, ref:"PPI-260725-G2JW"}`, customer
   `fboffice107+ppitest@gmail.com` (owner-controlled plus-alias).
5. **D1 message rows (remote query)** for `PPI-260725-G2JW`:
   | template | to | status | provider_id |
   |---|---|---|---|
   | request_received | fboffice107+ppitest@gmail.com | **sent** | `4eef10fa-9ecf-46eb-a4cb-2b1f7896afbb` |
   | owner_notify | fboffice107@gmail.com | **sent** | `ca4de292-21ba-466a-b4c6-8dca4152c508` |
   `status='sent'` + provider id are written only after Resend's API returns
   HTTP 200 with a message id (`functions/lib/email.ts`) — Resend accepted both.
6. **Duplicate submission (live)**: identical resubmit → `duplicate:true`,
   same ref, magic link rotated, message count for the request **still 2** —
   no duplicate emails; request row intact (`submitted`).
7. **Webhook-retry / failure safety** (not destructively re-run on prod):
   - DB-enforced idempotency: `CREATE UNIQUE INDEX idx_messages_dedupe ON
     messages(dedupe_key)` (migration 0002) + `stripe_events` replay guard.
   - Integration suite (part of the 190 passing this session): replayed
     webhook → `{replay:true}`, exactly one payment email per template;
     provider 500 → request intact + message `failed` with error recorded —
     email failure never loses a stored request.

## Delivery confirmation

- [x] Resend accepted both messages (provider IDs above).
- [x] **Owner confirmed in chat (2026-07-24): both emails RECEIVED in
  Gmail.** Customer `request_received` at the +ppitest alias — sender
  displayed `AutoClarity <support@getautoclarity.com>`, vehicle details,
  ref `PPI-260725-G2JW` and secure portal link present. Private
  `owner_notify` at the owner's main address with the admin link.
  **Phase 1 real email delivery is PROVEN.**

## Rollback

Delete the two secrets (`npx wrangler pages secret delete RESEND_API_KEY /
EMAIL_FROM --project-name autoclarity-site`) + redeploy → emails return to
honest `recorded`; optionally remove Resend DNS records (see
PRE_CHANGE_CHECKPOINT.md — Email-Routing MX/SPF rows untouched by Phase 1).
