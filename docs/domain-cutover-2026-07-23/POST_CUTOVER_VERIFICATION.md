# Post-cutover verification — 2026-07-24

**getautoclarity.com is now served by Cloudflare Pages (deployment of commit
`f9d4bea`, PPI_ENV=production).** Attached by the owner via the Pages
custom-domain flow; every check below ran against the live public domains.

## DNS

| Record | Before | After | Status |
|---|---|---|---|
| A getautoclarity.com ×4 | 185.199.108–111.153 (GitHub) | Cloudflare (104.21.52.188 / 172.67.202.220) | **changed by the Pages flow** |
| CNAME www | fboffice107-png.github.io | Cloudflare (same targets) | **changed by the Pages flow** |
| MX ×3 (route1–3.mx.cloudflare.net) | present | present | **preserved** |
| TXT SPF (`v=spf1 include:_spf.mx.cloudflare.net ~all`) | present | present | **preserved** |

No other record was touched. TLS: valid cert `CN=getautoclarity.com`
(Google Trust Services WE1, expires 2026-10-22).

## Routing / canonicalization (live)

- Apex `/` → 200, serves the **AutoClarity homepage** (not the PPI page),
  `cache-control: max-age=0, must-revalidate` (no stale versions), indexable
  (no x-robots-tag).
- `www.getautoclarity.com/ppi/portal/?t=…&utm_source=sms` → **301** to the
  identical path+query on the apex. Root www → 301 apex.
- `/ppi`, `/PPI`, `/Ppi`, `/pre-purchase-inspection` (+query) → 301 →
  `/las-vegas-pre-purchase-inspection/` (query preserved). Loop check:
  `www…/PPI?x=1` → 2 hops → 200. `privacy.html`/`terms.html` → 308 → clean
  URLs → 200. robots.txt + sitemap.xml 200; App Store link 200.
- `autoclarity-site.pages.dev` → still **noindex** (host check).
- Deployed asset hashes (main.js, site.css, ppi-form.js) byte-match the git
  checkout.

## Cloudflare Access (live)

Anonymous requests to ALL FOUR private surfaces 302 to the Access login:
`/ppi/admin/`, `/inspector/`, `/api/admin/overview`, `/api/inspector/overview`.
The production `ADMIN_DEV_KEY` is intercepted the same way (302 — never
honored). Public homepage/landing/portal/legal are NOT intercepted.
Owner login test (incognito + one-time PIN as fboffice107@gmail.com): to be
confirmed by the owner — see runbook OWNER STEP 4.

## Public form (live, same-origin)

`PPI-260724-UUX2` submitted on the apex → stored in D1 (`submitted`),
duplicate resubmit returned `duplicate:true` with the same ref and **rotated
the magic link** (old token correctly 401), current token → portal 200 with
correct vehicle. Emails recorded honestly (`recorded`, not sent):
`request_received` → customer, `owner_notify` → owner. No mailto anywhere.

## Customer report surface (live)

PAIDOK fixture token: portal 200 → report **version 2 (amendment,
2-entry history)** → PDF 200 (`%PDF-`, 25,863 bytes) — HTML and PDF render
from the same immutable snapshot. Garbage token → 401.

## Neon grid on the live domain (headless Chrome)

- Desktop 1440: `.neon-grid` active (opacity ≈1), pointer-following mask,
  `data-fx-full` on, no overflow.
- Form focus: both layers fade to ~0.
- Touch 390: active during touch (0.85), **0 after lift**, swipe scrolled
  natively (0→240), no overflow.
- Reduced motion: neither element created.
- Screenshots: `screenshots/live-apex-{home,inspection}-pointer-1440.png`,
  `screenshots/live-apex-touch-390.png`.

## Tests

**190 pass** (118 unit + 72 integration), `tsc` clean, 20 links OK, header
checks pass (checks run against the preview-mode staging server on :8790).

## Still true / unchanged

- `STRIPE_ENV=test`, `PAYMENTS_ENABLED=false`, no live keys.
- Email delivery NOT claimed — provider connection = checklist §B.
- R2 disabled → uploads honestly `uploads_disabled`.
- Turnstile still on always-pass TEST keys (form works; real keys =
  checklist §D14 hardening).
- Rollback unchanged: `PRE_CHANGE_CHECKPOINT.md` (remove the two custom
  domains, restore 4×A + www CNAME; GitHub Pages `main`=`a907ebf` intact).
