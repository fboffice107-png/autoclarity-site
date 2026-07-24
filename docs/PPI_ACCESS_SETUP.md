# Cloudflare Access — production admin/inspector protection (owner setup)

The production control for every private surface is **Cloudflare Access**
(Zero Trust). The dev key works only while `PPI_ENV=preview` and is refused
outright in production — the code fails closed (503) until Access is
configured, so there is no obscurity-only state. Verified by unit tests
(`tests/unit/auth.test.ts`) and the JWT verifier in `functions/lib/auth.ts`.

**This cannot be done from the CLI** — the Wrangler OAuth token has no Zero
Trust scope (verified 2026-07-23). It is a one-time dashboard task, ~10 min.

## 1. Create the Access application (owner, dashboard)

1. https://one.dash.cloudflare.com → pick the account (fboffice107@gmail.com).
   If Zero Trust asks you to choose a **team name** the first time, pick any
   (e.g. `autoclarity`) on the **Free plan** — no paid plan is needed for one
   user.
2. **Access → Applications → Add an application → Self-hosted.**
3. Application name: `AutoClarity admin + inspector`.
4. **Application domain — add ALL FOUR paths** (use "Add public hostname"
   repeatedly), all on `getautoclarity.com`:
   - `getautoclarity.com/ppi/admin*`
   - `getautoclarity.com/api/admin*`
   - `getautoclarity.com/inspector*`
   - `getautoclarity.com/api/inspector*`
5. Session duration: 24 hours is a good default.
6. **Policy** — name `Owner only`, action **Allow**, include →
   **Emails** → `fboffice107@gmail.com`. Nothing else. (Add more emails later
   only if you hire staff.)
7. Identity providers: the default **One-time PIN** is enough — you'll get a
   6-digit code at the owner email each login. (You can add Google login
   later; not required.)
8. Save the application.

## 2. Wire the application into the code (owner, one command each)

On the application's **Overview** tab copy the **Application Audience (AUD)
tag**, and note your team domain (`<team>.cloudflareaccess.com`, shown under
Zero Trust → Settings → Custom Pages or in the login URL). Then:

```bash
cd "/Volumes/Super Storage/autoclarity-site"
npx wrangler pages secret put CF_ACCESS_AUD --project-name autoclarity-site
npx wrangler pages secret put CF_ACCESS_TEAM_DOMAIN --project-name autoclarity-site
```

Paste the AUD tag / team domain when prompted (values never go in chat, files
or git). Redeploy afterwards:

```bash
npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
```

The API then verifies the `Cf-Access-Jwt-Assertion` header on every
admin/inspector call: RS256 signature against the team's published certs,
audience, expiry and issuer. See `functions/lib/auth.ts`.

## 3. Authentication test (BEFORE relying on it — do not skip)

Access only intercepts requests on hostnames proxied by Cloudflare, so the
full test happens on the custom domain at cutover time. Test in this order:

1. **Pre-cutover sanity (pages.dev still works with the dev key):**
   `PPI_ENV` on the hosted preview stays `preview`; nothing changes there.
2. **At cutover** (after `getautoclarity.com` is added as the Pages custom
   domain and `PPI_ENV=production` is set):
   - Open a **private/incognito window** → `https://getautoclarity.com/ppi/admin/`
     → you MUST see the Cloudflare Access login page, not the admin UI.
   - Complete the one-time PIN as `fboffice107@gmail.com` → the admin UI loads
     and API calls succeed (the JWT is forwarded automatically).
   - `curl -s -o /dev/null -w '%{http_code}' https://getautoclarity.com/api/admin/overview`
     (no cookies) → must be a **302 to the Access login** or **401/403** —
     anything but 200.
   - Repeat both checks for `/inspector/` and `/api/inspector/overview`.
   - Try the dev key against production:
     `curl -H "authorization: Bearer <the dev key>" https://getautoclarity.com/api/admin/overview`
     → must be refused (Access intercept or 503 `admin_locked`) — the code
     ignores the dev key when `PPI_ENV=production`.
3. **Keep a second tab logged into the Cloudflare dashboard during the whole
   test** — if anything is wrong you can edit/delete the Access app without
   being locked out of the site's own controls (the dashboard itself is never
   behind your Access app).

## 4. Rollback / lockout recovery

- Access misconfigured (owner can't log in): Zero Trust → Access →
  Applications → edit the policy (fix the email) or **delete the
  application** — the site instantly stops requiring Access. The API then
  fails closed (503 admin_locked) in production until you fix and re-add —
  customers are unaffected (public pages and portal are outside the four
  paths).
- To temporarily operate without Access in an emergency: set
  `PPI_ENV=preview` on the Pages project (dashboard → Settings → Environment
  variables) and redeploy — the dev key works again. **Revert to
  `production` immediately after**; preview mode also disables indexing.
- The hosted preview (`autoclarity-site.pages.dev`) keeps the dev-key model
  regardless — it is the permanent staging fallback.

## 5. Optional hardening (recommended once live)

- Add a second Access app covering `autoclarity-site.pages.dev/*` (policy:
  owner email) so even the staging preview needs a login.
- Zero Trust → Settings → Authentication → add Google as a login method for
  faster sign-in.
