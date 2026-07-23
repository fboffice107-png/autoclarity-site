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

## B. Notifications — CURRENT STATUS: NOT DELIVERED (launch blocker)

No outbound email provider is configured, so `functions/lib/email.ts` **records**
every owner/customer message to the `messages` table but does **not send** it
(it returns early when `RESEND_API_KEY`/`EMAIL_FROM` are unset; owner notices
are skipped when `ADMIN_NOTIFY_EMAIL` is unset). All templates + event hooks
already exist and are wired into the flow — only the provider connection is missing.

**Minimal implementation plan (do not add a paid provider without owner approval):**

1. Choose a transactional provider (the adapter is written for **Resend**; any could be swapped behind `sendEmail`).
2. Verify the sending **domain** (SPF + DKIM DNS records) for `getautoclarity.com` so mail isn't spam-foldered.
3. Set Cloudflare Pages **production** secrets (names only):
   - `RESEND_API_KEY`
   - `EMAIL_FROM` (e.g. `AutoClarity <notify@getautoclarity.com>`)
   - `ADMIN_NOTIFY_EMAIL` = `fboffice107@gmail.com` (internal owner destination — **never shown publicly**)
   - `SUPPORT_EMAIL` stays `support@getautoclarity.com` (public reply-to identity)
4. Redeploy. Then run a **real hosted test**: submit a request → confirm the owner email arrives at `fboffice107@gmail.com`; confirm a customer email arrives at an owner-controlled test address; **replay a webhook and confirm no duplicate email** (idempotency: each message is one row; webhook replay is guarded by `stripe_events`).
5. Notification records already store status / provider message id / attempt / error (no secrets). Verify delivery status flips to `sent`.

Owner events covered by templates: new request, slot selected, agreement accepted,
payment confirmed, cancellation, refund, payment failure/expired, manual-attention.
Customer events: request received, quote/appointment options, time selected,
agreement/payment required, payment confirmed, appointment confirmed, cancellation,
refund, schedule change. Emails carry ref #, vehicle year/make/model, appointment
date + Las Vegas time, and a safe portal link — no secret admin links, no unnecessary PII.

## C. Stripe live (owner-gated)

6. Create **separate live** credentials — `STRIPE_SECRET_KEY` (`sk_live_…` or approved live restricted key) and a **separately created live** `STRIPE_WEBHOOK_SECRET`.
7. Create the **live webhook** against the final custom-domain endpoint `https://getautoclarity.com/api/stripe/webhook` (events: `checkout.session.completed`, `checkout.session.async_payment_succeeded/failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`).
8. Keep **test and live secrets fully separated** (live only in the production environment).
9. One controlled **real payment** (small), then **9b.** confirm the **signed live webhook** confirmation, then **9c.** immediately perform and verify a **controlled refund**.
10. Confirm **owner + customer email delivery** on that live transaction.

## D. Infrastructure & security

11. **Cloudflare Access** protecting `/ppi/admin*` **and** `/api/admin*` (Zero Trust → Access → self-hosted app, allow owner email). Copy the app AUD + team domain into production env `CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN`. With `PPI_ENV=production` the dev key is refused and admin fails closed without Access.
12. Enable R2 (optional, for uploads): dashboard → R2 → Enable; `npx wrangler r2 bucket create autoclarity-ppi-uploads`; uncomment `[[r2_buckets]]` in `wrangler.toml`; set `UPLOADS_ENABLED=true`.
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

14. Migrate the domain **only after all hosted tests pass**: Cloudflare Pages project → Custom domains → add `getautoclarity.com` + `www` (DNS is already on Cloudflare → this repoints records to Pages; SSL auto-issues). This is the actual cutover.
15. Smoke test: root, `www`, `/ppi`, long inspection URL, `privacy.html`, `terms.html`, support email link, App Store links.
16. Enable indexing on the final custom domain only.
17. **Preserve the GitHub Pages rollback** (do not delete it).
18. **DNS rollback**: in the Pages project remove the `getautoclarity.com` custom domain, or point the records back to GitHub Pages (`185.199.108–111.153`; `www` CNAME → `fboffice107-png.github.io`). Site returns to `pre-ppi-production` (`15a121c`) immediately.

## G. Launch-day monitoring

19. Watch: JS/API errors, failed webhooks (Stripe dashboard), failed emails (provider dashboard + `messages.status='failed'`), duplicate requests, unavailable/held-slot anomalies.
20. **Do not activate live payments or move DNS without explicit owner approval in the fresh session.**
