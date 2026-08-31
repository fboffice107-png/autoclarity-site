-- Payment-operation claims and concurrency-safe appointment windows.

ALTER TABLE appointment_slots ADD COLUMN blocked_starts_at TEXT;
ALTER TABLE appointment_slots ADD COLUMN blocked_ends_at TEXT;
ALTER TABLE payments ADD COLUMN checkout_attempt INTEGER;

CREATE UNIQUE INDEX idx_payments_checkout_attempt
  ON payments(request_id, quote_id, booking_id, checkout_attempt)
  WHERE checkout_attempt IS NOT NULL;

-- Backfill existing rows with the configured total travel/report buffer. The
-- defaults mirror functions/lib/config.ts when no override is stored.
UPDATE appointment_slots
SET blocked_starts_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', starts_at,
      printf('-%d minutes', COALESCE(CAST((SELECT json_extract(
        CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END,
        '$.scheduling.travelBufferMin'
      ) FROM configuration WHERE key = 'ppi') AS INTEGER), 45))
    ),
    blocked_ends_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', ends_at,
      printf('+%d minutes', COALESCE(CAST((SELECT json_extract(
        CASE WHEN json_valid(value_json) THEN value_json ELSE '{}' END,
        '$.scheduling.reportBufferMin'
      ) FROM configuration WHERE key = 'ppi') AS INTEGER), 60))
    )
WHERE blocked_starts_at IS NULL OR blocked_ends_at IS NULL;

-- Production preflight: abort the migration before installing triggers if any
-- already-active windows overlap after the configured-buffer backfill. Resolve
-- those rows explicitly; silently choosing one could lose a real appointment.
CREATE TABLE migration_0004_overlap_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0004_overlap_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM appointment_slots a
  JOIN appointment_slots b ON a.id < b.id
  WHERE a.status IN ('offered', 'held', 'confirmed')
    AND b.status IN ('offered', 'held', 'confirmed')
    AND a.blocked_starts_at < b.blocked_ends_at
    AND a.blocked_ends_at > b.blocked_starts_at
);
DROP TABLE migration_0004_overlap_guard;

CREATE TRIGGER appointment_slots_no_overlap_insert
BEFORE INSERT ON appointment_slots
WHEN NEW.status IN ('offered', 'held', 'confirmed')
BEGIN
  -- D1's remote migration parser requires the CASE expression to be grouped.
  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM appointment_slots existing
    WHERE existing.status IN ('offered', 'held', 'confirmed')
      AND COALESCE(existing.blocked_starts_at, existing.starts_at) < COALESCE(NEW.blocked_ends_at, NEW.ends_at)
      AND COALESCE(existing.blocked_ends_at, existing.ends_at) > COALESCE(NEW.blocked_starts_at, NEW.starts_at)
  ) THEN RAISE(ABORT, 'appointment slot overlaps an active window') END);
END;

CREATE TRIGGER appointment_slots_no_overlap_update
BEFORE UPDATE OF starts_at, ends_at, blocked_starts_at, blocked_ends_at, status ON appointment_slots
WHEN NEW.status IN ('offered', 'held', 'confirmed')
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM appointment_slots existing
    WHERE existing.id != NEW.id
      AND existing.status IN ('offered', 'held', 'confirmed')
      AND COALESCE(existing.blocked_starts_at, existing.starts_at) < COALESCE(NEW.blocked_ends_at, NEW.ends_at)
      AND COALESCE(existing.blocked_ends_at, existing.ends_at) > COALESCE(NEW.blocked_starts_at, NEW.starts_at)
  ) THEN RAISE(ABORT, 'appointment slot overlaps an active window') END);
END;

CREATE TABLE refund_operations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  starting_refunded_cents INTEGER NOT NULL,
  requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN (
      'requested', 'pending', 'provider_accepted', 'requires_action',
      'confirmed', 'failed', 'canceled', 'reconciliation_required'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  provider_refund_id TEXT,
  last_provider_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payment_id, starting_refunded_cents)
);

CREATE INDEX idx_refund_operations_payment ON refund_operations(payment_id, created_at);

CREATE TABLE refund_operation_attempts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES refund_operations(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_refund_id TEXT UNIQUE,
  provider_status TEXT,
  outcome_status TEXT NOT NULL DEFAULT 'requested'
    CHECK (outcome_status IN (
      'requested', 'pending', 'provider_accepted', 'requires_action',
      'confirmed', 'failed', 'canceled', 'reconciliation_required'
    )),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (operation_id, attempt_no)
);

CREATE INDEX idx_refund_attempts_operation ON refund_operation_attempts(operation_id, attempt_no);
