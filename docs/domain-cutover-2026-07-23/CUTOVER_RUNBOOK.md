# getautoclarity.com → Cloudflare Pages cutover runbook

_Written 2026-07-23. Status: **CUTOVER NOT PERFORMED — stopped at the
Cloudflare Access safety gate.** Everything else is ready and verified._

## Why the cutover stopped

The session rule: the custom domain must not be attached until production
authentication (Cloudflare Access) is verified for `/inspector*`,
`/api/inspector*`, `/ppi/admin*`, `/api/admin*`. Verified this session:

- `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN` are **not set** on the Pages
  project (secret list has only ADMIN_DEV_KEY, ADMIN_NOTIFY_EMAIL,
  PUBLIC_BASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  TURNSTILE_SECRET_KEY).
- The CLI token has **no Zero Trust scope** (Access API → authentication
  error; re-confirmed live) — the Access app can only be created in the
  owner's dashboard.

The code fails closed (production refuses the dev key; admin/inspector →
503/401 without Access — `tests/unit/auth.test.ts`), so nothing would be
*exposed*, but the owner would also be locked out of admin, and the session
rule treats unverified Access as a hard stop. Correctly so.

## What is already done (no action needed)

- Latest app (incl. neon grid) deployed: https://autoclarity-site.pages.dev
- `www → apex` **301 preserving path + query** is implemented in the app
  itself (`functions/lib/canonical.ts`, unit-tested, verified live via Host
  header) — no zone Redirect Rules needed.
- pages.dev + deployment aliases stay **noindex even in production**
  (middleware host check) — no duplicate-content indexing after cutover.
- Canonical tags/OG/sitemap/robots already point at `https://getautoclarity.com`.
- Cloudflare Pages serves HTML **and** assets with
  `cache-control: max-age=0, must-revalidate` + ETag — the stale-version
  problem GitHub Pages had (max-age=600) disappears after cutover.
- Cross-origin form → hosted API verified again on the current deployment
  (`PPI-260724-35MR` stored in D1, duplicate-safe, visible in admin).
- Full DNS snapshot + exact rollback: `PRE_CHANGE_CHECKPOINT.md` (same dir).

## OWNER STEP 1 — Cloudflare Access (~10 min, dashboard)

Follow `docs/PPI_ACCESS_SETUP.md` §1–§2 exactly:

1. https://one.dash.cloudflare.com → account fboffice107@gmail.com →
   Access → Applications → **Add an application → Self-hosted**.
2. Name `AutoClarity admin + inspector`; add ALL FOUR public hostnames on
   getautoclarity.com: `/ppi/admin*`, `/api/admin*`, `/inspector*`,
   `/api/inspector*`.
3. Policy `Owner only` → Allow → Emails → `fboffice107@gmail.com`.
   One-time PIN is enough. Save.
4. Copy the **AUD tag** (app Overview) and your team domain
   (`<team>.cloudflareaccess.com`), then:
   ```bash
   cd "/Volumes/Super Storage/autoclarity-site"
   npx wrangler pages secret put CF_ACCESS_AUD --project-name autoclarity-site
   npx wrangler pages secret put CF_ACCESS_TEAM_DOMAIN --project-name autoclarity-site
   ```

## OWNER STEP 2 — production env + redeploy

```bash
cd "/Volumes/Super Storage/autoclarity-site"
# 1) point PUBLIC_BASE_URL at the real domain (currently the pages.dev URL):
npx wrangler pages secret put PUBLIC_BASE_URL --project-name autoclarity-site
#    → enter: https://getautoclarity.com
# 2) switch the app to production mode: edit wrangler.toml → PPI_ENV = "production"
#    (commit it), then redeploy:
npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
```

Note: production mode makes pages.dev admin/inspector fail closed (503)
until Step 1's secrets are live — do Step 1 first. Public pages, portal and
the form keep working throughout. pages.dev stays noindex (host check).

## OWNER STEP 3 — attach the custom domains (the actual cutover)

Cloudflare dashboard → Workers & Pages → `autoclarity-site` → **Custom
domains** → *Set up a custom domain*:

1. Add `getautoclarity.com` → Cloudflare shows the DNS change it will make
   (replacing the four GitHub A records with the Pages target) → **Activate**.
2. Add `www.getautoclarity.com` the same way (replaces the `www` CNAME).
3. Wait for both to show **Active** and certificates **Issued** (minutes).

Only the apex A records and the `www` CNAME may change. **MX ×3 + SPF TXT
(Cloudflare Email Routing) must remain untouched** — the Pages flow does not
touch them, but verify in the DNS tab afterwards against
`PRE_CHANGE_CHECKPOINT.md`.

## OWNER STEP 4 — the authentication test (do not skip)

`docs/PPI_ACCESS_SETUP.md` §3, on https://getautoclarity.com:
incognito `/ppi/admin/` must show the Access login; PIN as
fboffice107@gmail.com must open admin; bare curl of `/api/admin/overview`
must NOT be 200; dev key must be refused; repeat for `/inspector/`.

## Post-cutover smoke test (owner or next session)

- https://getautoclarity.com/ → latest homepage (neon grid live, new asset
  hashes; hard-reload + incognito).
- https://www.getautoclarity.com/anything?x=1 → **301** to the same path +
  query on the apex.
- `/ppi`, `/pre-purchase-inspection` → 301 to the landing page.
- Landing form submit → real `PPI-…` ref (D1, admin).
- privacy/terms, sample report, portal magic link, sitemap.xml, robots.txt,
  App Store links.
- `curl -sI https://getautoclarity.com/` → **no** `x-robots-tag` (indexable);
  `curl -sI https://autoclarity-site.pages.dev/` → still noindex.

## Rollback

Exact procedure + full DNS record table: `PRE_CHANGE_CHECKPOINT.md`.
Summary: remove both custom domains from the Pages project, restore the four
GitHub A records + `www` CNAME (DNS-only), verify `server: GitHub.com`.
GitHub Pages (branch `main`, CNAME file, cert to 2026-09-11) is left intact
as the standing rollback target; tag `pre-ppi-production` additionally
restores the pre-PPI content if ever needed.
