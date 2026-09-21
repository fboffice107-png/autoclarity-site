-- 0014 — combined booking proposal + customer package selection.
--
-- Additive only. Every column is nullable or defaulted, every table is new,
-- and nothing existing is rewritten, so applying this migration leaves current
-- requests, quotes, payments, agreement evidence and reports untouched and an
-- in-flight booking keeps working on the schema it started on.

-- What the customer picked for themselves on the intake form, kept separate
-- from the rule engine's suggestion so disagreements stay visible.
ALTER TABLE ppi_requests ADD COLUMN customer_selected_tier TEXT;

-- 'customer' when they chose it, 'suggested' when they accepted our suggestion.
ALTER TABLE ppi_requests ADD COLUMN tier_selection_source TEXT;

-- 1 when the customer's pick differs from the suggestion (owner should look).
ALTER TABLE ppi_requests ADD COLUMN tier_review_needed INTEGER NOT NULL DEFAULT 0;

-- Free text describing what was modified, so "lightly modified" can show what
-- was actually modified instead of an unexplained label.
ALTER TABLE vehicles ADD COLUMN mod_details TEXT;

-- One row per booking proposal the owner sends: the quote, the offered times,
-- the customer-facing message and the notification outcome, all together. This
-- is what lets the dashboard show "saved / queued / sent / failed" truthfully
-- after a refresh, and what makes retry safe.
CREATE TABLE IF NOT EXISTS booking_proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  -- JSON array of appointment_slots.id offered by THIS proposal.
  slot_ids_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  customer_message TEXT,
  -- 'saved' (nothing sent yet) | 'sent' (provider accepted) | 'queued'
  -- (recorded, delivery unproven) | 'failed' (no delivery evidence)
  notification_status TEXT NOT NULL DEFAULT 'saved',
  notification_message_id TEXT,
  notification_error TEXT,
  -- Client-supplied key. The unique index below is what makes a double click,
  -- a retried fetch or a duplicated tab produce ONE proposal and ONE email.
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_proposals_idem
  ON booking_proposals(request_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_booking_proposals_request
  ON booking_proposals(request_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Alternatives for ONE inspection may share a buffer window.
--
-- The 0004 triggers treated every active slot as a reservation, so two options
-- offered to the same customer on the same afternoon always collided on the
-- travel/report buffers. With the shipped defaults (120 min inspection + 45 min
-- travel + 60 min report = a 3h45m blocked window) the three suggested template
-- times 09:00 / 12:30 / 16:00 overlap, which means the owner could never offer
-- more than one of them in a single action — the rest were silently dropped.
--
-- A slot only RESERVES capacity once it is held or confirmed. Two 'offered'
-- rows belonging to the same request are alternatives, not bookings, so they
-- are allowed to overlap each other and nothing else. Every cross-request
-- guarantee, and the exact-start-time unique index from 0001, are unchanged:
-- double-booking two customers remains impossible at the database level.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS appointment_slots_no_overlap_insert;
DROP TRIGGER IF EXISTS appointment_slots_no_overlap_update;

CREATE TRIGGER appointment_slots_no_overlap_insert
BEFORE INSERT ON appointment_slots
WHEN NEW.status IN ('offered', 'held', 'confirmed')
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM appointment_slots existing
    WHERE existing.status IN ('offered', 'held', 'confirmed')
      -- An 'offered' row on the SAME request is an alternative, not a
      -- reservation, so it never blocks that request's own slots. Held and
      -- confirmed rows still block everything, on every request.
      AND NOT (existing.request_id = NEW.request_id AND existing.status = 'offered')
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
      -- An 'offered' row on the SAME request is an alternative, not a
      -- reservation, so it never blocks that request's own slots. Held and
      -- confirmed rows still block everything, on every request.
      AND NOT (existing.request_id = NEW.request_id AND existing.status = 'offered')
      AND COALESCE(existing.blocked_starts_at, existing.starts_at) < COALESCE(NEW.blocked_ends_at, NEW.ends_at)
      AND COALESCE(existing.blocked_ends_at, existing.ends_at) > COALESCE(NEW.blocked_starts_at, NEW.starts_at)
  ) THEN RAISE(ABORT, 'appointment slot overlaps an active window') END);
END;
