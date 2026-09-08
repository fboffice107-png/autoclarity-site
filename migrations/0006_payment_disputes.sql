-- Stripe dispute lifecycle and funds movement are separate event streams.
-- Keep their clocks independent so out-of-order delivery on one axis cannot
-- suppress an authoritative event on the other.

CREATE TABLE payment_disputes (
  provider_dispute_id TEXT PRIMARY KEY
    CHECK (
      provider_dispute_id GLOB 'du_[A-Za-z0-9_]*'
      AND provider_dispute_id NOT GLOB '*[^A-Za-z0-9_]*'
      AND length(provider_dispute_id) <= 255
    ),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  payment_intent TEXT NOT NULL
    CHECK (
      payment_intent GLOB 'pi_[A-Za-z0-9_]*'
      AND payment_intent NOT GLOB '*[^A-Za-z0-9_]*'
      AND length(payment_intent) <= 255
    ),
  provider_charge_id TEXT NOT NULL
    CHECK (
      provider_charge_id GLOB 'ch_[A-Za-z0-9_]*'
      AND provider_charge_id NOT GLOB '*[^A-Za-z0-9_]*'
      AND length(provider_charge_id) <= 255
    ),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL
    CHECK (
      length(currency) = 3
      AND currency = lower(currency)
      AND currency NOT GLOB '*[^a-z]*'
    ),
  provider_created INTEGER NOT NULL CHECK (provider_created >= 0),

  provider_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (provider_status IN (
      'warning_needs_response', 'warning_under_review', 'warning_closed',
      'needs_response', 'under_review', 'won', 'lost', 'prevented', 'unknown'
    )),
  status_event_created INTEGER CHECK (status_event_created IS NULL OR status_event_created >= 0),
  status_event_id TEXT,

  funds_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (funds_state IN ('unknown', 'withdrawn', 'reinstated')),
  funds_event_created INTEGER CHECK (funds_event_created IS NULL OR funds_event_created >= 0),
  funds_event_id TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (
    (status_event_created IS NULL AND status_event_id IS NULL)
    OR (
      status_event_created IS NOT NULL
      AND status_event_id IS NOT NULL
      AND length(status_event_id) BETWEEN 1 AND 255
    )
  ),
  CHECK (
    (funds_event_created IS NULL AND funds_event_id IS NULL)
    OR (
      funds_event_created IS NOT NULL
      AND funds_event_id IS NOT NULL
      AND length(funds_event_id) BETWEEN 1 AND 255
    )
  ),
  CHECK (provider_status = 'unknown' OR status_event_created IS NOT NULL),
  CHECK (funds_state = 'unknown' OR funds_event_created IS NOT NULL)
);

CREATE INDEX idx_payment_disputes_payment
  ON payment_disputes(payment_id, provider_status, funds_state);

-- A signed event still must match the local payment identity. In particular,
-- cents from a different currency or PaymentIntent must never affect the row.
CREATE TRIGGER payment_disputes_payment_guard_insert
BEFORE INSERT ON payment_disputes
BEGIN
  -- D1's remote migration parser requires the CASE expression to be grouped.
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments WHERE id = NEW.payment_id
  ) THEN RAISE(ABORT, 'payment dispute payment does not exist') END);

  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments
    WHERE id = NEW.payment_id
      AND stripe_payment_intent = NEW.payment_intent
  ) THEN RAISE(ABORT, 'payment dispute PaymentIntent mismatch') END);

  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments
    WHERE id = NEW.payment_id
      AND lower(currency) = NEW.currency
  ) THEN RAISE(ABORT, 'payment dispute currency mismatch') END);

  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments
    WHERE id = NEW.payment_id
      AND NEW.amount_cents <= amount_cents
  ) THEN RAISE(ABORT, 'payment dispute amount exceeds payment amount') END);
END;

-- Stripe object identity is immutable. Only the independently ordered status
-- and funds axes, plus updated_at, may change after the first observation.
CREATE TRIGGER payment_disputes_identity_immutable
BEFORE UPDATE OF
  provider_dispute_id, payment_id, payment_intent, provider_charge_id,
  amount_cents, currency, provider_created
ON payment_disputes
WHEN NEW.provider_dispute_id IS NOT OLD.provider_dispute_id
  OR NEW.payment_id IS NOT OLD.payment_id
  OR NEW.payment_intent IS NOT OLD.payment_intent
  OR NEW.provider_charge_id IS NOT OLD.provider_charge_id
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.currency IS NOT OLD.currency
  OR NEW.provider_created IS NOT OLD.provider_created
BEGIN
  SELECT RAISE(ABORT, 'payment dispute identity is immutable');
END;
