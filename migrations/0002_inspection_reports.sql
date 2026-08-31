-- Inspection-report schema already present in production but missing from the
-- migration journal recovered with the repository. Every object operation is
-- idempotent so this file can both build a fresh environment and safely record
-- 0002 against the matching production schema after a reviewed backup/audit.
-- Fresh environments receive messages.dedupe_key from the 0001 baseline;
-- production already has the same additive column.

CREATE TABLE IF NOT EXISTS inspection_reports (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES ppi_requests(id),
  booking_id TEXT REFERENCES bookings(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  quote_id TEXT REFERENCES quotes(id),

  state TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (state IN ('in_progress','draft_complete','ready_for_review','published')),
  template_key TEXT NOT NULL DEFAULT 'ppi',
  template_version INTEGER NOT NULL DEFAULT 1,

  inspected_at TEXT,
  odometer_miles INTEGER,
  plate TEXT,
  plate_state TEXT,
  vin_check TEXT NOT NULL DEFAULT 'not_checked'
    CHECK (vin_check IN ('matches','mismatch','not_checked')),
  vin_observed TEXT,
  title_disclosure_notes TEXT,
  seller_notes TEXT,

  score REAL CHECK (score IS NULL OR (score >= 1 AND score <= 10)),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('proceed','negotiate_repair_first','do_not_proceed')),
  executive_summary TEXT,
  positive_findings TEXT,
  negotiation_summary TEXT,
  limitations_notes TEXT,

  autosave_seq INTEGER NOT NULL DEFAULT 0,
  started_by TEXT NOT NULL,
  published_version_id TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_booking ON inspection_reports(booking_id);
CREATE INDEX IF NOT EXISTS idx_reports_state ON inspection_reports(state);

CREATE TABLE IF NOT EXISTS report_sections (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  section_key TEXT NOT NULL,
  performed TEXT NOT NULL DEFAULT 'performed'
    CHECK (performed IN ('performed','partial','not_performed')),
  not_performed_reason TEXT
    CHECK (not_performed_reason IS NULL OR not_performed_reason IN
      ('not_accessible','unsafe_to_test','seller_declined','equipment_unavailable','not_supported','not_applicable')),
  summary_note TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (report_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_report_sections_report ON report_sections(report_id);

CREATE TABLE IF NOT EXISTS report_items (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  section_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  result TEXT
    CHECK (result IS NULL OR result IN ('pass','attention','fail','not_inspected','not_applicable')),
  not_inspected_reason TEXT
    CHECK (not_inspected_reason IS NULL OR not_inspected_reason IN
      ('not_accessible','unsafe_to_test','seller_declined','equipment_unavailable','not_supported')),
  inspector_notes TEXT,
  customer_note TEXT,
  measurement_value TEXT,
  measurement_unit TEXT,
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
CREATE INDEX IF NOT EXISTS idx_report_items_report ON report_items(report_id);

CREATE TABLE IF NOT EXISTS report_photos (
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
CREATE INDEX IF NOT EXISTS idx_report_photos_report ON report_photos(report_id);

CREATE TABLE IF NOT EXISTS report_versions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','superseded')),
  kind TEXT NOT NULL DEFAULT 'original' CHECK (kind IN ('original','amendment')),
  amendment_reason TEXT,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  pdf_object_key TEXT,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE (report_id, version)
);
CREATE INDEX IF NOT EXISTS idx_report_versions_report ON report_versions(report_id);
CREATE INDEX IF NOT EXISTS idx_report_versions_request ON report_versions(request_id);

CREATE TRIGGER IF NOT EXISTS trg_report_versions_immutable
BEFORE UPDATE OF payload_json, payload_sha256, version, report_id, request_id, kind, published_by, published_at
ON report_versions
BEGIN
  SELECT RAISE(ABORT, 'report versions are immutable');
END;

CREATE TABLE IF NOT EXISTS report_audit (
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
CREATE INDEX IF NOT EXISTS idx_report_audit_created ON report_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_report_audit_report ON report_audit(report_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
