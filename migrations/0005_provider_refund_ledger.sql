-- Stripe Refund objects are the durable source of truth for refunded money.
-- A refund that once succeeded can later fail, so cumulative payment totals
-- must be derived from the current status of each provider Refund rather than
-- monotonically increased from charge.refunded snapshots.

-- Existing deployments can have cumulative refund balances without retained
-- Refund ids. Keep that legacy baseline locked until individual old Refund
-- objects arrive and can claim their exact amount into the new ledger.
CREATE TABLE payment_refund_ledger_state (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  legacy_refunded_cents INTEGER NOT NULL CHECK (legacy_refunded_cents >= 0),
  ledger_started_at INTEGER NOT NULL CHECK (ledger_started_at >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_refunds (
  provider_refund_id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  operation_id TEXT REFERENCES refund_operations(id),
  attempt_id TEXT REFERENCES refund_operation_attempts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  provider_created INTEGER CHECK (provider_created IS NULL OR provider_created >= 0),
  legacy_claim_cents INTEGER NOT NULL DEFAULT 0
    CHECK (legacy_claim_cents = 0 OR legacy_claim_cents = amount_cents),
  status TEXT NOT NULL
    CHECK (status IN ('pending','succeeded','requires_action','failed','canceled','unknown')),
  last_event_created INTEGER NOT NULL CHECK (last_event_created >= 0),
  last_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_provider_refunds_payment_status
  ON provider_refunds(payment_id, status);
CREATE INDEX idx_provider_refunds_operation
  ON provider_refunds(operation_id, attempt_id);

-- Backfill every provider Refund id already captured by an app-created refund
-- attempt. Event time zero intentionally loses to any real Stripe event.
INSERT OR IGNORE INTO provider_refunds
  (provider_refund_id, payment_id, operation_id, attempt_id, amount_cents,
   currency, provider_created, legacy_claim_cents, status, last_event_created,
   last_event_id, created_at, updated_at)
SELECT a.provider_refund_id,
       o.payment_id,
       o.id,
       a.id,
       o.requested_amount_cents,
       lower(COALESCE(p.currency, 'usd')),
       NULL,
       0,
       CASE
         WHEN a.outcome_status IN ('provider_accepted','confirmed') THEN 'succeeded'
         WHEN a.outcome_status IN ('pending','requires_action','failed','canceled') THEN a.outcome_status
         ELSE 'unknown'
       END,
       0,
       'migration:0005:' || a.id,
       a.created_at,
       a.updated_at
FROM refund_operation_attempts a
JOIN refund_operations o ON o.id = a.operation_id
JOIN payments p ON p.id = o.payment_id
WHERE a.provider_refund_id LIKE 're\_%' ESCAPE '\'
  AND a.provider_refund_id NOT GLOB '*[^A-Za-z0-9_]*';

INSERT INTO payment_refund_ledger_state
  (payment_id, legacy_refunded_cents, ledger_started_at, created_at, updated_at)
SELECT p.id,
       MAX(0, p.refunded_cents - COALESCE((
         SELECT SUM(pr.amount_cents)
         FROM provider_refunds pr
         WHERE pr.payment_id = p.id AND pr.status = 'succeeded'
       ), 0)),
       CAST(strftime('%s', 'now') AS INTEGER),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM payments p;

CREATE TABLE migration_0005_refund_total_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0005_refund_total_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM payments p
  LEFT JOIN payment_refund_ledger_state s ON s.payment_id = p.id
  WHERE COALESCE(s.legacy_refunded_cents, 0)
      - COALESCE((
          SELECT SUM(pr.legacy_claim_cents) FROM provider_refunds pr
          WHERE pr.payment_id = p.id
        ), 0)
      + COALESCE((
          SELECT SUM(pr.amount_cents) FROM provider_refunds pr
          WHERE pr.payment_id = p.id AND pr.status = 'succeeded'
        ), 0)
      NOT BETWEEN 0 AND p.amount_cents
);
DROP TABLE migration_0005_refund_total_guard;

-- An old Refund may claim only the still-unclaimed part of a legacy balance.
-- This trigger makes concurrent, out-of-order webhook inserts fail closed.
CREATE TRIGGER provider_refunds_legacy_claim_guard
BEFORE INSERT ON provider_refunds
WHEN NEW.legacy_claim_cents > 0
BEGIN
  SELECT (CASE WHEN NEW.provider_created IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM payment_refund_ledger_state s
      WHERE s.payment_id = NEW.payment_id
        AND NEW.provider_created < s.ledger_started_at
        AND NEW.legacy_claim_cents <= s.legacy_refunded_cents - COALESCE((
          SELECT SUM(existing.legacy_claim_cents)
          FROM provider_refunds existing
          WHERE existing.payment_id = NEW.payment_id
            AND existing.provider_refund_id != NEW.provider_refund_id
        ), 0)
    )
  THEN RAISE(ABORT, 'provider refund cannot claim legacy balance') END);
END;

CREATE TRIGGER provider_refunds_legacy_claim_guard_update
BEFORE UPDATE OF payment_id, provider_created, legacy_claim_cents ON provider_refunds
WHEN NEW.legacy_claim_cents > 0
BEGIN
  SELECT (CASE WHEN NEW.provider_created IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM payment_refund_ledger_state s
      WHERE s.payment_id = NEW.payment_id
        AND NEW.provider_created < s.ledger_started_at
        AND NEW.legacy_claim_cents <= s.legacy_refunded_cents - COALESCE((
          SELECT SUM(existing.legacy_claim_cents)
          FROM provider_refunds existing
          WHERE existing.payment_id = NEW.payment_id
            AND existing.provider_refund_id != OLD.provider_refund_id
        ), 0)
    )
  THEN RAISE(ABORT, 'provider refund cannot claim legacy balance') END);
END;

-- Never persist a succeeded-ledger total above the captured payment. Both
-- inserts and lifecycle updates fail atomically before corrupting the ledger.
CREATE TRIGGER provider_refunds_succeeded_total_guard_insert
BEFORE INSERT ON provider_refunds
BEGIN
  SELECT (CASE WHEN
    COALESCE((
      SELECT legacy_refunded_cents FROM payment_refund_ledger_state
      WHERE payment_id = NEW.payment_id
    ), 0)
    - COALESCE((
      SELECT SUM(existing.legacy_claim_cents) FROM provider_refunds existing
      WHERE existing.payment_id = NEW.payment_id
        AND existing.provider_refund_id != NEW.provider_refund_id
    ), 0)
    - NEW.legacy_claim_cents
    + COALESCE((
      SELECT SUM(existing.amount_cents) FROM provider_refunds existing
      WHERE existing.payment_id = NEW.payment_id AND existing.status = 'succeeded'
        AND existing.provider_refund_id != NEW.provider_refund_id
    ), 0)
    + CASE WHEN NEW.status = 'succeeded' THEN NEW.amount_cents ELSE 0 END
    > (SELECT amount_cents FROM payments WHERE id = NEW.payment_id)
  THEN RAISE(ABORT, 'provider refund total exceeds payment amount') END);
END;

CREATE TRIGGER provider_refunds_succeeded_total_guard_update
BEFORE UPDATE OF payment_id, amount_cents, status, legacy_claim_cents ON provider_refunds
BEGIN
  SELECT (CASE WHEN
    COALESCE((
      SELECT legacy_refunded_cents FROM payment_refund_ledger_state
      WHERE payment_id = NEW.payment_id
    ), 0)
    - COALESCE((
      SELECT SUM(existing.legacy_claim_cents) FROM provider_refunds existing
      WHERE existing.payment_id = NEW.payment_id
        AND existing.provider_refund_id != OLD.provider_refund_id
    ), 0)
    - NEW.legacy_claim_cents
    + COALESCE((
      SELECT SUM(existing.amount_cents) FROM provider_refunds existing
      WHERE existing.payment_id = NEW.payment_id AND existing.status = 'succeeded'
        AND existing.provider_refund_id != OLD.provider_refund_id
    ), 0)
    + CASE WHEN NEW.status = 'succeeded' THEN NEW.amount_cents ELSE 0 END
    > (SELECT amount_cents FROM payments WHERE id = NEW.payment_id)
  THEN RAISE(ABORT, 'provider refund total exceeds payment amount') END);
END;
