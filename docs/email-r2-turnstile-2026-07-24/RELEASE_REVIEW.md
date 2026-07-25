# Independent Release & Regression Review — non-Stripe production completion

Date: 2026-07-24 (22:0x–22:3x PDT) / 2026-07-25 UTC
Reviewer: independent release/regression agent. Read-only toward all
infrastructure: local tests/typecheck/git, HTTP GET/HEAD against production,
read-only wrangler (whoami, r2 bucket list, pages secret list, pages
deployment list, d1 execute SELECT-only). **No POST was made to any
production endpoint; nothing was deployed, written, or mutated.**

All evidence below was reproduced first-hand unless marked otherwise.

---

## Claims table

| # | Claim | Verdict | Evidence (reproduced by this reviewer) |
|---|---|---|---|
| 1 | Branch/tree/HEAD | **VERIFIED** | Branch `feature/las-vegas-ppi-portal`; `git status --porcelain` empty; HEAD = **`3cfc7d91e260f82ad56d6f5941b5e9c6955b67ce`** ("Workflow QA review + reconciliation…"); `git ls-remote origin feature/las-vegas-ppi-portal` returns the identical sha — truly in sync with origin, not just the local tracking ref. Tags intact: `pre-ppi-production`=`15a121c`, `ppi-preview-verified-2026-07-23`=`487d61e`. |
| 2 | typecheck clean; 118+72 tests | **VERIFIED** | `npm run typecheck` (tsc --noEmit) exit 0. `npm test` exit 0: unit **118 passed** (10 files), integration **72 passed** (2 files: flow 43, inspector-flow 29). Total 190. |
| 3 | Live production surfaces | **VERIFIED** | Apex `https://getautoclarity.com/` → 200, **no** `x-robots-tag` header, `robots.txt` `Allow: /` (disallows only /ppi/portal/, /ppi/admin/, /inspector/, /api/), canonical tag present. `/api/ppi/runtime-config` (live): `mode:"request"`, `uploadsEnabled:true`, `paymentsEnabled:false`, `turnstileSiteKey:"0x4AAAAAAD9RlzUuK7woWT3B"` (real key, not `1x…AA`). All four private surfaces — `/ppi/admin/`, `/api/admin/overview`, `/inspector/`, `/api/inspector/overview` — each **302** to `curly-wildflower-604c.cloudflareaccess.com` login. `autoclarity-site.pages.dev` → `x-robots-tag: noindex, nofollow`. `www.getautoclarity.com/` → **301** `https://getautoclarity.com/`; `www…/las-vegas-pre-purchase-inspection?x=1` → **301** preserving path **and** query. Bonus: `/PPI` and `/ppi` aliases 301 → `/las-vegas-pre-purchase-inspection/`. |
| 4 | Stripe safety | **VERIFIED** | `wrangler.toml`: `STRIPE_ENV = "test"`, `PAYMENTS_ENABLED = "false"`. Repo-wide grep for `sk_live` (node_modules/.git excluded): matches only in comments, docs, tests asserting refusal, and the guard itself (`functions/lib/stripe.ts` — `STRIPE_ENV=test` **throws** on a live key). No live key material anywhere. Live runtime config confirms `paymentsEnabled:false`. |
| 5 | R2 | **VERIFIED** | `wrangler.toml` has active `[[r2_buckets]]` `binding = "UPLOADS"`, `bucket_name = "autoclarity-ppi-uploads"`, and `UPLOADS_ENABLED = "true"`. `npx wrangler r2 bucket list` → **exactly one** bucket, `autoclarity-ppi-uploads` (created 2026-07-25T04:53Z). Public-access probe `GET https://pub-6ba4b99750c8438aa3205ca1c9a836cd.r2.dev/` → **401 Unauthorized** (Cloudflare error page, no bucket contents) — public access OFF. |
| 6 | Turnstile keys | **VERIFIED with deviation** | Real sitekey `0x4AAAAAAD9RlzUuK7woWT3B` is in `wrangler.toml` and served live. Full occurrence list below. **Deviation:** the test sitekey also appears in **production source** `functions/api/ppi/runtime-config.ts:25` (`?? '1x00000000000000000000AA'` fallback) and the test secret as a constant in `functions/lib/turnstile.ts:6` — not only in test/harness files as claimed. Both are fail-safe (see Findings F2). The production secret's *value* being the real one could not be reproduced without a prohibited POST — accepted from PHASE23 doc evidence (dummy token → 403) plus consistent config; see Residuals R1. |
| 7 | DNS/email preservation | **VERIFIED** | `dig +short MX getautoclarity.com` → `32 route3.mx.cloudflare.net.`, `47 route2.mx.cloudflare.net.`, `54 route1.mx.cloudflare.net.` (all three rows). `dig +short TXT` → `"v=spf1 include:_spf.mx.cloudflare.net ~all"`. Email Routing records intact. |
| 8 | D1 production data | **VERIFIED** | Remote SELECTs against `autoclarity_ppi` (table is `ppi_requests`, public id column is `ref`): **PPI-260725-MQZ9** exists, `status='submitted'`; joined `messages` → **exactly 2 rows** (`request_received`, `owner_notify`), both `status='sent'`, both `provider_id IS NOT NULL`. `request_uploads` for MQZ9 → **exactly 1 row**: `upl_17855395f8cc4461b0107d299a86da5c`, `image/jpeg`, `size_bytes=2069466`, `deleted_at` NULL. **PPI-260725-G2JW**: `submitted`, **exactly 2** `sent` messages with provider ids — no duplicates. Whole-table sanity: 34 messages total = 4 `sent` (these four) + 30 `recorded` (pre-Resend era) + **0 failed**. Dedupe index `idx_messages_dedupe` present in production. |
| 9 | Docs present + consistent | **VERIFIED with notes** | All five named files exist in `docs/email-r2-turnstile-2026-07-24/` plus a sixth, `PHASE23_LIVE_ACCEPTANCE.md`. Every live-checkable statement I tested reproduced (runtime config, 4× Access 302s, deployment `ba2df6bd` from source commit `3cfc7d9` confirmed via `wrangler pages deployment list`, r2.dev 401, D1 rows/sizes byte-for-byte, secret names). One doc inaccuracy found (Findings F1). WORKFLOW_QA_REVIEW.md is honest about its own blocked run and the reconciliation is coherent. |
| 10 | Regression vs pre-change checkpoint | **VERIFIED with observations** | `git diff 6d40311..HEAD`: `wrangler.toml` changes are **exactly** UPLOADS_ENABLED true + real sitekey + `[[r2_buckets]]` un-commented. Secrets delta (names via `wrangler pages secret list`): checkpoint's 8 + **RESEND_API_KEY** + **EMAIL_FROM** = the 10 now present — nothing else added or removed. Live behavior vs checkpoint: Access gates, pages.dev noindex, apex indexable, www 301, aliases, MX/TXT — all unchanged. **Beyond the four declared items** the session also shipped four small code fixes (Findings F3) — declared in PHASE2 evidence and commit `c433331`, security-reviewed, test-covered; not silent, but they are code deltas beyond the strict list. |

## Turnstile key occurrence audit (complete grep, node_modules/.git excluded)

Test **sitekey** `1x00000000000000000000AA`:

- `.env.example:20` — example file (harmless)
- `docs/email-r2-turnstile-2026-07-24/PRE_CHANGE_CHECKPOINT.md:20` — historical record (correct)
- `functions/api/ppi/runtime-config.ts:25` — **production source**, fallback when `TURNSTILE_SITE_KEY` unset (unused in prod; var is set — live response proves the real key wins)

Test **secret** `1x0000000000000000000000000000000AA`:

- `.env.example:21`, `wrangler.toml:56` (comment), `docs/PPI_CLOUDFLARE_SETUP.md:40`, `docs/email-r2-turnstile-2026-07-24/PRE_CHANGE_CHECKPOINT.md:59` — docs/comments
- `.claude/launch.json:24` — local harness binding
- `tests/integration/globalSetup.ts:81` — integration harness
- `functions/lib/turnstile.ts:6` — **production source** constant; used **only** when `!isProduction` (in production a missing secret returns `server-misconfigured` and the form fails closed — verified by reading `verifyTurnstile`)

## Findings

- **F1 (doc inaccuracy, minor).** `PHASE2_STAGING_EVIDENCE.md` ("Test always-pass keys remain ONLY in launch.json + the integration harness") and the new `wrangler.toml` comment repeat a claim the grep above disproves: both test values also live in production source as fallbacks (`runtime-config.ts:25`, `turnstile.ts:6`). The fallbacks are deliberate and fail-safe, but the sentence is false as written.
- **F2 (design observation, fail-safe).** Worst case if `TURNSTILE_SITE_KEY` were ever unset in production: the page would render the always-pass widget, but the server still verifies against the real secret, so those tokens fail → 403. No bypass path exists; noted for completeness.
- **F3 (scope delta, declared).** Code changes since checkpoint beyond the four infra items — all four are the security-review GO conditions/fixes and are present in HEAD: dedicated `portal_photo` 600/hr rate bucket (`functions/lib/portal.ts`, `functions/api/portal/report-photo.ts:34`); EXIF-unsafe original-file upload fallback removed, un-decodable photos refused (`assets/js/inspector-report.js:786-787`); 409 `uploads_disabled` guard when flag on but binding absent (`functions/api/portal/upload.ts`); exact snapshot-membership check for published photos (`report-photo.ts`). Reviewed in SECURITY_REVIEW_R2.md, covered by the 190-test suite. Not regressions.
- **F4 (data hygiene, pre-existing — NOT a regression of this session).** Production D1 contains **10 `PPI-FIXTURE-*` rows** (seeded 2026-07-24T01:00Z, during the preview era, before the production cutover and before this session's checkpoint) plus 5 preview-era test requests from 07-22/23 (including `awaiting_payment` and `refunded` states from test-mode Stripe) and 3 `PPI-260724-*` test submissions. All sit behind the Access-gated admin and none are visible publicly, but the production admin dashboard is not clean. Recommend an owner cleanup pass (cancel/soft-delete from admin) — do not hard-delete via D1.

## Not reproducible from this seat (accepted from documents, flagged as residual)

- **R1 — Turnstile secret value.** Proving the production `TURNSTILE_SECRET_KEY` is the real widget secret (not the always-pass test secret) requires POSTing a dummy token to `/api/ppi/requests`, which this review was prohibited from doing (shared rate limit + junk-data risk). PHASE23's dummy-token→**403 `turnstile_failed`** result is the load-bearing evidence — under the test secret any token passes, so a 403 does prove the real secret. Accepted on documented evidence; one-command spot check available to the owner at any time.
- **R2 — Email inbox receipt.** Resend acceptance is proven by the 4 `sent`+provider-id rows I queried myself; actual inbox delivery rests on the owner's Phase 1 in-chat confirmation.
- **R3 — Owner Access PIN login** (runbook OWNER STEP 4) remains outstanding, as the docs themselves state. It is the only human check left and doubles as the live inspector spot-check.

## Verdict

**SHIP** — the non-Stripe production completion is real and holds up under
independent adversarial verification. Every infrastructure claim I was
permitted to reproduce, reproduced exactly: repo/tests (190 green at the
deployed sha, which is also the live Pages deployment `ba2df6bd`), live flags
and the real Turnstile sitekey, all four Access gates, noindex/canonical/www
behavior, single private R2 bucket with public access off, Email-Routing DNS
byte-identical, and the production D1 rows (2+2 sent messages, 1 JPEG upload,
2,069,466 bytes) matching the acceptance evidence to the byte. Stripe is
provably still cold (`test` env, payments off, no live keys, guard code
refuses them).

Conditions attached to the verdict (none blocking):
1. Owner completes the Access PIN login test (R3) — already tracked.
2. Fix the F1 doc/comment sentence next time the files are touched.
3. Schedule the F4 fixture/test-data cleanup from the admin dashboard.
4. Optional 30-second owner spot check for R1 (one dummy-token submit from a
   browser console is *not* needed — simply submitting the live form with the
   widget visible and confirming it challenges/passes suffices).
