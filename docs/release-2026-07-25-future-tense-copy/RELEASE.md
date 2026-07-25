# Release — future-tense founder copy (2026-07-25)

Final copy-only release before the site is frozen until the Stripe activation
phase. Nothing functional shipped.

## The copy change

The Las Vegas in-person inspection service is not licensed and operating yet.
The earlier "Launching soon in Las Vegas" pass (`2984196`, `5ec6b4a`) fixed the
hero, section and FAQ claims; four founder-credibility sentences still read
present tense and contradicted the launch status shown directly above them.

`las-vegas-pre-purchase-inspection/index.html`

| Line | Before | After |
|---|---|---|
| 168 | `Every Las Vegas inspection currently performed personally by the founder` | `Every Las Vegas inspection will be performed personally by the founder` |
| 171 | `Your inspection is currently performed personally by the founder.` | `Your inspection will be performed personally by the founder.` |
| 249 | `Every Las Vegas inspection is currently performed personally by Faheb.` | `Every Las Vegas inspection will be performed personally by Faheb.` |

`las-vegas-pre-purchase-inspection/sample-report/index.html`

| Line | Before | After |
|---|---|---|
| 178 | `Every Las Vegas inspection currently performed personally by the founder.` | `Every Las Vegas inspection will be performed personally by the founder.` |

Final count: **4 replacements, 2 files, 4 insertions / 4 deletions.** Two of the
four were the same claim in different grammatical dress rather than the literal
target string; the copula `is` is absorbed into `will be` so each sentence still
reads naturally. **Zero** occurrences of `currently performed` remain in any
public HTML.

Deliberately untouched: the same-day and 24-hour response wording (all 7
occurrences byte-identical).

## Identifiers

| | |
|---|---|
| Git commit | `ebe2aa5` on `feature/las-vegas-ppi-portal` (pushed) |
| Git rollback checkpoint | tag `pre-future-tense-copy-2026-07-25` = `5ec6b4a` |
| **New production deployment** | **`456542d7-473e-4257-ab58-64dedf1eaeb6`** |
| Previous production deployment | `213e8c96-6f4d-4099-a144-82ec08b7dc2f` |
| Earlier rollback candidate | `ba2df6bd-e25b-477c-b4dc-52ea39490d9b` |
| Release base commit | `3cfc7d9` (Cloudflare records this as the deployment source) |

## How this was deployed (HEAD was NOT deployed)

`feature/las-vegas-ppi-portal` HEAD contains payment-hardening backend code
(`0634bae`, `d27b1d1`, `7ab6c37`) plus `migrations/0003_checkout_attempt_guard.sql`,
which must not reach production until migration 0003 is intentionally applied.
Deploying HEAD would have shipped that code.

The artifact was therefore built in a **temporary detached worktree** at the
production-compatible base `3cfc7d9`, with only the three copy-only HTML files
overlaid from `ebe2aa5`:

```
git worktree add --detach <tmp> 3cfc7d9
git show ebe2aa5:index.html                                            > <tmp>/index.html
git show ebe2aa5:las-vegas-pre-purchase-inspection/index.html          > <tmp>/…
git show ebe2aa5:las-vegas-pre-purchase-inspection/sample-report/index.html > <tmp>/…
cd <tmp> && wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
```

The main working tree was never reset or contaminated.

Those three HTML files are the only files touched by copy commits between
`3cfc7d9` and `ebe2aa5` (verified with `git log -- <path>`), so the overlay
cannot carry backend changes.

### Proofs recorded at release time

- The three overlaid files hash-matched `ebe2aa5` byte-for-byte (SHA-256).
- `git diff --name-only 3cfc7d9` inside the worktree listed **only** those three
  HTML files.
- `functions/lib/checkout-gates.ts`, `migrations/0003_checkout_attempt_guard.sql`,
  `tests/unit/checkout-gates.test.ts` and `tests/integration/payment-gates.test.ts`
  were **absent** from the artifact; the artifact's `migrations/` contained only
  `0001` and `0002`.
- Diffing the live previous deployment against the artifact showed the four
  sentences as the only substantive difference (the remaining differences are
  Cloudflare's edge-injected email obfuscation, which is not source).
- Wrangler uploaded **2 files (268 already uploaded)** — the signature of a
  copy-only release.

## Verification

Pre-deploy: `tsc --noEmit` clean; **296 tests pass** (157 unit + 139 integration);
`check-links.mjs` all internal links OK; `check-headers.mjs` all header checks
passed; no console errors; no horizontal overflow at 375 px or 1440 px.

An independent scope reviewer rebuilt both changed files from `HEAD` by applying
only the four substitutions and matched SHA-256 exactly, proving no markup,
attribute, class, inline style, script or structured-data path was touched.
Form tag/attribute multisets, `class` multisets and JSON-LD blocks were verified
identical; HTML parsed with zero errors; typographic characters preserved.

Post-deploy, live and cache-busted:

| Check | Result |
|---|---|
| `/`, `/las-vegas-pre-purchase-inspection/`, `/…/sample-report/` | 200 |
| `www` → apex | 301 |
| `/ppi` and `/PPI` → PPI page | 301 |
| `currently performed` anywhere | **0** |
| `will be performed` | 3 on PPI page, 1 on sample report |
| `Launching soon in Las Vegas` | still present (homepage ×2, PPI page ×1) |
| `paymentsEnabled` | **false** |
| `mode` | **request** |
| Pricing | **19900 / 29900 / 39900** ($199 / $299 / $399) |
| Intake form (`#intakeForm`) | visible, 42 fields |
| Waitlist shell (`#waitlistShell`) | `display:none` |
| `/ppi/admin/`, `/inspector/`, `/inspector/reports/` | 302 → Cloudflare Access |
| Console errors | none |
| Horizontal overflow at 390 px / 1440 px | none |

## Production remains on the safe non-payment backend

- `migrations/0003_checkout_attempt_guard.sql` is **still pending** on the remote
  D1 database, re-confirmed *after* the deploy. It was never applied, and it is
  not present in the deployed artifact.
- The deployed `assets/js/ppi-portal.js` SHA-256 **matches `3cfc7d9` exactly** and
  differs from `ebe2aa5`; the HEAD-only string `already been received` returns
  **0** matches live. The payment-hardening front end is not deployed.
- `PAYMENTS_ENABLED=false`, `STRIPE_ENV=test`, `PPI_MODE=request`,
  `PPI_ENV=production` — the artifact's `wrangler.toml` is `3cfc7d9`'s, which
  differs from HEAD's only in comments.

## Rollback

Cloudflare Pages (fastest — restores the previous live site):

```
npx wrangler pages deployment list --project-name autoclarity-site
```

then in the dashboard roll back to `213e8c96-6f4d-4099-a144-82ec08b7dc2f`
(the immediately previous production deployment), or `ba2df6bd-e25b-477c-b4dc-52ea39490d9b`
(the pre-"Launching soon" state).

Git:

```
git checkout pre-future-tense-copy-2026-07-25   # = 5ec6b4a, the pre-change tree
```

Re-deploying a rollback uses the same worktree procedure above with the desired
base commit. Do **not** roll back by deploying `feature/las-vegas-ppi-portal`
HEAD — it contains the undeployed payment code.

## Open item for the owner (NOT fixed in this release)

`las-vegas-pre-purchase-inspection/sample-report/autoclarity-sample-ppi-report.pdf`
still contains the retired sentence verbatim:

> Every Las Vegas inspection currently performed personally by the founder.

It is linked from three public buttons — `sample-report/index.html:61`,
`sample-report/index.html:184`, and `las-vegas-pre-purchase-inspection/index.html:365`
— so a visitor can read "will be performed" on the page and then download a PDF
saying "currently performed". The PDF is generated by
`scripts/build-sample-pdf.py:209`, which still carries the old string.

This was **left out deliberately**: PDFs are on the do-not-modify list for this
copy-only release, and regenerating the binary requires the `fpdf` dependency and
a build step. Fix when the owner approves: update
`scripts/build-sample-pdf.py:209`, regenerate, and redeploy by the same worktree
procedure.

## Freeze

After this release the website is frozen until the Stripe activation phase.
