# AutoClarity Pre-Purchase Inspection Portal — Session Handoff

_Last updated: 2026-07-23. Read this and `docs/PPI_CLOUDFLARE_PREVIEW_STATUS.md`
+ `docs/PPI_PRODUCTION_LAUNCH_CHECKLIST.md` before making any production change._

## Snapshot

| Item | Value |
|---|---|
| Repository | `autoclarity-site` (`/Volumes/Super Storage/autoclarity-site`) |
| Branch | `feature/las-vegas-ppi-portal` |
| Remote | `origin` = github.com/fboffice107-png/autoclarity-site (branch pushed) |
| Cloudflare Pages project | `autoclarity-site` |
| Hosted preview deployment | https://autoclarity-site.pages.dev (noindex; **not** the customer domain) |
| Custom domain status | **UNCHANGED** — getautoclarity.com still served by **GitHub Pages**. No DNS/custom-domain change made. |
| D1 database | `autoclarity_ppi` (`0ae44d57-1a4c-4fd9-96e9-629b1570af26`), migrations applied |
| R2 (photo uploads) | **Not enabled** on the account; binding commented in `wrangler.toml`; `UPLOADS_ENABLED=false` |
| Stripe | **test/sandbox verified end-to-end**; `STRIPE_ENV=test` |
| PAYMENTS_ENABLED | **false** (test only; live keys refused by code) |
| BOOKING_ENABLED | true |
| Notification delivery | **NOT configured — recorded to D1 only, not sent. LAUNCH BLOCKER.** |
| Admin security | Preview: `ADMIN_DEV_KEY` (API 401 without it). Production: Cloudflare Access **not yet configured** — required before the custom-domain cutover. |
| Tests | **100 pass** — 66 unit + 34 integration |
| Rollback tags | `pre-ppi-production` → `15a121c` (GitHub Pages prod); `ppi-preview-verified-2026-07-23` → verified preview checkpoint |

## Cloudflare Pages secrets (NAMES only — never values)

Production environment of the `autoclarity-site` Pages project:
`ADMIN_DEV_KEY`, `PUBLIC_BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`TURNSTILE_SECRET_KEY`. (No `RESEND_API_KEY`/`EMAIL_FROM`/`ADMIN_NOTIFY_EMAIL` →
notifications not delivered.)

## Verified this/last session (evidence-based)

- **Stripe sandbox**: real Checkout (`cs_test_…`), test card `4242…`, signed webhook, booking confirmed **only** via `system:stripe-webhook` (not the browser success page), payment `succeeded` (`pi_…`). Admin refund → `charge.refunded` webhook → `refunded` (async). Double-booking blocked (`slot_taken`, DB partial-unique index). Cancellation → `customer_cancelled` + slot `released` + re-bookable. See `docs/PPI_CLOUDFLARE_PREVIEW_STATUS.md` for the full run.
- **Scheduling** (`functions/lib/*`, `functions/api/portal/action.ts`): timezone `America/Los_Angeles` shown to customers; slots selectable only when `offered`; `propose_slots` rejects past/under-min-lead times and conflicts (incl. travel+report buffers); held/confirmed removed from availability by the partial-unique index; lazy hold-expiry release.
- **Mobile audit (hosted preview, 2026-07-23)**: no horizontal overflow at 320/360/375/390/414/768; form inputs `16px` (no iOS zoom); email/tel/numeric input modes correct; **intake form is single-column on phones** (fix added this session, `≤560px`); founder photo sharp (responsive AVIF/WebP/JPEG, no distortion); portal + status pills render cleanly; Las Vegas timezone shown. Homepage `320px` and standard-iPhone captured; landing, form, portal (post-payment/refunded) captured; see the mobile-audit matrix below.
- **Trust/legal**: no false certification/ASE/license/insurance/guarantee/160-point/#1 claims; the only "guarantee" copy is disclaimers/FAQ; scan/emissions language is gated off while `scan.included=false`; app-vs-inspection billing separation stated; agreements shown before payment.

## Changes made this session (bounded)

- **Customer-facing language (Phase 2):** removed bare "PPI" from public labels — homepage nav ("Pre-Purchase Inspection"), homepage hero secondary path ("Now serving Las Vegas" → button "Request a Pre-Purchase Inspection" → `/ppi?utm_source=homepage&utm_medium=owned&utm_campaign=ppi_launch`), homepage lower section button, landing final-CTA + Meet-Your-Inspector copy, and the three pricing tier labels ("Standard/European.../Exotic... **Inspection**") in `functions/lib/config.ts` + landing pricing cards + JSON-LD Offer names. `/ppi` URL and internal ids unchanged. (Internal admin UI + code identifiers may still say "PPI".)
- **Mobile fix:** single-column intake form on phones (`assets/css/ppi.css`), homepage secondary-path styles (`assets/css/site.css`).
- **Stripe key guard** (prior in-session): `stripeKey()` accepts test/sandbox/restricted secret keys, still refuses live keys in test mode + `pk_` keys.

## Final mobile & conversion pass (2026-07-23, second session)

Full write-up + PNG evidence: `docs/mobile-audit-2026-07-23/REPORT.md` (+ `screenshots/`).
Front-end/copy only — no payment, webhook, auth, schema, secret, DNS or deploy-infra change.

1. **FIXED conversion bug — all 3 form-nav buttons visible on every step.**
   Author CSS (`.btn{display:inline-flex}`) overrode the UA `[hidden]` rule, so
   "Back" and "Submit request" showed on step 1. Global guard added:
   `[hidden]{display:none !important}` (`assets/css/site.css`). Step flow re-verified.
2. **FIXED portal transparent sticky header** (portal doesn't load `main.js`):
   new `.nav-solid` class (`assets/css/ppi.css`) applied in `ppi/portal/index.html`.
3. **FIXED nav collisions at tiny widths**: brand wordmark hidden ≤374px;
   `.btn-nav` no-wrap moved global (homepage "Get the app" wrapped at 320).
4. **Verdict strip centered ≤940px** to match the centered hero.
5. **Status labels** (`functions/lib/status.ts`, copy only): `Cancelled by You` /
   `Cancelled by AutoClarity`. **Portal guidance** (`assets/js/ppi-portal.js`):
   refunded state states the 5–10 business-day bank timing; cancelled states
   say what to do next.
6. **Terminology**: last bare public "PPI" removed (hero fineprint, app-vs-inspection
   note, fallback mailto subject, sample-report meta/aria); "pre-purchase
   inspection (PPI)" defined once in the guarantee FAQ.
7. **A11y**: `aria-label` on the success-panel file input; structural checks
   (labels/alt/headings/skip links/tap sizes) pass on homepage, landing, portal.
8. Verified: **100 tests** (66 unit + 34 integration), `tsc --noEmit` clean,
   20 internal links OK, all header checks pass, no horizontal overflow at
   320–1440 on all customer pages, admin table scrolls within its card on phones.

Capture tooling note: use puppeteer-core against the local dev server for
screenshots — plain `chrome --headless=new --screenshot` enforces a 500px
minimum viewport and silently clips mobile captures.

## Mobile test matrix (measured on https://autoclarity-site.pages.dev)

| Width | Homepage | Landing | Intake form | Portal |
|---|---|---|---|---|
| 320 | no overflow ✓ | no overflow ✓ | single-col ✓ | — |
| 360/375/390/414 | ✓ | no overflow, 16px inputs, 61px tap targets ✓ | single-col, correct keyboards ✓ | no overflow, TZ shown ✓ |
| 768 | ✓ | ✓ | ✓ | ✓ |
| Desktop / wide | founder hero 2-col ✓ | ✓ | ✓ | admin dashboard ✓ |

Screenshots were captured in-session for verification (homepage 320 + 390, landing
390, intake 390, portal/refunded 390). Note: the browser-pane tool cannot persist
PNGs to the repo; the measured evidence above is the durable record. `docs/mobile-audit-2026-07-23/` holds this report.

## Known blockers (must clear before live customers)

1. **Notifications not delivered** — no email provider configured. Owner + customer emails are written to the `messages` table with status `recorded` but never sent. See "Notifications" in the launch checklist. **Launch blocker.**
2. **Production admin auth** — Cloudflare Access not yet configured for `/ppi/admin*` + `/api/admin*`. Required before the custom-domain cutover (the preview dev key is refused when `PPI_ENV=production`). **Launch blocker.**
3. **Business/legal readiness** — licensing, insurance, agreements review, live Stripe activation (owner-owned; see checklist).
4. **R2/photo uploads** — disabled until R2 is enabled (non-blocking; the intake→quote→schedule→pay path does not use it).

## Exact next commands (a fresh session / the owner)

```bash
cd "/Volumes/Super Storage/autoclarity-site"
npx wrangler whoami                      # confirm fboffice107@gmail.com
git log --oneline -5
npx wrangler pages deployment list --project-name autoclarity-site | head
npm run test:unit                        # 66 pass
```
Redeploy the preview after edits:
```bash
npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
```

## Rollback

- Customer domain is untouched → nothing to undo there.
- To revert the GitHub Pages production site: `git push -f origin pre-ppi-production:main` (rebuilds getautoclarity.com to `15a121c`).
- Preview checkpoint: `ppi-preview-verified-2026-07-23`.

## Important files

`functions/` (API + libs), `las-vegas-pre-purchase-inspection/` (landing + sample report),
`ppi/portal` + `ppi/admin` (customer/admin UIs), `index.html` (homepage),
`assets/css/{site,ppi}.css`, `assets/js/ppi-*.js`, `migrations/0001_init.sql`,
`wrangler.toml`, `docs/PPI_*.md`, `docs/PPI_PRODUCTION_LAUNCH_CHECKLIST.md`.
