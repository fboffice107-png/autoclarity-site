# Inspector Report Workspace — Operating Guide

The private, mobile-first workspace Faheb uses on site to author, publish and
amend customer inspection reports. It is a real operational system on the same
Cloudflare Pages + D1 stack as the booking portal.

## Private URLs

| URL | What it is |
|---|---|
| `/inspector/` | Dashboard: confirmed bookings ready to inspect, drafts in progress, published reports |
| `/inspector/requests/` | Every request with status and a shortcut to its report |
| `/inspector/inspections/` | All reports by state |
| `/inspector/inspections/:requestId/report` | The report editor (checklist, findings, autosave) |
| `/inspector/inspections/:requestId/report/preview` | Customer-exact preview + readiness checks + publish |

All inspector pages and `/api/inspector/*` are noindex, disallowed in
robots.txt, and never linked from any public page.

## Authentication

- **Preview (`autoclarity-site.pages.dev`)**: the admin dev key (same
  sessionStorage key as `/ppi/admin` — unlock either surface once per browser
  session). The hosted preview `ADMIN_DEV_KEY` now matches the value in your
  local `.dev.vars` (never committed, never printed).
- **Production (custom domain)**: Cloudflare Access only. The dev key is
  refused when `PPI_ENV=production`, and the middleware also refuses to serve
  any `/inspector*` HTML without authorization (fail closed).

### Cloudflare Access configuration required before custom-domain launch

Zero Trust → Access → Applications → **Add → Self-hosted**, ONE app covering
all four private surfaces of the final domain:

- `getautoclarity.com/ppi/admin*`
- `getautoclarity.com/api/admin*`
- `getautoclarity.com/inspector*`
- `getautoclarity.com/api/inspector*`

Policy: **Allow → Emails →** the owner's private email (the one this Cloudflare
account belongs to — do not publish it anywhere on the site). Then copy the
app's AUD tag + team domain into the Pages production env vars `CF_ACCESS_AUD`
and `CF_ACCESS_TEAM_DOMAIN`. Every admin/inspector API call then verifies the
Access JWT; nothing works without it in production.

## The workflow

1. **Start** — a paid, confirmed booking appears under "Ready to inspect".
   Tap **Start inspection**. This creates the one-and-only report draft for
   that booking (a database UNIQUE constraint makes duplicates impossible —
   repeated taps and refreshes just resume) and moves the request to
   `inspection_in_progress`.
2. **Author** — work through the checklist beside the vehicle:
   - Each item: **Pass / Attention / Fail / Not inspected / N/A** (big touch
     targets). "Not inspected" requires a reason: not accessible, unsafe to
     test, seller declined, equipment unavailable, or not supported.
   - **Details, notes & photos** per item: customer-facing explanation,
     internal inspector notes (never shown to the customer), measurement +
     unit, repair-estimate low/high, priority (Immediate / Soon / Monitor /
     Informational), safety-critical and negotiation-item flags, photos.
   - Conditional sections (**Diagnostic Scan, Road Test, Underbody**) can be
     marked performed / partial / not performed with a reason — their honest
     state is printed in the customer report.
   - Section tools: a customer-facing section summary and "mark remaining"
     bulk actions.
   - **Autosave**: every change saves ~1s after you stop typing. The save chip
     shows **Saving / Saved / Save failed / Offline — will retry** (automatic
     retry with backoff; leaving the page warns if anything is unsaved).
     Cross-device safety: if the report was saved from another device or tab,
     the editor refuses to clobber it and asks you to reload.
3. **Overall assessment** — score (1–10), verdict (**Proceed / Negotiate ·
   Repair First / Do Not Proceed**), executive summary, positive findings,
   negotiation summary, extra limitations. The standard non-removable
   disclaimer is always appended — a report can never claim the vehicle is
   guaranteed safe or problem-free.
4. **Preview & publish** — the preview page renders the report **exactly** as
   the customer will see it (same renderer, same data) plus a readiness
   checklist. Blocking issues (unresolved items, missing verdict/score/summary,
   missing not-inspected reasons) must be cleared; warnings (e.g. an Attention
   item without a customer explanation) are advisory. Publishing requires the
   report to be in **Ready for review** AND typing the request reference back —
   no accidental publishes.
5. **After publishing** — the version is locked forever:
   - An immutable snapshot (`report_versions`) is written; a DB trigger
     physically prevents rewriting a published payload.
   - The customer's secure portal gains a "Your inspection report" card with
     the branded HTML report and a **Download PDF** button; a fresh magic link
     is issued and the `report_ready` email is recorded (sent once a provider
     is configured — see the launch checklist).
   - The request walks to `completed`.
6. **Corrections = amendments** — tap **Create amendment** (a reason is
   required), edit, and publish again. The customer keeps seeing the last
   published version until the amendment is published as version N+1; the old
   version is marked superseded and kept forever. The customer report shows an
   "updated report" notice and the version history.

## Photos

Feature-flagged on Cloudflare R2 (`UPLOADS_ENABLED` + the `UPLOADS` binding).
While R2 is off, the editor says so and the text/checklist report works fully —
the PDF lists photo captions with a pointer to the online report. When R2 is
on: photos are downscaled to ≤1600px JPEG on the phone before upload, tied to
their finding, captionable, orderable, removable before publication, stored
under randomized private keys, streamed only through authorized endpoints, and
never visible to any other customer. A photo referenced by a published version
is never deleted from storage. Activation steps: `docs/PPI_R2_SETUP.md`.

## PDF

Generated in the Worker by a dependency-free PDF writer
(`functions/lib/pdf.ts` + `report-pdf.ts`) from the same immutable snapshot as
the HTML report — the two can never disagree. Branded, paginated, with version
number + publication timestamp on every page and embedded JPEG photos. When R2
is enabled the PDF is generated once at publish time and stored privately;
otherwise it is rendered on demand from the snapshot (same output). No paid
Cloudflare capability (Browser Rendering etc.) is used or required.

## Where things live

- API: `functions/api/inspector/*` (auth: `requireAdmin`, same as admin)
- Domain logic: `functions/lib/report.ts`, `report-template.ts` (the checklist),
  `pdf.ts`, `report-pdf.ts`
- UI: `inspector/*.html`, `assets/js/inspector-*.js`, `assets/js/report-render.js`,
  `assets/css/inspector.css`, `assets/css/report.css`
- Customer surface: `/ppi/portal/report/` + `/api/portal/report{,-pdf,-photo}`
- Schema: `migrations/0002_inspection_reports.sql` (+ `docs/PPI_REPORT_SCHEMA.md`)
- Audit trail: `report_audit` records every start/save-milestone/state
  change/publish/amendment/photo action with actor, timestamps, ids and state
  movement.
