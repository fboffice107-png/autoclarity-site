-- AutoClarity Las Vegas PPI portal — initial schema.
-- D1 (SQLite). All money values are integer cents. All timestamps are
-- ISO-8601 UTC strings. Soft deletion via deleted_at where retention matters.

-- ---------------------------------------------------------------- customers
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  preferred_contact TEXT NOT NULL DEFAULT 'email'
    CHECK (preferred_contact IN ('email','phone','text')),
  transactional_consent INTEGER NOT NULL DEFAULT 0,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_customers_email ON customers(email);

-- ----------------------------------------------------------------- vehicles
CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  year INTEGER,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT,
  mileage INTEGER,
  vin TEXT,
  vin_decoded_json TEXT,
  asking_price_cents INTEGER,
  expected_price_cents INTEGER,
  listing_url TEXT,
  mod_status TEXT NOT NULL DEFAULT 'stock'
    CHECK (mod_status IN ('stock','light','heavy')),
  warning_lights TEXT,
  known_issues TEXT,
  title_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (title_status IN ('clean','salvage_rebuilt','unknown')),
  starts_drives TEXT NOT NULL DEFAULT 'unknown'
    CHECK (starts_drives IN ('yes','no','unknown')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_vehicles_vin ON vehicles(vin);

-- ------------------------------------------------------------- ppi_requests
CREATE TABLE ppi_requests (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,              -- human reference e.g. PPI-260721-K4TQ
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  status TEXT NOT NULL DEFAULT 'submitted',
  -- inspection location (where the VEHICLE is, not the buyer's home)
  loc_street TEXT,
  loc_unit TEXT,
  loc_city TEXT,
  loc_state TEXT,
  loc_zip TEXT,
  seller_type TEXT CHECK (seller_type IN ('dealership','private','unknown')),
  seller_name TEXT,
  seller_phone TEXT,
  loc_notes TEXT,
  access_notes TEXT,
  lift_available TEXT NOT NULL DEFAULT 'unknown' CHECK (lift_available IN ('yes','no','unknown')),
  level_surface TEXT NOT NULL DEFAULT 'unknown' CHECK (level_surface IN ('yes','no','unknown')),
  -- seller permission
  perm_inspection INTEGER NOT NULL DEFAULT 0,
  perm_scan INTEGER NOT NULL DEFAULT 0,
  perm_road_test TEXT NOT NULL DEFAULT 'unknown' CHECK (perm_road_test IN ('yes','no','unknown')),
  perm_photos TEXT NOT NULL DEFAULT 'unknown' CHECK (perm_photos IN ('yes','no','unknown')),
  perm_underbody TEXT NOT NULL DEFAULT 'unknown' CHECK (perm_underbody IN ('yes','no','unknown')),
  ack_access_dependent INTEGER NOT NULL DEFAULT 0,
  -- timing
  decision_timeline TEXT,
  preferred_dates TEXT,
  time_window TEXT CHECK (time_window IN ('morning','afternoon','flexible')),
  same_day_priority INTEGER NOT NULL DEFAULT 0,
  customer_notes TEXT,
  -- quoting context
  travel_miles REAL,
  travel_estimate_basis TEXT,            -- 'zip_centroid' | 'manual' | 'unknown'
  suggested_tier TEXT,
  manual_review_reasons TEXT,            -- JSON array of strings, admin-facing
  internal_notes TEXT,                   -- admin-only, never sent to customer
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_requests_status ON ppi_requests(status);
CREATE INDEX idx_requests_created ON ppi_requests(created_at);
CREATE INDEX idx_requests_customer ON ppi_requests(customer_id);

-- ---------------------------------------------------------- request_uploads
CREATE TABLE request_uploads (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  object_key TEXT NOT NULL UNIQUE,       -- randomized R2 key; bucket is private
  original_name TEXT NOT NULL,           -- sanitized display name only
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('listing','vin','dashboard','damage','other')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_uploads_request ON request_uploads(request_id);

-- ------------------------------------------------------------------- quotes
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','accepted','superseded','expired','cancelled')),
  tier TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  subtotal_cents INTEGER NOT NULL,
  travel_cents INTEGER NOT NULL DEFAULT 0,
  addons_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  admin_note_internal TEXT,
  customer_note TEXT,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (request_id, version)
);
CREATE INDEX idx_quotes_request ON quotes(request_id);

CREATE TABLE quote_line_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  kind TEXT NOT NULL CHECK (kind IN ('base','travel','addon','discount')),
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_line_items_quote ON quote_line_items(quote_id);

-- -------------------------------------------------------- appointment_slots
CREATE TABLE appointment_slots (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered','held','confirmed','released','expired','cancelled')),
  hold_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_slots_request ON appointment_slots(request_id);
-- Hard double-booking guard: at most one held/confirmed slot per start time.
CREATE UNIQUE INDEX idx_slots_no_double_booking
  ON appointment_slots(starts_at) WHERE status IN ('held','confirmed');

-- ----------------------------------------------------------------- bookings
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES ppi_requests(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  slot_id TEXT REFERENCES appointment_slots(id),
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','confirmed','completed','cancelled','refunded')),
  confirmed_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ----------------------------------------------------- agreements & consent
CREATE TABLE agreement_versions (
  id TEXT PRIMARY KEY,
  doc_key TEXT NOT NULL,                 -- e.g. 'service_agreement'
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (doc_key, version)
);

CREATE TABLE agreement_acceptances (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  quote_id TEXT REFERENCES quotes(id),
  agreement_version_id TEXT NOT NULL REFERENCES agreement_versions(id),
  typed_name TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 1,
  ip TEXT,                               -- disclosed in privacy notice
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_acceptances_request ON agreement_acceptances(request_id);

-- ----------------------------------------------------------------- payments
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  booking_id TEXT REFERENCES bookings(id),
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','pending','succeeded','failed','expired','refunded','partially_refunded','disputed')),
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_request ON payments(request_id);

-- Webhook replay guard: every processed Stripe event id is recorded once.
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

-- ----------------------------------------------------------------- messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES ppi_requests(id),
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound','internal')),
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','portal')),
  template TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded','sent','failed')),
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_request ON messages(request_id);

-- ----------------------------------------------------------- status_history
CREATE TABLE status_history (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,                   -- 'customer' | 'admin:<email>' | 'system:<what>'
  reason TEXT,
  related_id TEXT,                       -- payment/slot/quote id where applicable
  created_at TEXT NOT NULL
);
CREATE INDEX idx_history_request ON status_history(request_id);

-- ---------------------------------------------------------- admin_audit_log
CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON admin_audit_log(created_at);

-- ------------------------------------------------------------ configuration
CREATE TABLE configuration (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- -------------------------------------------------------------- magic_links
CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  token_hash TEXT NOT NULL UNIQUE,       -- SHA-256 of the token; raw token never stored
  purpose TEXT NOT NULL DEFAULT 'portal' CHECK (purpose IN ('portal')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_magic_links_request ON magic_links(request_id);

-- -------------------------------------------------------------- rate_limits
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,                  -- hashed key + route
  window_start INTEGER NOT NULL,         -- unix seconds bucketed by window
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);

-- --------------------------------------------------------- analytics_events
-- Funnel counters only. No PII, no free text, by design.
CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  step TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_analytics_event ON analytics_events(event, created_at);

-- ---------------------------------------------------------------- vin_cache
CREATE TABLE vin_cache (
  vin TEXT PRIMARY KEY,
  decoded_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- ----------------------------------------------------------------- waitlist
-- Used only in PPI_MODE=waitlist: launch-list signups, nothing more.
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  zip TEXT,
  created_at TEXT NOT NULL
);
