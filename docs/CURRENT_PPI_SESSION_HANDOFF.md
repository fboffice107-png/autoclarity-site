# AutoClarity Pre-Purchase Inspection Portal — Session Handoff

_Last updated: 2026-07-23 (final pre-launch infrastructure + visual pass).
Read this plus `docs/PPI_CLOUDFLARE_PREVIEW_STATUS.md`,
`docs/PPI_PRODUCTION_LAUNCH_CHECKLIST.md`, `docs/PPI_ACCESS_SETUP.md`,
`docs/PPI_INSPECTOR_GUIDE.md` before making any production change._

## Snapshot

| Item | Value |
|---|---|
| Repository | `autoclarity-site` (`/Volumes/Super Storage/autoclarity-site`) |
| Branch | `feature/las-vegas-ppi-portal` |
| Remote | `origin` = github.com/fboffice107-png/autoclarity-site |
| Cloudflare Pages project | `autoclarity-site` |
| Hosted preview | https://autoclarity-site.pages.dev (noindex; **not** the customer domain) |
| Custom domain | **UNCHANGED** — getautoclarity.com still GitHub Pages (`main`). No DNS change made. |
| D1 | `autoclarity_ppi` (`0ae44d57…af26`), migrations 0001+0002 applied |
| R2 | **Still not enabled on the account** (re-verified: API error 10042, dashboard-only). Feature-flagged off; honest `uploads_disabled`. Steps: `docs/PPI_R2_SETUP.md` |
| Stripe | test/sandbox only; `STRIPE_ENV=test`, `PAYMENTS_ENABLED=false` |
| Email | **Adapter complete + proven vs mock provider (tests)**; hosted = `recorded` until owner connects Resend — exact steps in launch checklist §B. `ADMIN_NOTIFY_EMAIL` set on hosted preview this session. |
| Admin/inspector security | Preview: `ADMIN_DEV_KEY`. Production: Cloudflare Access required — full owner walkthrough + test + rollback in `docs/PPI_ACCESS_SETUP.md`; fail-closed matrix covered by `tests/unit/auth.test.ts` |
| Tests | **178 pass** — 106 unit + 72 integration; `tsc` clean; 20 links OK; header checks pass |
| Rollback tags | `pre-ppi-production` → `15a121c` (GitHub Pages prod); `ppi-preview-verified-2026-07-23` |

## THIS SESSION (2026-07-23, second pass)

### 1. Phase 1 — inspector system re-verified, untouched
Hosted preview matched commit `62f5d79` (asset hashes), auth gates held
(401/200), full publish cycle re-proven on the hosted stack: start (duplicate
taps resume the same report), 104 checklist items, autosave + stale-seq 409,
publish gates (wrong ref 422, missing summary blocks), portal report + 7-page
on-demand PDF, published lock 423 + remote DB trigger, amendment (customer
kept v1 until v2 published). **The report system was not rebuilt.**

### 2. Public request workflow FIXED (the mailto bug)
Root cause: getautoclarity.com is static GitHub Pages → `/api/*` 404 →
`ppi-form.js` set `staticMode` → submit built a `mailto:` and **claimed
success while storing nothing**. Fix (all verified):
- `ppi-form.js`: same-origin API first, automatic fallback to the hosted
  Cloudflare API (`https://autoclarity-site.pages.dev`); the mailto path is
  **deleted**. Success (real `PPI-…` ref + absolute portal link) renders only
  after the API stored the request in D1; duplicate submissions show the
  existing ref with an explanatory note; API unreachable → honest "NOT
  submitted" message, answers kept on-device, retry + support contact
  (`fallbackShell`, rewritten copy).
- Server: `functions/lib/cors.ts` + middleware — CORS **only** for
  `/api/ppi/*` and `/api/portal/upload`, **only** from `PUBLIC_FORM_ORIGINS`
  (getautoclarity.com + www). Admin/inspector: OPTIONS 405, never CORS.
  `originAllowed` gained the allowlist for those same public endpoints.
- Proof: browser E2E on the dev stack (submit → ref `PPI-260724-5N4E` → in
  admin; duplicate → same ref + note; static-sim → honest failure, no email
  app, draft preserved) and live on the hosted preview via curl with real
  Origin headers (204 preflight, cross-origin store `PPI-260724-TXVX`,
  foreign origin 403). **The live site still runs the old JS until the owner
  publishes `main` — one-command step in launch checklist §B2.**

### 3. Email delivery COMPLETE in code (launch checklist §B rewritten)
- Missing owner notices added: slot selected, unpaid cancellation, refund
  completed. `request_received` now carries the vehicle summary. Webhook +
  portal emails carry dedupe keys (belt-and-braces on top of the
  `stripe_events` replay guard).
- `RESEND_API_BASE` test-only override (ignored in production) + a mock
  Resend in the integration harness prove the REAL send path: payload,
  `sent` + provider id recorded, provider 500 → request intact + `failed`
  recorded, no duplicate emails after webhook replays.
- Hosted: customer + owner messages both record (`recorded`) — they start
  sending the moment the owner completes §B (Resend account, domain DNS
  records, 2 secrets, redeploy, live test at fboffice107@gmail.com).
  **Do not claim delivery works until that live test passes.**

### 4. Cloudflare Access — prepared to the last owner click
`docs/PPI_ACCESS_SETUP.md` (new): exact app + policy setup for all four
private surfaces, AUD/team-domain wiring, the **authentication test** to run
at cutover, and lockout **rollback**. CLI cannot do it (no Zero Trust scope —
verified). New `tests/unit/auth.test.ts` (7 tests) proves fail-closed:
production refuses the dev key, 503 until Access configured, JWT
audience/signature refusal.

### 5. R2 — still owner-gated
Account-level enable required (API error 10042). Docs refreshed. Everything
works without it; photo path fully covered by tests against local R2.

### 6. Premium visual depth pass (homepage + landing)
Near-black navy foundation (`--bg #04070f`), fixed-layer ambient blue glows +
64px technical grid (site-wide, one composited layer), fine blue card-edge
highlights via `--shadow-card`, desktop nav hover/active underline (new
scroll-spy), desktop-only cursor-following glow that **fades while any form
field is focused**, reduced-motion + mobile static fallbacks. No overflow at
320–1440 (8 widths, asserted). 33 before/after screenshots + full report:
`docs/visual-polish-2026-07-23/`. Legal pages (light theme) unaffected.

## Known blockers before live customers (unchanged list, updated status)

1. **Email provider connection** — owner: launch checklist §B (~15 min).
2. **Live form fix on getautoclarity.com** — owner: publish `main` (§B2).
3. **Cloudflare Access** — owner: `docs/PPI_ACCESS_SETUP.md` (~10 min).
4. **Business/legal + live Stripe** — owner + counsel (checklist §A/§C).
5. **R2** (optional, photos) — owner dashboard enable (`docs/PPI_R2_SETUP.md`).

## Exact next commands (fresh session / owner)

```bash
cd "/Volumes/Super Storage/autoclarity-site"
npx wrangler whoami
git log --oneline -3
npm test                                 # 106 unit + 72 integration
npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
```

## Rollback

- Customer domain untouched → nothing to undo.
- GitHub Pages production revert: `git push -f origin pre-ppi-production:main`.
- This session's server changes are additive (CORS allowlist, extra
  notifications, test hooks); no schema changes.

## Important files (this session)

`functions/lib/cors.ts` (new), `functions/_middleware.ts`,
`functions/lib/{email,util,types}.ts`, `functions/api/ppi/requests.ts`,
`functions/api/portal/{action,upload}.ts`, `functions/api/stripe/webhook.ts`,
`assets/js/{ppi-form,main}.js`, `assets/css/site.css`,
`las-vegas-pre-purchase-inspection/index.html`, `wrangler.toml`
(`PUBLIC_FORM_ORIGINS`), `tests/unit/{auth,cors}.test.ts` (new),
`tests/integration/{flow.test.ts,globalSetup.ts}`,
`scripts/capture-screens.mjs` (new), `docs/PPI_ACCESS_SETUP.md` (new),
`docs/visual-polish-2026-07-23/` (new). Everything from the prior handoff
(inspector workspace, booking/payments) is unchanged.
