# AutoClarity Pre-Purchase Inspection Portal — Session Handoff

_Last updated: 2026-07-23 (Inspector Report Workspace session). Read this plus
`docs/PPI_CLOUDFLARE_PREVIEW_STATUS.md`, `docs/PPI_PRODUCTION_LAUNCH_CHECKLIST.md`,
`docs/PPI_INSPECTOR_GUIDE.md` before making any production change._

## Snapshot

| Item | Value |
|---|---|
| Repository | `autoclarity-site` (`/Volumes/Super Storage/autoclarity-site`) |
| Branch | `feature/las-vegas-ppi-portal` |
| Remote | `origin` = github.com/fboffice107-png/autoclarity-site |
| Cloudflare Pages project | `autoclarity-site` |
| Hosted preview deployment | https://autoclarity-site.pages.dev (noindex; **not** the customer domain) |
| Custom domain status | **UNCHANGED** — getautoclarity.com still served by **GitHub Pages**. No DNS change made. |
| D1 database | `autoclarity_ppi` (`0ae44d57…af26`), migrations **0001 + 0002** applied (local + remote) |
| R2 (photos/PDF storage) | **Not enabled** on the account; feature-flagged; activation steps in `docs/PPI_R2_SETUP.md` |
| Stripe | test/sandbox verified end-to-end (prior session); `STRIPE_ENV=test`, `PAYMENTS_ENABLED=false` |
| Notification delivery | **NOT configured — recorded to D1 only, not sent. LAUNCH BLOCKER.** |
| Admin/inspector security | Preview: `ADMIN_DEV_KEY` (hosted value now matches local `.dev.vars`). Production: Cloudflare Access **not yet configured** — must cover `/ppi/admin*`, `/api/admin*`, **`/inspector*`, `/api/inspector*`** before cutover. |
| Tests | **154 pass** — 91 unit + 63 integration; `tsc` clean; links + headers pass |
| Rollback tags | `pre-ppi-production` → `15a121c` (GitHub Pages prod); `ppi-preview-verified-2026-07-23` |

## NEW this session — Inspector Report Workspace (complete, verified)

A real private report-authoring system at **`/inspector`** (see
`docs/PPI_INSPECTOR_GUIDE.md` for the full operating guide):

- **Routes**: `/inspector/` (dashboard), `/inspector/requests/`,
  `/inspector/inspections/`, `/inspector/inspections/:requestId/report`
  (editor), `…/report/preview` (customer-exact preview + publish). Clean
  dynamic URLs served by Pages Functions via the ASSETS binding; all noindex +
  robots-disallowed; production middleware refuses to serve them without auth.
- **Data**: `migrations/0002_inspection_reports.sql` — `inspection_reports`
  (UNIQUE(request_id) = one report per booking), `report_sections`,
  `report_items` (measurements + cents estimates + priorities + flags),
  `report_photos` (metadata; binaries in R2), `report_versions` (**immutable
  snapshots — DB trigger blocks rewrites**), `report_audit`, and
  `messages.dedupe_key` (idempotent notifications). Doc: `docs/PPI_REPORT_SCHEMA.md`.
- **Editor**: 104-item checklist (18 sections; scan/road-test/underbody are
  conditional with honest not-performed reasons), Pass/Attention/Fail/NI/NA,
  per-item notes/measurements/estimates/photos, debounced autosave with
  optimistic concurrency (cross-device conflict → reload, never clobber),
  visible Saving/Saved/Failed/Offline states with retry, resume after refresh,
  jump-to-section, bulk actions, 320–1440px clean.
- **Publishing**: readiness gate (unresolved items/missing verdict block;
  advisory warnings), typed-ref confirmation, immutable version, request walks
  to `completed`, customer email + owner notice recorded **once** per version
  (dedupe keys), magic-link rotation. **Amendments** reopen the draft with a
  required reason; the customer keeps seeing the last published version until
  vN+1 is published; v1 payload sha verified unchanged.
- **Customer delivery**: portal card ("Your inspection report" + version),
  premium HTML report at `/ppi/portal/report/?t=…` (same renderer as the
  inspector preview), **branded PDF generated in the Worker by a
  dependency-free PDF writer** (`functions/lib/pdf.ts`) from the same snapshot
  — stored in R2 when enabled, rendered on demand otherwise. No paid
  Cloudflare features used.
- **Photos**: feature-flagged on R2; while off, uploads return
  `uploads_disabled` and reports work fully. When on: client-side ≤1600px JPEG
  downscale, magic-byte sniffing, randomized private keys, per-finding
  attachment, captions/ordering/removal before publication, published evidence
  never deleted, strict per-customer authorization.
- **Public sample report** kept (labeled "Sample AutoClarity Pre-Purchase
  Inspection Report — DEMONSTRATION ONLY"); its design is the basis of the
  real customer report. No inspection-point count advertised anywhere.

### Verified (evidence-based)

- **Local end-to-end through the real UI** (browser): login → start →
  checklist → autosave/resume → photos (local R2) → preview → publish →
  portal → HTML report → 7-page PDF with embedded photos → lock →
  amendment → v2. See `docs/inspector-audit-2026-07-23/REPORT.md`.
- **Hosted preview: 28/28 workflow checks passed** on
  autoclarity-site.pages.dev with the remote D1, including duplicate-start
  protection, draft invisibility, cross-customer isolation, publish gates,
  on-demand PDF, amendment/version history, one-time notification records,
  and the honest `uploads_disabled` state (R2 off).
- **Mobile audit**: 35 page/width combos, no horizontal overflow, no <16px
  inputs (two defects found by the audit and fixed). Screenshots in
  `docs/inspector-audit-2026-07-23/screenshots/` (local + hosted).
- **154 tests** (91 unit + 63 integration incl. full prior booking/payment
  regression), `tsc --noEmit` clean, 20 links OK, header checks pass.

### Also this session

- Hosted preview `ADMIN_DEV_KEY` was reset to match the value in the local
  `.dev.vars` (one key for admin + inspector; value never printed/committed).
- `.claude/launch.json` gained a `ppi-ui-test` dev-server config (public test
  key + local R2) used for browser verification.
- `report_ready` email copy updated (points at the report + PDF);
  new `report_amended` template; `sendEmail` supports idempotency dedupe keys.
- Admin seed fixtures now clean up report tables on re-seed.

## Known blockers (must clear before live customers)

1. **Notifications not delivered** — no email provider configured; messages
   (incl. `report_ready`/`report_amended`) are recorded, not sent. **Launch blocker.**
2. **Production admin/inspector auth** — Cloudflare Access app must cover
   `/ppi/admin*`, `/api/admin*`, `/inspector*`, `/api/inspector*` (exact
   steps: `docs/PPI_INSPECTOR_GUIDE.md`). **Launch blocker.**
3. **Business/legal readiness** — licensing, insurance, agreements review,
   live Stripe activation (owner-owned; see checklist).
4. **R2** — photos + stored PDFs off until the owner enables R2
   (`docs/PPI_R2_SETUP.md`); reports fully functional without it (non-blocking).

## Exact next commands (a fresh session / the owner)

```bash
cd "/Volumes/Super Storage/autoclarity-site"
npx wrangler whoami                      # confirm the owner account
git log --oneline -5
npm test                                 # 91 unit + 63 integration
npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
```

## Rollback

- Customer domain untouched → nothing to undo there.
- GitHub Pages production revert: `git push -f origin pre-ppi-production:main`.
- The report schema (0002) is additive-only; no existing tables were altered
  except `messages` gaining a nullable `dedupe_key`.

## Important files

`functions/api/inspector/*`, `functions/lib/{report,report-template,pdf,report-pdf,inspector}.ts`,
`inspector/`, `assets/js/inspector-*.js`, `assets/js/report-render.js`,
`assets/css/{inspector,report}.css`, `ppi/portal/report/`,
`functions/api/portal/report*.ts`, `migrations/0002_inspection_reports.sql`,
`docs/PPI_INSPECTOR_GUIDE.md`, `docs/PPI_REPORT_SCHEMA.md`, `docs/PPI_R2_SETUP.md`,
plus everything listed in the prior handoff (booking/payment system unchanged).
