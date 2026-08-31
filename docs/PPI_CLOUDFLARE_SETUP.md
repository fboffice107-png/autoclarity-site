# Cloudflare Setup — reference for a new isolated environment

> The AutoClarity production Pages project, domains, D1 database, R2 bucket,
> Turnstile, email secrets, and Access configuration already exist. Do not run
> the bootstrap script against production. This guide is retained for creating
> an isolated preview or disaster-recovery environment.

The repo is ready; Cloudflare needs one-time resource creation. Everything here
happens in the Cloudflare account that already runs DNS for getautoclarity.com.

## 0. Authenticate wrangler (one time, ~1 minute)

```bash
cd autoclarity-site
npx --no-install wrangler login   # opens the browser; approve access
```

## 1. Create isolated resources + first preview deploy

```bash
AC_PREVIEW_PROJECT=autoclarity-site-preview \
AC_PREVIEW_DB=autoclarity-ppi-preview \
AC_PREVIEW_BUCKET=autoclarity-ppi-uploads-preview \
AC_PREVIEW_BRANCH=review \
AC_PREVIEW_PUBLIC_BASE_URL=https://review.autoclarity-site-preview.pages.dev \
CONFIRM_ISOLATED_PREVIEW=YES \
./scripts/cloudflare-setup.sh
```

The script:
1. requires lowercase resource names ending in `-preview`, a non-production
   branch, an exact matching `*.pages.dev` URL, and explicit confirmation,
2. creates or locates the distinctly named preview D1/R2/Pages resources,
3. writes a gitignored generated config under `.wrangler/preview/`, leaving
   `wrangler.local.toml` untouched,
4. applies migrations only to the named preview D1,
5. deploys only the named preview project and branch.

Run the same command with `--validate-only` to exercise every local guard without
writing the generated config, contacting Cloudflare, or changing any resource.

Manual equivalents are inside the script if you prefer clicking the dashboard.

## 2. Preview secrets

Preview needs only test-grade values. In the dashboard (Pages → your preview project
→ Settings → Environment variables → **Preview**) or via
`npx --no-install wrangler pages secret put NAME --project-name <preview-project>`:

| Name | Preview value |
|---|---|
| `ADMIN_DEV_KEY` | a long random string, e.g. `openssl rand -base64 32` |
| `TURNSTILE_SECRET_KEY` | `1x0000000000000000000000000000000AA` (official always-pass test secret) — or a real key, see §3 |
| `STRIPE_SECRET_KEY` | `sk_test_...` from Stripe test mode (see PPI_STRIPE_SETUP.md) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` for the preview webhook endpoint |
| `RESEND_API_KEY` | optional; without it emails are recorded in the DB, not sent |
| `EMAIL_FROM` | e.g. `AutoClarity <notify@getautoclarity.com>` (Resend-verified) |
| `ADMIN_NOTIFY_EMAIL` | your inbox |

Also set the **Preview** plain variable `PUBLIC_BASE_URL` to the branch preview
URL once known (e.g. `https://review.autoclarity-site-preview.pages.dev`). The
host must belong to the isolated preview project, never the production Pages
project.

## 3. Turnstile (production-grade bot protection)

Dashboard → Turnstile → Add site → domain `getautoclarity.com` (add the
`pages.dev` preview hostname too) → widget type "Managed". Put the **site key**
in the Pages env var `TURNSTILE_SITE_KEY` and the **secret key** in the
`TURNSTILE_SECRET_KEY` secret. Until then, the shipped test keys pass every
challenge — fine for preview, never for production.

## 4. Cloudflare Access in front of the preview + admin

Two applications (Zero Trust → Access → Applications → Self-hosted):

1. **Preview lock (recommended):** application on
   the preview project's `*.pages.dev` hostname covering `/*` — policy: allow only your email.
   This makes the whole preview owner-only. (Pages → Settings → also enable
   "Access policy" toggle for preview deployments if offered — same effect,
   one click.)
2. **Admin lock (required before production):** application on
   `getautoclarity.com/ppi/admin*` AND `getautoclarity.com/api/admin*` —
   policy: allow only your email.

After creating the admin application, copy its **AUD tag** and team domain into
Pages env vars `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` (production env).
The API then verifies the Access JWT on every admin call; without Access
configured, production admin fails closed (503) rather than open.

## 5. Branch previews

The isolated project created by the script is direct-upload. Repeat deployments
must use its generated `.wrangler/preview/wrangler.toml` configuration, never
`wrangler.local.toml` and never the production project. Preview deployments send
`X-Robots-Tag: noindex` from Cloudflare, and the app adds its own noindex
whenever `PPI_ENV != production`.

## 6. What stays untouched in a new preview

- The existing production Pages deployment and custom domains.
- Production D1/R2 data and production secrets.
- DNS records. A preview needs only its `*.pages.dev` hostname.
