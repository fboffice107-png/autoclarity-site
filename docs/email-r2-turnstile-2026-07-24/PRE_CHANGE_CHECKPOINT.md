# Pre-change checkpoint — email / R2 / Turnstile completion session (2026-07-24)

Rollback reference taken BEFORE any Phase 1–3 infrastructure change of the
final non-Stripe production completion session. Nothing below had been
modified when this file was written.

## Repository

- Branch: `feature/las-vegas-ppi-portal`, clean tree, fully pushed.
- HEAD: `6d40311` ("LIVE: getautoclarity.com cutover completed and verified 2026-07-24").
- Tags intact: `pre-ppi-production` (=`15a121c`), `ppi-preview-verified-2026-07-23`.
- Tests at checkpoint: **190 pass** (118 unit + 72 integration).

## Hosted production (Cloudflare Pages `autoclarity-site`)

- Latest Production deployment: `f42c4431` (source commit `3a8a70b`,
  production-mode code, serving getautoclarity.com).
- `PPI_ENV=production`, `PPI_MODE=request`, `PAYMENTS_ENABLED=false`,
  `STRIPE_ENV=test`, `UPLOADS_ENABLED=false`,
  `TURNSTILE_SITE_KEY=1x00000000000000000000AA` (always-pass test key).
- Secrets present (names only): ADMIN_DEV_KEY, ADMIN_NOTIFY_EMAIL,
  CF_ACCESS_AUD, CF_ACCESS_TEAM_DOMAIN, PUBLIC_BASE_URL, STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET, TURNSTILE_SECRET_KEY.
  **Absent:** RESEND_API_KEY, EMAIL_FROM (emails record with status
  `recorded`, none delivered).
- Cloudflare Access live: all four private surfaces
  (`/ppi/admin*`, `/api/admin*`, `/inspector*`, `/api/inspector*`) 302 to
  the `curly-wildflower-604c.cloudflareaccess.com` login. Public pages
  untouched. pages.dev noindex; apex indexable.
- R2 still DISABLED at the account level (API error 10042).

## Authoritative DNS at checkpoint (dig @1.1.1.1, 2026-07-24)

| Record | Value |
|---|---|
| A getautoclarity.com | 104.21.52.188, 172.67.202.220 (Cloudflare Pages) |
| AAAA getautoclarity.com | 2606:4700:3037::ac43:cadc, 2606:4700:3031::6815:34bc |
| www | Cloudflare-proxied to the same Pages targets |
| MX getautoclarity.com | route1/2/3.mx.cloudflare.net (Email Routing — MUST NEVER MOVE) |
| TXT getautoclarity.com | `v=spf1 include:_spf.mx.cloudflare.net ~all` (Email Routing SPF — MUST NEVER BE REPLACED) |
| TXT _dmarc | none |
| TXT resend._domainkey | none |
| send.getautoclarity.com (MX/TXT) | none |

Resend domain verification must ADD records only (its own subdomain
MX/SPF + DKIM at `resend._domainkey` or similar). The two Email-Routing
rows above must remain byte-identical.

## Rollback

- **Email (Phase 1):** delete only the Resend-added DNS records; delete
  the RESEND_API_KEY / EMAIL_FROM secrets
  (`npx wrangler pages secret delete <NAME> --project-name autoclarity-site`).
  Emails return to honest `recorded` status; requests unaffected.
- **R2 (Phase 2):** set `UPLOADS_ENABLED=false` + re-comment the
  `[[r2_buckets]]` block in `wrangler.toml`, redeploy. Bucket can stay
  (private, unused, free).
- **Turnstile (Phase 3):** restore `TURNSTILE_SITE_KEY` to the test value
  above and re-put the test secret `1x0000000000000000000000000000000AA`,
  redeploy.
- **Whole-site:** unchanged from `docs/domain-cutover-2026-07-23/PRE_CHANGE_CHECKPOINT.md`
  (remove the two Pages custom domains → GitHub Pages `main`=`a907ebf`).
- **Code:** any session commit reverts cleanly on top of `6d40311`.
