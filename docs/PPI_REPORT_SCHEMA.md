# Inspection Report Schema (migration 0002)

D1 stores structured report data and metadata; R2 stores binaries (photos,
stored PDFs). Nothing large ever goes into D1.

## Tables

| Table | Purpose |
|---|---|
| `inspection_reports` | The single working report per request (`UNIQUE(request_id)` = one report per booking, enforced by the database). Holds visit facts (odometer, plate, VIN check, title/disclosure notes, seller notes), the overall assessment (score 1–10, verdict, summaries, extra limitations), the authoring `state`, the autosave concurrency counter, and the published-version pointer. |
| `report_sections` | Per-section status: `performed / partial / not_performed` + reason (`not_accessible / unsafe_to_test / seller_declined / equipment_unavailable / not_supported / not_applicable`) and a customer-facing section summary. |
| `report_items` | One row per checklist item with data. Identity comes from the code template (`functions/lib/report-template.ts`, `(report_id, item_key)` unique). Columns: result (`pass/attention/fail/not_inspected/not_applicable`), not-inspected reason, internal inspector notes, customer-facing note, **measurement value + unit**, **repair-estimate low/high (integer cents)**, priority (`immediate/soon/monitor/informational`), safety-critical + negotiation flags. |
| `report_photos` | Photo **metadata** only: randomized private R2 `object_key`, content type, size, dimensions, caption, sort order, optional `item_key`, soft-delete. The R2 object of a photo referenced by any published version is never deleted. |
| `report_versions` | **Immutable publication snapshots.** `payload_json` is the complete customer-facing report at publish time (+ `payload_sha256`); the HTML report and the PDF are both rendered from this payload. `kind` = original/amendment (+ reason), `status` = published/superseded, `pdf_object_key` when the PDF is stored in R2. A DB trigger (`trg_report_versions_immutable`) aborts any attempt to rewrite the snapshot columns. |
| `report_audit` | Every important action: actor, timestamp, action, report/request/version ids, previous and new state, details JSON. |
| `messages.dedupe_key` (added) | Idempotent notifications: a partial unique index guarantees an event (e.g. `report_ready:<versionId>`) can only ever be recorded/sent once. |

## Authoring states

`not_started` (virtual — no row yet) → `in_progress` → `draft_complete` →
`ready_for_review` → `published`. Publishing and amending have dedicated,
guarded endpoints; a published report reopens to `in_progress` only via the
amend action ("amending" in the UI while published versions exist).
Display adds `amended` (published, version ≥ 2) and `superseded`
(old version rows). The request status walks alongside:
`confirmed → inspection_in_progress → report_in_progress → completed`.

## Template versioning

Every report records `template_key` + `template_version`. The checklist can
evolve in code without corrupting stored reports; published snapshots carry
their full content regardless of later template changes. No inspection-point
count is advertised anywhere.

## Access rules (enforced in code, tested)

- Inspector endpoints require owner/staff auth (Access JWT in production,
  dev key in preview; fail-closed).
- Customer endpoints require the request's own magic token and only ever read
  **published** version snapshots — drafts and internal notes are not
  reachable on any customer path.
- Photos stream through authorized endpoints only (customer access
  additionally requires the photo to appear in a published version).
- No enumeration: all ids are random (`rpt_/rv_/rph_` + UUID), R2 keys are
  randomized, and portal access always starts from a 256-bit magic token.
