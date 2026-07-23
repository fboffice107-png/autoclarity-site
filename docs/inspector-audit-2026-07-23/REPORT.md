# Inspector Report Workspace — build & verification report (2026-07-23)

Complete private report-authoring system built this session: inspector
dashboard/editor/preview at `/inspector/*`, D1 report schema with immutable
published versions, customer report page + branded Worker-generated PDF,
feature-flagged R2 photos, idempotent notifications, full test coverage.

## Verified locally (wrangler dev + local D1 + local R2)

Full workflow driven through the real UI in a browser: dev-key login →
dashboard shows the confirmed fixture → Start inspection → 104-item checklist
filled (segmented results, measurements, costs, priorities, safety/negotiation
flags, section not-performed reasons) → autosave (Saved/Saving states, seq
conflict guard) → resume after full page reload → photos uploaded to local R2
(item-tied + general, JPEG dimensions parsed) → draft complete → ready for
review → preview (customer-exact render, readiness checks caught a missing
customer note) → publish with typed-ref confirmation → request `completed` →
customer magic-link portal shows the report card → premium HTML report +
7-page branded PDF (2 embedded photos) → published version locked (423) →
DB trigger blocks snapshot rewrites → amendment (reason required) → customer
kept seeing v1 until v2 published → v1 superseded, sha unchanged → old magic
link revoked on rotation.

## Verified on the hosted Cloudflare preview (autoclarity-site.pages.dev)

28/28 checks passed against the deployed preview (see summary in
`docs/CURRENT_PPI_SESSION_HANDOFF.md`): real hosted booking fixture → inspector
queue → start (duplicate-start returns the same report) → multi-section
findings → resume → photos honestly refused with `uploads_disabled` (R2 not
enabled on the account) → draft invisible to the customer → readiness →
publish confirmation gate → v1 published (PDF on-demand; `pdfStored:false`) →
portal card → exact report + PDF download → cross-customer isolation →
locked draft → amendment → v2 + version history → notifications recorded
exactly once each, honestly `recorded` (no email provider yet) → noindex →
clean dynamic editor route → migrations 404.

## Mobile audit

Measured 35 page/width combos (320/360/375/390/414/768/1440 × dashboard,
editor, preview, customer report, customer portal) with headless Chrome
(puppeteer-core): **no horizontal overflow, no inputs under 16px** after two
fixes found by the audit (version-history table wrapped in its own
`overflow-x` container; `datetime-local` + `range` inputs forced to 16px).

## Screenshots (`screenshots/`)

Local (`http://localhost:8790`): `inspector-dashboard-{320,390,768,1440}`,
`inspector-editor-{320,390,768,1440}` (390 full-page), `inspector-preview-*`,
`customer-report-*` (390 full-page), `customer-portal-*`.
Hosted (`https://autoclarity-site.pages.dev`): `hosted-inspector-dashboard-390`,
`hosted-inspector-editor-390`, `hosted-inspector-preview-390` (full),
`hosted-customer-report-390` (full), `hosted-customer-portal-390`.

## Test totals

- Unit: **91** (66 existing + 25 new: template integrity, state machine,
  readiness rules, snapshot rollups/exclusions, PDF writer + renderer)
- Integration: **63** (34 existing regression + 29 new: auth, one-report-per-
  booking, autosave/conflict/validation, draft invisibility, photo
  upload/sniffing/isolation, publish gates, immutability, customer delivery,
  PDF, amendment, notification idempotency, noindex/dynamic-route hygiene)
- `tsc --noEmit` clean · 20 internal links OK · all header checks pass
