-- Checkout-attempt hardening (2026-07-25).
--
-- Purpose: a customer must never end up with two live Stripe Checkout Sessions
-- for the same request (double-charge risk). Two additive columns let the
-- portal hand back the SAME session URL while it is still open, and a partial
-- unique index makes "at most one open payment attempt per request" a database
-- invariant rather than an application convention.
--
-- Additive only: no rows are read, rewritten or deleted. Existing payments keep
-- NULL in the new columns, which simply means "no reusable session recorded".
--
-- NOTE: the code that reads these columns runs only when PAYMENTS_ENABLED=true.
-- Production runs with payments disabled, so applying this migration is a
-- prerequisite for enabling Stripe, not for the current deployment.

ALTER TABLE payments ADD COLUMN checkout_url TEXT;
ALTER TABLE payments ADD COLUMN session_expires_at TEXT;

-- At most one open (created/pending) payment attempt per request.
CREATE UNIQUE INDEX idx_payments_one_open_attempt
  ON payments(request_id) WHERE status IN ('created','pending');
