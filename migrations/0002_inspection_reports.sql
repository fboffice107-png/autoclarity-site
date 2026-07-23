-- Inspector Report Workspace schema.
-- One report per booking/request; normalized working draft (sections/items/
-- photos) plus IMMUTABLE published snapshots in report_versions. Customers
-- only ever read published version snapshots — never the working draft.
-- Large binaries (photos, PDFs) live in R2; D1 stores metadata + object keys.

-- --------------------------------------------------------- inspection_reports
-- The working report (draft state). UNIQUE(request_id) is the hard guarantee
-- that repeated "Start Inspection" taps can never create a second report.
CREATE TABLE inspection_reports (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES ppi_requests(id),
  booking_id TEXT REFERENCES bookings(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  quote_id TEXT REFERENCES quotes(id),
  -- Authoring state. "not_started" is virtual (no row yet). A published report
  -- being corrected goes back to 'in_progress' ("amending" when versions
  -- exist); the customer keeps seeing the latest published version.
  state TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (state IN ('in_progress','draft_complete','ready_for_review','published')),
  template_key TEXT NOT NULL DEFAULT 'ppi',
  template_version INTEGER NOT NULL DEFAULT 1,
  -- Inspection-visit facts recorded on site
  inspected_at TEXT,
  odometer_miles INTEGER,
  plate TEXT,
  plate_state TEXT,
  vin_check TEXT NOT NULL DEFAULT 'not_checked'
    CHECK (vin_check IN ('matches','mismatch','not_checked')),
  vin_observed TEXT,
  title_disclosure_notes TEXT,           -- title/disclosure info as reported by customer/seller
  seller_notes TEXT,                     -- seller/dealer info observed on site
  -- Overall assessment
  score REAL CHECK (score IS NULL OR (score >= 1 AND score <= 10)),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('proceed','negotiate_repair_first','do_not_proceed')),
  executive_summary TEXT,
  positive_findings TEXT,
  negotiation_summary TEXT,
  limitations_notes TEXT,                -- appended to the standard non-removable disclaimer
  -- Autosave optimistic-concurrency counter (guards cross-device clobbering)
  autosave_seq INTEGER NOT NULL DEFAULT 0,
  started_by TEXT NOT NULL,
  published_version_id TEXT,             -- latest published report_versions.id (no FK: created later in this file)
  published_at TEXT,                     -- first publication time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reports_state ON inspection_reports(state);
CREATE INDEX idx_reports_booking ON inspection_reports(booking_id);

-- ------------------------------------------------------------ report_sections
-- Section-level status: whether the section was performed at all, and the
-- honest reason when it was not (diagnostic scan, road test, underbody, …).
CREATE TABLE report_sections (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  section_key TEXT NOT NULL,
  performed TEXT NOT NULL DEFAULT 'performed'
    CHECK (performed IN ('performed','partial','not_performed')),
  not_performed_reason TEXT
    CHECK (not_performed_reason IS NULL OR not_performed_reason IN
      ('not_accessible','unsafe_to_test','seller_declined','equipment_unavailable','not_supported','not_applicable')),
  summary_note TEXT,                     -- customer-facing section summary
  updated_at TEXT NOT NULL,
  UNIQUE (report_id, section_key)
);
CREATE INDEX idx_report_sections_report ON report_sections(report_id);

-- --------------------------------------------------------------- report_items
-- One row per checklist item that has data. Item identity comes from the code
-- template (functions/lib/report-template.ts) — (report_id, item_key) unique.
-- Measurements and repair estimates are explicit columns on the finding they
-- belong to; money is integer cents like everywhere else in this schema.
CREATE TABLE report_items (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  section_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  result TEXT
    CHECK (result IS NULL OR result IN ('pass','attention','fail','not_inspected','not_applicable')),
  -- Honest differentiation of WHY something was not inspected
  not_inspected_reason TEXT
    CHECK (not_inspected_reason IS NULL OR not_inspected_reason IN
      ('not_accessible','unsafe_to_test','seller_declined','equipment_unavailable','not_supported')),
  inspector_notes TEXT,                  -- internal, never shown to the customer
  customer_note TEXT,                    -- customer-facing explanation
  measurement_value TEXT,                -- e.g. "3/32", "7", "13.9" (kept as text: tread fractions)
  measurement_unit TEXT,                 -- e.g. "32nds in", "mm", "V"
  cost_low_cents INTEGER CHECK (cost_low_cents IS NULL OR cost_low_cents >= 0),
  cost_high_cents INTEGER CHECK (cost_high_cents IS NULL OR cost_high_cents >= 0),
  priority TEXT
    CHECK (priority IS NULL OR priority IN ('immediate','soon','monitor','informational')),
  safety_critical INTEGER NOT NULL DEFAULT 0,
  negotiation_item INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (report_id, item_key)
);
CREATE INDEX idx_report_items_report ON report_items(report_id);

-- -------------------------------------------------------------- report_photos
-- Metadata only; bytes live in R2 under a randomized, non-enumerable key.
-- item_key NULL = general report photo. Soft-delete removes a photo from
-- future snapshots; the R2 object is only deleted when no published version
-- references the photo (published evidence is never destroyed).
CREATE TABLE report_photos (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  item_key TEXT,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  caption TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_report_photos_report ON report_photos(report_id);

-- ------------------------------------------------------------- report_versions
-- Immutable publication snapshots. payload_json is the complete customer-facing
-- report (data + photo references) at publication time; the HTML report and the
-- PDF are both rendered from THIS payload, so they can never disagree. A
-- version is never edited — corrections publish a new version (kind
-- 'amendment') and the previous one is marked superseded.
CREATE TABLE report_versions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','superseded')),
  kind TEXT NOT NULL DEFAULT 'original' CHECK (kind IN ('original','amendment')),
  amendment_reason TEXT,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  pdf_object_key TEXT,                   -- R2 key once the branded PDF is stored (R2 enabled)
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE (report_id, version)
);
CREATE INDEX idx_report_versions_report ON report_versions(report_id);
CREATE INDEX idx_report_versions_request ON report_versions(request_id);

-- Hard immutability: the snapshot content of a published version can never be
-- rewritten in place. Only status/superseded_at/pdf_object_key may change.
CREATE TRIGGER trg_report_versions_immutable
BEFORE UPDATE OF payload_json, payload_sha256, version, report_id, request_id, kind, published_by, published_at
ON report_versions
BEGIN
  SELECT RAISE(ABORT, 'report versions are immutable');
END;

-- ---------------------------------------------------------------- report_audit
-- Every important report action: who, when, what, on which report/version,
-- and the state movement where applicable.
CREATE TABLE report_audit (
  id TEXT PRIMARY KEY,
  report_id TEXT REFERENCES inspection_reports(id),
  request_id TEXT REFERENCES ppi_requests(id),
  version_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  prev_state TEXT,
  new_state TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_report_audit_report ON report_audit(report_id);
CREATE INDEX idx_report_audit_created ON report_audit(created_at);

-- ------------------------------------------------------- notification dedupe
-- Idempotent notification events: a message with a dedupe_key can only ever be
-- recorded once (publish retries / webhook-style replays cannot double-send).
ALTER TABLE messages ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_messages_dedupe ON messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
