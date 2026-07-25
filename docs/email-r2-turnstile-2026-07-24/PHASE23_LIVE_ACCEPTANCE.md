# Phases 2+3 live deployment + production acceptance evidence (2026-07-24/25)

All evidence below was observed directly against **https://getautoclarity.com**
(production) unless stated. Stripe untouched throughout: `STRIPE_ENV=test`,
`PAYMENTS_ENABLED=false` re-verified live before and after every step.

## Deployment

- R2 subscription activated by the owner (dashboard). Bucket created from CLI:
  **`autoclarity-ppi-uploads`** (WNAM, Standard). Managed public `r2.dev`
  domain verified **disabled** via API (`enabled:false`) — the bucket is
  private; nothing is ever served directly.
- One combined deploy shipped the prepared config (commit `3cfc7d9`, clean
  tree): R2 binding `UPLOADS` + `UPLOADS_ENABLED=true` + real Turnstile
  sitekey `0x4AAAAAAD9RlzUuK7woWT3B` (secret was already stored, never
  displayed). Deployment id **`ba2df6bd`**.
- Pre-deploy gates at that commit: `tsc` clean, **190 tests** (118 unit + 72
  integration), 20 links OK, header checks pass (against a temporary local
  staging server, stopped afterwards).

## Live post-deploy verification

| Check | Result |
|---|---|
| `/api/ppi/runtime-config` | `paymentsEnabled:false`, `uploadsEnabled:true`, `mode:request`, real sitekey served |
| Dummy Turnstile token POST | **403 `turnstile_failed`** (always-pass era over) |
| Missing token POST | **403** |
| Access gates ×4 (`/ppi/admin`, `/api/admin`, `/inspector`, `/api/inspector`) | all **302** to Access login |
| apex / www / aliases / noindex | unchanged from post-cutover state |

## Production acceptance workflow (real browser, real Turnstile)

1. **Live submission through the real 4-step form UI** (Chromium, desktop
   viewport): fields filled through real input events, steps advanced with the
   real Continue buttons. The **Managed Turnstile widget issued a real token
   non-interactively** (816 chars). Real Submit click → success panel with ref
   **`PPI-260725-MQZ9`** (2016 Toyota 4Runner SR5, ZIP 89117, customer
   `fboffice107+livetest2@gmail.com`, notes clearly labeled
   "OWNER ACCEPTANCE TEST"). Success renders only after D1 storage.
2. **Emails**: exactly 2 D1 message rows — `request_received` → the +livetest2
   alias and `owner_notify` → the owner address, both **`sent` with Resend
   provider IDs**. (Same delivery path the owner inbox-confirmed in Phase 1.)
3. **Duplicate resubmission through the live UI** (fresh page load, second
   real Turnstile token): duplicate note shown, same ref returned, message
   count still **exactly 2** — no duplicate emails.
4. **Live R2 photo path** (customer portal token from the success link):
   - 2,069,466-byte phone-dimension JPEG (3024×4032) → **200**, id
     `upl_17855395f8cc4461b0107d299a86da5c`.
   - Object confirmed in the production bucket via the R2 API under the
     randomized key `uploads/req_cbb79405…/ee802a07-….jpg`.
   - Stream-back with the owning token: **byte-identical**, correct
     `image/jpeg` + `no-store` + CSP-sandbox headers, PIL decodes 3024×4032.
   - Text file declared as `.jpg` → **422**. Garbage token → **401**.
   - **Cross-tenant proof**: the other live request's valid token asking for
     this upload id → **404**. Never 200.
5. **Portal page live**: renders `PPI-260725-MQZ9` with correct vehicle and
   location; magic-token auth.
6. **Mobile (375×812)**: page + success panel render with **0 px horizontal
   document overflow**; hero/nav/form verified by screenshot.
7. **Turnstile widget config re-read via API**: name "AutoClarity Public
   Request Form", mode **managed**, domains exactly
   `getautoclarity.com` + `www.getautoclarity.com`.

## Not provable from this seat (owner-only residue)

- **Inspector workspace on production** sits behind Cloudflare Access
  one-time-PIN to the owner email — no automated path exists by design.
  The full inspector photo→publish→HTML/PDF cycle is proven end-to-end on the
  identical code by the staging browser workflow + 190-test suite
  (see PHASE2_STAGING_EVIDENCE.md + WORKFLOW_QA_REVIEW.md). The owner's
  Access PIN login test (runbook OWNER STEP 4) remains the one outstanding
  human check and now also doubles as the live inspector-photo spot-check.

## Test data on production

`PPI-260725-G2JW` (Phase 1) and `PPI-260725-MQZ9` (+1 R2 object) are
owner-controlled test requests, explicitly labeled in their customer
name/notes; cancel them from the admin dashboard at will. No fake
appointments, payments or revenue exist anywhere.

## Cost note

R2 free tier: 10 GB storage / 1M class-A + 10M class-B ops per month. One
test object (≈2 MB) stored. At inspection-photo volumes (≤120 photos/report,
client-downscaled ≤1600px ≈ 200–400 KB each) the free tier covers hundreds of
reports/month; no per-photo egress cost via Workers bindings.

## Rollback

- Uploads/Turnstile: `docs/email-r2-turnstile-2026-07-24/PRE_CHANGE_CHECKPOINT.md`
  (flip `UPLOADS_ENABLED=false`, re-comment binding, restore test Turnstile
  keys, redeploy). Bucket may stay (private, free).
- Email: delete the two Resend secrets → honest `recorded` mode.
- Whole site: unchanged from the cutover checkpoint (custom-domain removal →
  GitHub Pages).
