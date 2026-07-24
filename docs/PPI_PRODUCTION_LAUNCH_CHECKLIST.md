# Pre-Purchase Inspection — Production Launch Checklist (owner-gated)

**Nothing in this file may be executed without explicit owner approval in a
fresh session. Do not change DNS, move getautoclarity.com, or enable live Stripe
payments automatically.** The website being technically ready does NOT mean the
business/legal/insurance items are done — only the owner can confirm those.

## A. Business & legal (owner + counsel)

1. Confirm applicable **Nevada + Clark County / City of Las Vegas** business authorization for mobile inspection work.
2. Confirm the customer-facing **legal business / DBA name**.
3. Confirm **general / professional / commercial-auto insurance** status — or state accurately that it is pending (do not claim coverage that is not in force).
4. Complete **Stripe live-account verification** (identity, bank).
5. A **sole proprietor may use SSN/ITIN** if no EIN exists — an EIN is **not** an automatic technical requirement.
6. Review the agreement drafts (`functions/lib/agreements.ts`) + `legal/PPI_PRIVACY_SUPPLEMENT.md` with a Nevada-licensed attorney; publish the approved privacy/terms/cancellation/refund docs.

## B. Notifications — CODE COMPLETE + PROVEN; owner must connect the provider (launch blocker)

_Updated 2026-07-23._ The Resend adapter in `functions/lib/email.ts` is fully
implemented and **proven end-to-end against a mock provider in the integration
suite** (`tests/integration/flow.test.ts`, "email delivery"): correct
recipients and content, provider message id + `sent` status recorded, a
provider **failure never loses the stored request** (status `failed` +
error recorded), dedupe keys and the `stripe_events` replay guard prevent
duplicate emails, and every event in the owner/customer matrix now has a hook
(this session added the missing owner notices for slot selection, unpaid
cancellation and completed refund). `ADMIN_NOTIFY_EMAIL` is already set on the
hosted preview; messages currently record with status `recorded` because no
provider key exists — nothing is claimed to be delivered.

**Remaining = owner actions only (~15 min + DNS propagation). Do these
yourself — API keys must never transit chat:**

1. Create a free **Resend** account at https://resend.com (100 emails/day free
   — plenty; do not buy a plan).
2. Resend dashboard → **Domains → Add Domain** → `getautoclarity.com`. Resend
   shows 3–4 DNS records (SPF TXT, DKIM TXT/CNAME, optional DMARC). Add them
   in **Cloudflare dashboard → getautoclarity.com → DNS** exactly as shown.
   These are additive mail-authentication records — they do **not** move the
   website — but they are DNS changes, so they are yours to make. Wait for
   Resend to show **Verified** (minutes to an hour).
3. Resend → **API Keys → Create** (sending access only) and set the secrets
   yourself (values never in chat/files/git):
   ```bash
   cd "/Volumes/Super Storage/autoclarity-site"
   npx wrangler pages secret put RESEND_API_KEY --project-name autoclarity-site
   npx wrangler pages secret put EMAIL_FROM --project-name autoclarity-site
   ```
   `EMAIL_FROM` = `AutoClarity <notify@getautoclarity.com>`.
   (`ADMIN_NOTIFY_EMAIL` = `fboffice107@gmail.com` is already set — internal
   owner destination, never shown publicly. `SUPPORT_EMAIL` stays
   `support@getautoclarity.com`, the public reply-to identity.)
4. Redeploy: `npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true`
5. **Real hosted test (required before claiming delivery works):** submit a
   request on `autoclarity-site.pages.dev` with an owner-controlled email →
   confirm the customer email arrives there AND the owner notice arrives at
   `fboffice107@gmail.com`; check the message rows flip to `sent` with a
   provider id (admin → request → messages).

Owner events covered: new request (+ manual-attention flag), slot selected,
agreement accepted, payment confirmed, PAID-but-slot-lapsed, customer message,
unpaid cancellation, paid cancellation request, refund completed, inspection
started, report published, amended report published.
Customer events: request received (with vehicle summary), needs-info, seller
access, quote ready, slots offered, time selected/held, payment received,
appointment confirmed (Las Vegas time), reschedule, cancellation, refund,
report ready, report amended. All carry the ref #; portal links are the safe
customer magic link — no secret admin links, no unnecessary PII.

## B2. Live form fix — publish to GitHub Pages (owner-gated, one command)

The live getautoclarity.com form still runs the old JavaScript that opens the
customer's email app. The fix is complete and verified on this branch: the
form now submits to the hosted Cloudflare API cross-origin (CORS-allowlisted
for `getautoclarity.com` + `www`, already deployed and verified on the API
side), shows the real reference number only after D1 storage succeeds, and
fails honestly if the API is unreachable — the mailto path is deleted.

Because getautoclarity.com serves from the `main` branch (GitHub Pages),
making the live form use it requires publishing `main` — an owner decision:

```bash
cd "/Volumes/Super Storage/autoclarity-site"
git checkout main && git merge feature/las-vegas-ppi-portal && git push origin main && git checkout feature/las-vegas-ppi-portal
```

This changes the live site (form behavior + the visual polish). Rollback:
`git push -f origin pre-ppi-production:main`. Requests then flow into the
hosted D1 + admin dashboard immediately, even before the custom-domain
cutover; emails start when §B is done.

## C. Stripe live (owner-gated)

6. Create **separate live** credentials — `STRIPE_SECRET_KEY` (`sk_live_…` or approved live restricted key) and a **separately created live** `STRIPE_WEBHOOK_SECRET`.
7. Create the **live webhook** against the final custom-domain endpoint `https://getautoclarity.com/api/stripe/webhook` (events: `checkout.session.completed`, `checkout.session.async_payment_succeeded/failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`).
8. Keep **test and live secrets fully separated** (live only in the production environment).
9. One controlled **real payment** (small), then **9b.** confirm the **signed live webhook** confirmation, then **9c.** immediately perform and verify a **controlled refund**.
10. Confirm **owner + customer email delivery** on that live transaction.

## D. Infrastructure & security

11. **Cloudflare Access** protecting **all four** private surfaces: `/ppi/admin*`, `/api/admin*`, `/inspector*`, `/api/inspector*` — full owner walkthrough incl. **authentication test and rollback** in `docs/PPI_ACCESS_SETUP.md` (dashboard-only; the CLI token has no Zero Trust scope — verified 2026-07-23). The fail-closed matrix (dev key refused in production, 503 until Access configured, JWT audience/signature verification) is covered by `tests/unit/auth.test.ts`.
12. Enable R2 (optional — inspection-report photos + stored PDFs, and customer intake uploads): follow `docs/PPI_R2_SETUP.md`. Reports work fully without it (PDFs render on demand).
12b. **Report notifications**: `report_ready` / `report_amended` emails are recorded idempotently at publish time and start sending automatically once §B's provider is configured — verify one publish → one email on a controlled test after that.
13. Production env vars: `PPI_ENV=production`, `PUBLIC_BASE_URL=https://getautoclarity.com`, `PPI_MODE=live` (only after B + C), `PAYMENTS_ENABLED=true` (only after C), `STRIPE_ENV=live`.
14. Turnstile: real site + secret keys (replace the always-pass test keys).

## E. SEO / launch switches (Phase 7 — PREPARE, do not activate on pages.dev)

Keep `autoclarity-site.pages.dev` **noindex** for the whole preview period (it
already sends `X-Robots-Tag: noindex` while `PPI_ENV != production`). On the final
custom domain only:
- Canonical is already `https://getautoclarity.com/las-vegas-pre-purchase-inspection`.
- Title/meta/OG already Las-Vegas Pre-Purchase-Inspection focused; Service/FAQ/Breadcrumb structured data present and truthful.
- `sitemap.xml` + `robots.txt` present; `/ppi` and `/pre-purchase-inspection` → 301 (real 301 on Cloudflare).
- **Enable indexing only after cutover** (it turns on automatically once `PPI_ENV=production` stops emitting the noindex header for non-API pages).
- Analytics funnel events already implemented (allowlisted, no PII): `ppi_page_view`, `ppi_cta_click`, `ppi_founder_cta_click`, `ppi_sample_report_view`, `ppi_call_click`, `ppi_text_click`, `ppi_form_started`, `ppi_form_step_completed`, `ppi_request_submitted`, `ppi_quote_sent`, `ppi_slot_selected`, `ppi_agreement_accepted`, `ppi_checkout_started`, `ppi_payment_confirmed`, `ppi_booking_confirmed`, `ppi_cancelled`, `ppi_completed`. (The brief's aliases map to these; rename only if desired.)

## F. Custom-domain cutover (last step)

> **2026-07-23:** full click-by-click runbook + pre-change DNS snapshot +
> rollback: `docs/domain-cutover-2026-07-23/` — the cutover was prepared and
> then STOPPED at the Access gate (§D-11 not done; secrets absent, verified).
> `www → apex` 301 (path+query preserved) and production noindex for
> pages.dev are now built into the app (`functions/lib/canonical.ts`) — no
> zone Redirect Rules needed.

14. Migrate the domain **only after all hosted tests pass AND §D-11 (Access) is verified**: Cloudflare Pages project → Custom domains → add `getautoclarity.com` + `www` (DNS is already on Cloudflare → this repoints records to Pages; SSL auto-issues). This is the actual cutover.
15. Smoke test: root, `www`, `/ppi`, long inspection URL, `privacy.html`, `terms.html`, support email link, App Store links.
16. Enable indexing on the final custom domain only.
17. **Preserve the GitHub Pages rollback** (do not delete it).
18. **DNS rollback**: in the Pages project remove the `getautoclarity.com` custom domain, or point the records back to GitHub Pages (`185.199.108–111.153`; `www` CNAME → `fboffice107-png.github.io`). Site returns to `pre-ppi-production` (`15a121c`) immediately.

## G. Launch-day monitoring

19. Watch: JS/API errors, failed webhooks (Stripe dashboard), failed emails (provider dashboard + `messages.status='failed'`), duplicate requests, unavailable/held-slot anomalies.
20. **Do not activate live payments or move DNS without explicit owner approval in the fresh session.**
