# AutoClarity Pre-Purchase Inspection Portal — Session Handoff

_Last updated: 2026-07-23 (neon energized-grid + single-domain cutover prep).
Read this plus `docs/PPI_CLOUDFLARE_PREVIEW_STATUS.md`,
`docs/PPI_PRODUCTION_LAUNCH_CHECKLIST.md`, `docs/PPI_ACCESS_SETUP.md`,
`docs/domain-cutover-2026-07-23/CUTOVER_RUNBOOK.md` before making any
production change._

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
| Tests | **186 pass** — 114 unit + 72 integration; `tsc` clean; 20 links OK; header checks pass |
| Rollback tags | `pre-ppi-production` → `15a121c` (GitHub Pages prod); `ppi-preview-verified-2026-07-23` |

## THIS SESSION (2026-07-23, third pass — neon grid + cutover prep)

### 1. Neon energized-grid pointer effect SHIPPED
The faint cursor blob (5.5%-alpha radial, never touching the grid) was
replaced: a second copy of the 64px technical grid in vivid electric blue
(`.neon-grid`) is revealed through a per-frame mask of the pointer position
plus a ≤6-point fading trail (550–620ms), so the actual grid lines
illuminate and trail behind the pointer. Capability gates (`hover+fine` /
`coarse` — **no viewport-width rule**), touch follows the finger with passive
listeners and fades ~700ms after lift, form focus fades everything to 0,
idle dims to 0.3 and stops all rAF work, reduced-motion never creates the
elements. Full effect only on `<body data-fx-full>` (homepage + LV landing);
sample report keeps bloom only; portal/report/inspector/admin/legal
untouched. 60–61fps in storms; native scroll proven. Full root-cause,
implementation, measurements + 70-file before/after evidence (screenshots at
1024–1920 + 7 touch widths, 2 webm recordings, hosted pages.dev proof):
`docs/neon-grid-2026-07-23/REPORT.md`.

### 2. Single-domain canonicalization implemented IN the app
`functions/lib/canonical.ts` + middleware: any request on
`www.getautoclarity.com` → **301 to the apex preserving path + query**
(unit-tested incl. portal tokens/UTM; verified live via Host header), and
**pages.dev/aliases stay noindex even in production** — no zone Redirect
Rules or extra DNS records needed at cutover.

### 3. Custom-domain cutover PREPARED but STOPPED at the Access gate
Verified live: `CF_ACCESS_AUD`/`CF_ACCESS_TEAM_DOMAIN` secrets absent and
the CLI token has no Zero Trust scope → production authentication for the
four private surfaces cannot be verified from here → per the session's stop
conditions the domain was **not** attached. getautoclarity.com still serves
GitHub Pages (`main` = `a907ebf`); www still 301s to apex via GitHub. A full
pre-change checkpoint (authoritative DNS table incl. the Email-Routing
MX/SPF records that must never move, GitHub Pages config, exact rollback)
and the click-by-click owner cutover runbook are in
`docs/domain-cutover-2026-07-23/`. Cache behavior after cutover is already
solved: Pages serves HTML **and** assets `max-age=0, must-revalidate` + ETag
(GitHub's `max-age=600` staleness disappears).

### 4. Hosted redeploy + re-proof (pages.dev)
Deployed the branch (`--branch main` direct upload). Verified on the hosted
stack: asset hashes match local, neon grid works (hosted screenshots), noindex
intact, `/ppi`+`/pre-purchase-inspection` 301s, blocked paths 404, admin 401
without key, and a fresh cross-origin intake stored durably
(`PPI-260724-35MR`, duplicate-safe, visible in admin). Stripe untouched:
`STRIPE_ENV=test`, `PAYMENTS_ENABLED=false`, no live keys. Email unchanged:
messages record (`recorded`); **no delivery is claimed** — Resend connection
remains owner checklist §B.

## PREVIOUS SESSION (2026-07-23, second pass)

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

## Known blockers before live customers (updated 2026-07-23 third pass)

1. **Cloudflare Access** — owner: `docs/PPI_ACCESS_SETUP.md` (~10 min).
   **This is now the ONLY blocker for the custom-domain cutover** — runbook:
   `docs/domain-cutover-2026-07-23/CUTOVER_RUNBOOK.md`.
2. **Email provider connection** — owner: launch checklist §B (~15 min).
3. **Live form fix on getautoclarity.com** — owner: publish `main` (§B2), or
   skip straight to the cutover (which supersedes it — same code, same fix).
4. **Business/legal + live Stripe** — owner + counsel (checklist §A/§C).
5. **R2** (optional, photos) — owner dashboard enable (`docs/PPI_R2_SETUP.md`).

## Exact next commands (fresh session / owner)

```bash
cd "/Volumes/Super Storage/autoclarity-site"
npx wrangler whoami
git log --oneline -3
npm test                                 # 114 unit + 72 integration
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
