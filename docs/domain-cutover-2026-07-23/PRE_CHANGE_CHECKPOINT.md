# Pre-change checkpoint — single-domain cutover session (2026-07-23)

Recorded BEFORE any change in this session. This is the authoritative rollback
reference. Verified live (dig against `cesar.ns.cloudflare.com`, curl, GitHub
API, wrangler) — not copied from prior docs.

## Git

| Item | Value |
|---|---|
| Branch | `feature/las-vegas-ppi-portal` |
| HEAD | `6083b0c` — Mobile touch glow on the two public pages |
| Remote branch | `origin/feature/las-vegas-ppi-portal` = `6083b0c` (in sync) |
| `origin/main` (GitHub Pages live) | `a907ebf` |
| Rollback tags | `pre-ppi-production` → `15a121c`; `ppi-preview-verified-2026-07-23` |
| Working tree | clean at session start |

## DNS (zone `getautoclarity.com`, id `3e82c2a7eb49c6b5799f72c7f30d1673`, Cloudflare NS `cesar`/`kallie.ns.cloudflare.com`)

Authoritative answers at session start (all records DNS-only / unproxied —
`dig` returns the target IPs directly, not Cloudflare proxy IPs):

| Type | Name | Content | Notes |
|---|---|---|---|
| A | getautoclarity.com | 185.199.108.153 | GitHub Pages |
| A | getautoclarity.com | 185.199.109.153 | GitHub Pages |
| A | getautoclarity.com | 185.199.110.153 | GitHub Pages |
| A | getautoclarity.com | 185.199.111.153 | GitHub Pages |
| CNAME | www.getautoclarity.com | fboffice107-png.github.io | GitHub Pages |
| MX | getautoclarity.com | 32 route3.mx.cloudflare.net | **Email Routing — PRESERVE** |
| MX | getautoclarity.com | 47 route2.mx.cloudflare.net | **Email Routing — PRESERVE** |
| MX | getautoclarity.com | 54 route1.mx.cloudflare.net | **Email Routing — PRESERVE** |
| TXT | getautoclarity.com | `v=spf1 include:_spf.mx.cloudflare.net ~all` | **SPF — PRESERVE** |

No AAAA, no CAA, no `_dmarc`, no Resend/DKIM records, no
`_github-pages-challenge-*` TXT exist yet (probed authoritatively).

The wrangler OAuth token has `zone (read)` but **not** `dns_records read/write`
— a full zone export via API returns auth error 10000; the table above is the
complete authoritative public view of every name known to be in use.
DNS record changes can only be made from the Cloudflare dashboard (owner) or
by the Pages custom-domain flow itself.

## What serves what (verified by curl at session start)

| Host | Serves | Evidence |
|---|---|---|
| getautoclarity.com | GitHub Pages, `main` = `a907ebf` | `server: GitHub.com`, last-modified 2026-07-22, `cache-control: max-age=600` |
| www.getautoclarity.com | GitHub Pages **301 → apex** (GitHub's own canonical redirect) | `HTTP/2 301`, `location: https://getautoclarity.com/` |
| autoclarity-site.pages.dev | Cloudflare Pages deployment `bd27679d` (commit `6083b0c`) | full security headers, `x-robots-tag: noindex, nofollow`, HTML+assets `max-age=0, must-revalidate` |

## GitHub Pages configuration (GitHub API)

- Source: branch `main`, path `/`; CNAME `getautoclarity.com`; status `built`.
- HTTPS cert covers apex + www, expires 2026-09-11; `https_enforced: false`.
- Repo file `CNAME` contains `getautoclarity.com`.

## Cloudflare (account `4da1d0fcf199fe1e467359d304bd02fb`, fboffice107@gmail.com)

- Pages project `autoclarity-site`; production deployments from `--branch main`
  direct uploads. Latest at checkpoint: `bd27679d` (commit `6083b0c`).
- **No custom domains attached to the Pages project yet.**
- Pages production secret NAMES (values never recorded): `ADMIN_DEV_KEY`,
  `ADMIN_NOTIFY_EMAIL`, `PUBLIC_BASE_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`.
- **`CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN` are NOT set** → Cloudflare
  Access is not wired; production admin/inspector would fail closed (503).
- `wrangler.toml` vars: `PPI_ENV=preview`, `PPI_MODE=request`,
  `PAYMENTS_ENABLED=false`, `STRIPE_ENV=test`, `BOOKING_ENABLED=true`,
  `UPLOADS_ENABLED=false`, test Turnstile site key,
  `PUBLIC_FORM_ORIGINS=https://getautoclarity.com,https://www.getautoclarity.com`.
- D1 `autoclarity_ppi` (`0ae44d57-1a4c-4fd9-96e9-629b1570af26`); R2 disabled.
- Token scopes relevant here: `pages (write)`, `zone (read)`, no Zero Trust
  scope, no `dns_records` scope.

## TLS at checkpoint

- Apex/www: GitHub Pages certificate (valid to 2026-09-11), HTTPS works,
  not enforced (HTTP not auto-redirected by GitHub).
- pages.dev: Cloudflare cert, HSTS via `_headers`.

## Canonicals / SEO at checkpoint

- Homepage + PPI canonical tags → `https://getautoclarity.com/...` (already
  correct for the target state).
- pages.dev sends `x-robots-tag: noindex, nofollow` on every page
  (`PPI_ENV=preview` middleware) — verified.
- `sitemap.xml` + `robots.txt` reference getautoclarity.com.

## Tests at checkpoint

`npm test` → **178 pass** (106 unit + 72 integration) at `6083b0c`.

## EXACT ROLLBACK INSTRUCTIONS (any point after cutover)

Rollback = point the domain back at GitHub Pages. GitHub Pages deployment,
branch `main`, CNAME file and certificate are all left intact by this session.

1. Cloudflare dashboard → Workers & Pages → `autoclarity-site` → Custom
   domains → **remove** `getautoclarity.com` and `www.getautoclarity.com`.
2. Cloudflare dashboard → getautoclarity.com → DNS → restore the table above
   exactly:
   - Apex `A` records → `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153` (DNS-only, TTL Auto).
   - `www` `CNAME` → `fboffice107-png.github.io` (DNS-only, TTL Auto).
   - MX ×3 + SPF TXT above must still be present (they are untouched by the
     Pages flow; verify anyway).
3. Do NOT touch MX/SPF/any other record.
4. Verify: `dig +short getautoclarity.com A` returns the four 185.199.* IPs;
   `curl -sI https://getautoclarity.com/` shows `server: GitHub.com`.
5. TLS: GitHub's cert (valid to 2026-09-11) resumes serving; if it was
   removed by GitHub in the interim, re-add the custom domain in the repo's
   GitHub Pages settings and wait for cert re-issue.
6. Cache: GitHub Pages serves `max-age=600` — allow up to 10 min for edge
   staleness; hard-reload to verify.
7. Content rollback (independent of DNS): `git push -f origin
   pre-ppi-production:main` restores the pre-PPI site (`15a121c`) — only if
   the owner explicitly wants the older content.
