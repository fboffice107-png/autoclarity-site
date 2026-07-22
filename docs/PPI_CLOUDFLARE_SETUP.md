# Cloudflare Setup — exact steps

The repo is ready; Cloudflare needs one-time resource creation. Everything here
happens in the Cloudflare account that already runs DNS for getautoclarity.com.

## 0. Authenticate wrangler (one time, ~1 minute)

```bash
cd autoclarity-site
npx wrangler login        # opens the browser; approve access
```

## 1. Create resources + first preview deploy (scripted)

```bash
./scripts/cloudflare-setup.sh
```

The script:
1. creates the D1 database `autoclarity_ppi` and patches `wrangler.toml` with
   the real `database_id`,
2. creates the private R2 bucket `autoclarity-ppi-uploads`,
3. creates the Pages project `autoclarity-site` (production branch `main` — we
   never deploy it; previews come from the feature branch),
4. applies migrations to the remote preview DB,
5. deploys the current branch as a **preview** (`--branch feature/las-vegas-ppi-portal`),
6. prints the `https://<hash>.autoclarity-site.pages.dev` preview URL.

Manual equivalents are inside the script if you prefer clicking the dashboard.

## 2. Preview secrets

Preview needs only test-grade values. In the dashboard (Pages → autoclarity-site
→ Settings → Environment variables → **Preview**) or via
`npx wrangler pages secret put NAME --project-name autoclarity-site`:

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
URL once known (e.g. `https://feature-las-vegas-ppi-portal.autoclarity-site.pages.dev`).

## 3. Turnstile (production-grade bot protection)

Dashboard → Turnstile → Add site → domain `getautoclarity.com` (add the
`pages.dev` preview hostname too) → widget type "Managed". Put the **site key**
in the Pages env var `TURNSTILE_SITE_KEY` and the **secret key** in the
`TURNSTILE_SECRET_KEY` secret. Until then, the shipped test keys pass every
challenge — fine for preview, never for production.

## 4. Cloudflare Access in front of the preview + admin

Two applications (Zero Trust → Access → Applications → Self-hosted):

1. **Preview lock (recommended):** application on
   `autoclarity-site.pages.dev` covering `/*` — policy: allow only your email.
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

Pages → autoclarity-site → Settings → Builds & deployments: preview branch
`feature/las-vegas-ppi-portal` (or "all non-production branches"). If the
project was created by the script (direct upload), previews are produced by
`npx wrangler pages deploy . --branch feature/las-vegas-ppi-portal` instead —
same URL shape. Preview deployments automatically send
`X-Robots-Tag: noindex` from Cloudflare, and the app adds its own noindex
whenever `PPI_ENV != production`.

## 6. What stays untouched

- GitHub Pages keeps serving getautoclarity.com from `main`.
- DNS records are NOT changed by any of this.
- Moving production to Cloudflare Pages later = add the custom domain to the
  Pages project and flip the DNS record — documented in PPI_DEPLOYMENT.md,
  owner-gated.
