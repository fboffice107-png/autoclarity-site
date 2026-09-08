-- Bind every payable quote and payment to one immutable, internally consistent
-- monetary identity. Draft quotes remain editable; leaving draft is the commit
-- point after which their priced fields and line items are evidence.

-- Every historical committed quote must already be internally exact, including
-- expired/cancelled evidence. Any quote used by a payment is independently
-- checked below regardless of its current lifecycle status.
CREATE TABLE migration_0008_quote_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0008_quote_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM quotes q
  WHERE q.status <> 'draft'
    AND (
      q.currency <> 'usd'
      OR typeof(q.subtotal_cents) <> 'integer'
      OR typeof(q.travel_cents) <> 'integer'
      OR typeof(q.addons_cents) <> 'integer'
      OR typeof(q.discount_cents) <> 'integer'
      OR typeof(q.total_cents) <> 'integer'
      OR q.subtotal_cents <= 0
      OR q.subtotal_cents > 9007199254740991
      OR q.travel_cents < 0
      OR q.travel_cents > 9007199254740991
      OR q.addons_cents < 0
      OR q.addons_cents > 9007199254740991
      OR q.discount_cents < 0
      OR q.discount_cents > 9007199254740991
      OR q.total_cents <= 0
      OR q.total_cents > 9007199254740991
      OR q.total_cents <> q.subtotal_cents + q.travel_cents + q.addons_cents - q.discount_cents
      OR EXISTS (
        SELECT 1 FROM quote_line_items li
        WHERE li.quote_id = q.id
          AND (
            typeof(li.amount_cents) <> 'integer'
            OR abs(li.amount_cents) > 9007199254740991
            OR (li.kind IN ('base', 'travel', 'addon') AND li.amount_cents <= 0)
            OR (li.kind = 'discount' AND li.amount_cents >= 0)
          )
      )
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'base'), 0) <> q.subtotal_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'travel'), 0) <> q.travel_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'addon'), 0) <> q.addons_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'discount'), 0) <> -q.discount_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id), 0) <> q.total_cents
    )
);
DROP TABLE migration_0008_quote_guard;

-- Every booking must point at a committed quote for its own request. The
-- one-booking-per-request row may later move to a refreshed quote, but only
-- after every payment claim against its current identity is provider-terminal
-- and nonfinancial (failed or expired).
CREATE TABLE migration_0008_booking_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0008_booking_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM bookings b
  WHERE NOT EXISTS (
    SELECT 1
    FROM quotes q
    WHERE q.id = b.quote_id
      AND q.request_id = b.request_id
      AND q.status <> 'draft'
  )
);
DROP TABLE migration_0008_booking_guard;

-- Every historical payment must bind one non-draft quote and a booking for the
-- same request, for the quote's exact positive USD total. Every payment must
-- match the booking's current quote except a provider-terminal failed/expired
-- attempt retained as immutable historical evidence after a safe re-quote.
CREATE TABLE migration_0008_payment_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0008_payment_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM payments p
  WHERE typeof(p.amount_cents) <> 'integer'
    OR p.amount_cents <= 0
    OR p.amount_cents > 9007199254740991
    OR typeof(p.refunded_cents) <> 'integer'
    OR p.refunded_cents < 0
    OR p.refunded_cents > p.amount_cents
    OR p.currency <> 'usd'
    OR p.booking_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM quotes q
      JOIN bookings b ON b.id = p.booking_id
      WHERE q.id = p.quote_id
        AND q.status <> 'draft'
        AND q.request_id = p.request_id
        AND b.request_id = p.request_id
        AND (p.status IN ('failed', 'expired') OR b.quote_id = p.quote_id)
        AND q.currency = p.currency
        AND q.total_cents = p.amount_cents
        AND (CASE WHEN q.currency = 'usd'
        AND typeof(q.subtotal_cents) = 'integer'
        AND typeof(q.travel_cents) = 'integer'
        AND typeof(q.addons_cents) = 'integer'
        AND typeof(q.discount_cents) = 'integer'
        AND typeof(q.total_cents) = 'integer'
        AND q.subtotal_cents > 0
        AND q.subtotal_cents <= 9007199254740991
        AND q.travel_cents >= 0
        AND q.travel_cents <= 9007199254740991
        AND q.addons_cents >= 0
        AND q.addons_cents <= 9007199254740991
        AND q.discount_cents >= 0
        AND q.discount_cents <= 9007199254740991
        AND q.total_cents > 0
        AND q.total_cents <= 9007199254740991
        AND q.total_cents = q.subtotal_cents + q.travel_cents + q.addons_cents - q.discount_cents
        THEN 1 ELSE 0 END) = 1
        AND (CASE WHEN NOT EXISTS (
          SELECT 1 FROM quote_line_items li
          WHERE li.quote_id = q.id
            AND (
              typeof(li.amount_cents) <> 'integer'
              OR abs(li.amount_cents) > 9007199254740991
              OR (li.kind IN ('base', 'travel', 'addon') AND li.amount_cents <= 0)
              OR (li.kind = 'discount' AND li.amount_cents >= 0)
            )
        )
        THEN 1 ELSE 0 END) = 1
        AND (CASE WHEN COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'base'), 0) = q.subtotal_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'travel'), 0) = q.travel_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'addon'), 0) = q.addons_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'discount'), 0) = -q.discount_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id), 0) = q.total_cents
        THEN 1 ELSE 0 END) = 1
    )
);
DROP TABLE migration_0008_payment_guard;

-- Keep payment-linked quote validation in smaller independent statements so
-- Cloudflare D1's expression-depth limit cannot weaken any monetary check.
CREATE TABLE migration_0008_payment_quote_component_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0008_payment_quote_component_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM payments p
  LEFT JOIN quotes q ON q.id = p.quote_id
  WHERE q.id IS NULL
    OR q.status = 'draft'
    OR q.request_id <> p.request_id
    OR q.currency <> p.currency
    OR q.total_cents <> p.amount_cents
    OR q.currency <> 'usd'
    OR typeof(q.subtotal_cents) <> 'integer'
    OR typeof(q.travel_cents) <> 'integer'
    OR typeof(q.addons_cents) <> 'integer'
    OR typeof(q.discount_cents) <> 'integer'
    OR typeof(q.total_cents) <> 'integer'
    OR q.subtotal_cents <= 0
    OR q.subtotal_cents > 9007199254740991
    OR q.travel_cents < 0
    OR q.travel_cents > 9007199254740991
    OR q.addons_cents < 0
    OR q.addons_cents > 9007199254740991
    OR q.discount_cents < 0
    OR q.discount_cents > 9007199254740991
    OR q.total_cents <= 0
    OR q.total_cents > 9007199254740991
    OR q.total_cents <> q.subtotal_cents + q.travel_cents + q.addons_cents - q.discount_cents
);
DROP TABLE migration_0008_payment_quote_component_guard;

CREATE TABLE migration_0008_payment_quote_line_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0008_payment_quote_line_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM payments p
  JOIN quote_line_items li ON li.quote_id = p.quote_id
  WHERE typeof(li.amount_cents) <> 'integer'
    OR abs(li.amount_cents) > 9007199254740991
    OR (li.kind IN ('base', 'travel', 'addon') AND li.amount_cents <= 0)
    OR (li.kind = 'discount' AND li.amount_cents >= 0)
);
DROP TABLE migration_0008_payment_quote_line_guard;

CREATE TABLE migration_0008_payment_quote_sum_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0008_payment_quote_sum_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM payments p
  JOIN quotes q ON q.id = p.quote_id
  WHERE COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'base'), 0) <> q.subtotal_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'travel'), 0) <> q.travel_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'addon'), 0) <> q.addons_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'discount'), 0) <> -q.discount_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id), 0) <> q.total_cents
);
DROP TABLE migration_0008_payment_quote_sum_guard;

-- Stripe object ids are exact provider identities. Existing values must be
-- non-blank and unambiguous before the unique indexes and set-once triggers are
-- installed. NULL remains valid until Checkout/the webhook supplies the id.
CREATE TABLE migration_0008_stripe_identity_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO migration_0008_stripe_identity_guard (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM payments p
  WHERE (
      p.stripe_session_id IS NOT NULL
      AND (
        length(trim(p.stripe_session_id)) = 0
        OR p.stripe_session_id <> trim(p.stripe_session_id)
      )
    )
    OR (
      p.stripe_payment_intent IS NOT NULL
      AND (
        length(trim(p.stripe_payment_intent)) = 0
        OR p.stripe_payment_intent <> trim(p.stripe_payment_intent)
      )
    )
    OR (
      p.stripe_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM payments duplicate
        WHERE duplicate.id <> p.id
          AND duplicate.stripe_session_id = p.stripe_session_id
      )
    )
    OR (
      p.stripe_payment_intent IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM payments duplicate
        WHERE duplicate.id <> p.id
          AND duplicate.stripe_payment_intent = p.stripe_payment_intent
      )
    )
);
DROP TABLE migration_0008_stripe_identity_guard;

-- The baseline schema already has a UNIQUE constraint for Checkout Session ids;
-- the named partial indexes make both provider identities explicit and give
-- PaymentIntents the same non-NULL uniqueness guarantee.
CREATE UNIQUE INDEX idx_payments_stripe_session_identity
  ON payments(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX idx_payments_stripe_intent_identity
  ON payments(stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;

-- Child rows cannot exist before their quote, so non-draft quotes must always be
-- inserted as drafts, receive their line items, and then cross the commit point.
CREATE TRIGGER quotes_require_draft_insert
BEFORE INSERT ON quotes
WHEN NEW.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'quote must be inserted as draft before use');
END;

CREATE TRIGGER quotes_validate_before_use
BEFORE UPDATE OF status ON quotes
WHEN OLD.status = 'draft' AND NEW.status <> 'draft'
BEGIN
  SELECT (CASE WHEN
    NEW.currency <> 'usd'
    OR typeof(NEW.subtotal_cents) <> 'integer'
    OR typeof(NEW.travel_cents) <> 'integer'
    OR typeof(NEW.addons_cents) <> 'integer'
    OR typeof(NEW.discount_cents) <> 'integer'
    OR typeof(NEW.total_cents) <> 'integer'
    OR NEW.subtotal_cents <= 0
    OR NEW.subtotal_cents > 9007199254740991
    OR NEW.travel_cents < 0
    OR NEW.travel_cents > 9007199254740991
    OR NEW.addons_cents < 0
    OR NEW.addons_cents > 9007199254740991
    OR NEW.discount_cents < 0
    OR NEW.discount_cents > 9007199254740991
    OR NEW.total_cents <= 0
    OR NEW.total_cents > 9007199254740991
    OR NEW.total_cents <> NEW.subtotal_cents + NEW.travel_cents + NEW.addons_cents - NEW.discount_cents
    OR EXISTS (
      SELECT 1 FROM quote_line_items li
      WHERE li.quote_id = NEW.id
        AND (
          typeof(li.amount_cents) <> 'integer'
          OR abs(li.amount_cents) > 9007199254740991
          OR (li.kind IN ('base', 'travel', 'addon') AND li.amount_cents <= 0)
          OR (li.kind = 'discount' AND li.amount_cents >= 0)
        )
    )
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = NEW.id AND li.kind = 'base'), 0) <> NEW.subtotal_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = NEW.id AND li.kind = 'travel'), 0) <> NEW.travel_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = NEW.id AND li.kind = 'addon'), 0) <> NEW.addons_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = NEW.id AND li.kind = 'discount'), 0) <> -NEW.discount_cents
    OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = NEW.id), 0) <> NEW.total_cents
  THEN RAISE(ABORT, 'quote monetary components and line items must match before use') END);
END;

CREATE TRIGGER quotes_no_return_to_draft
BEFORE UPDATE OF status ON quotes
WHEN OLD.status <> 'draft' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'committed quote cannot return to draft');
END;

CREATE TRIGGER quotes_monetary_identity_immutable
BEFORE UPDATE OF
  id, request_id, version, tier, currency, subtotal_cents, travel_cents,
  addons_cents, discount_cents, total_cents
ON quotes
WHEN OLD.status <> 'draft'
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.request_id IS NOT OLD.request_id
    OR NEW.version IS NOT OLD.version
    OR NEW.tier IS NOT OLD.tier
    OR NEW.currency IS NOT OLD.currency
    OR NEW.subtotal_cents IS NOT OLD.subtotal_cents
    OR NEW.travel_cents IS NOT OLD.travel_cents
    OR NEW.addons_cents IS NOT OLD.addons_cents
    OR NEW.discount_cents IS NOT OLD.discount_cents
    OR NEW.total_cents IS NOT OLD.total_cents
  )
BEGIN
  SELECT RAISE(ABORT, 'committed quote monetary identity is immutable');
END;

CREATE TRIGGER quote_line_items_draft_only_insert
BEFORE INSERT ON quote_line_items
WHEN COALESCE((SELECT status FROM quotes WHERE id = NEW.quote_id), '') <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'quote line items are editable only while draft');
END;

CREATE TRIGGER quote_line_items_draft_only_update
BEFORE UPDATE ON quote_line_items
WHEN COALESCE((SELECT status FROM quotes WHERE id = OLD.quote_id), '') <> 'draft'
  OR COALESCE((SELECT status FROM quotes WHERE id = NEW.quote_id), '') <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'quote line items are editable only while draft');
END;

CREATE TRIGGER quote_line_items_draft_only_delete
BEFORE DELETE ON quote_line_items
WHEN COALESCE((SELECT status FROM quotes WHERE id = OLD.quote_id), '') <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'quote line items are editable only while draft');
END;

CREATE TRIGGER payments_identity_guard_insert
BEFORE INSERT ON payments
BEGIN
  SELECT (CASE WHEN
    typeof(NEW.amount_cents) <> 'integer'
    OR NEW.amount_cents <= 0
    OR NEW.amount_cents > 9007199254740991
    OR typeof(NEW.refunded_cents) <> 'integer'
    OR NEW.refunded_cents < 0
    OR NEW.refunded_cents > NEW.amount_cents
    OR NEW.currency <> 'usd'
    OR NEW.booking_id IS NULL
    OR (
      NEW.stripe_session_id IS NOT NULL
      AND (
        length(trim(NEW.stripe_session_id)) = 0
        OR NEW.stripe_session_id <> trim(NEW.stripe_session_id)
      )
    )
    OR (
      NEW.stripe_payment_intent IS NOT NULL
      AND (
        length(trim(NEW.stripe_payment_intent)) = 0
        OR NEW.stripe_payment_intent <> trim(NEW.stripe_payment_intent)
      )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM quotes q
      JOIN bookings b ON b.id = NEW.booking_id
      WHERE q.id = NEW.quote_id
        AND q.status <> 'draft'
        AND q.request_id = NEW.request_id
        AND b.request_id = NEW.request_id
        AND b.quote_id = NEW.quote_id
        AND q.currency = NEW.currency
        AND q.total_cents = NEW.amount_cents
        AND (CASE WHEN q.currency = 'usd'
        AND typeof(q.subtotal_cents) = 'integer'
        AND typeof(q.travel_cents) = 'integer'
        AND typeof(q.addons_cents) = 'integer'
        AND typeof(q.discount_cents) = 'integer'
        AND typeof(q.total_cents) = 'integer'
        AND q.subtotal_cents > 0
        AND q.subtotal_cents <= 9007199254740991
        AND q.travel_cents >= 0
        AND q.travel_cents <= 9007199254740991
        AND q.addons_cents >= 0
        AND q.addons_cents <= 9007199254740991
        AND q.discount_cents >= 0
        AND q.discount_cents <= 9007199254740991
        AND q.total_cents > 0
        AND q.total_cents <= 9007199254740991
        AND q.total_cents = q.subtotal_cents + q.travel_cents + q.addons_cents - q.discount_cents
        THEN 1 ELSE 0 END) = 1
        AND (CASE WHEN NOT EXISTS (
          SELECT 1 FROM quote_line_items li
          WHERE li.quote_id = q.id
            AND (
              typeof(li.amount_cents) <> 'integer'
              OR abs(li.amount_cents) > 9007199254740991
              OR (li.kind IN ('base', 'travel', 'addon') AND li.amount_cents <= 0)
              OR (li.kind = 'discount' AND li.amount_cents >= 0)
            )
        )
        THEN 1 ELSE 0 END) = 1
        AND (CASE WHEN COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'base'), 0) = q.subtotal_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'travel'), 0) = q.travel_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'addon'), 0) = q.addons_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'discount'), 0) = -q.discount_cents
        AND COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id), 0) = q.total_cents
        THEN 1 ELSE 0 END) = 1
    )
  THEN RAISE(ABORT, 'payment identity does not match quote and booking') END);
END;

CREATE TRIGGER payments_quote_component_guard_insert
BEFORE INSERT ON payments
WHEN NOT EXISTS (
  SELECT 1
  FROM quotes q
  WHERE q.id = NEW.quote_id
    AND q.status <> 'draft'
    AND q.request_id = NEW.request_id
    AND q.currency = NEW.currency
    AND q.total_cents = NEW.amount_cents
    AND q.currency = 'usd'
    AND typeof(q.subtotal_cents) = 'integer'
    AND typeof(q.travel_cents) = 'integer'
    AND typeof(q.addons_cents) = 'integer'
    AND typeof(q.discount_cents) = 'integer'
    AND typeof(q.total_cents) = 'integer'
    AND q.subtotal_cents > 0
    AND q.subtotal_cents <= 9007199254740991
    AND q.travel_cents >= 0
    AND q.travel_cents <= 9007199254740991
    AND q.addons_cents >= 0
    AND q.addons_cents <= 9007199254740991
    AND q.discount_cents >= 0
    AND q.discount_cents <= 9007199254740991
    AND q.total_cents > 0
    AND q.total_cents <= 9007199254740991
    AND q.total_cents = q.subtotal_cents + q.travel_cents + q.addons_cents - q.discount_cents
)
BEGIN
  SELECT RAISE(ABORT, 'payment quote components are invalid');
END;

CREATE TRIGGER payments_quote_line_guard_insert
BEFORE INSERT ON payments
WHEN EXISTS (
  SELECT 1 FROM quote_line_items li
  WHERE li.quote_id = NEW.quote_id
    AND (
      typeof(li.amount_cents) <> 'integer'
      OR abs(li.amount_cents) > 9007199254740991
      OR (li.kind IN ('base', 'travel', 'addon') AND li.amount_cents <= 0)
      OR (li.kind = 'discount' AND li.amount_cents >= 0)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment quote line items are invalid');
END;

CREATE TRIGGER payments_quote_sum_guard_insert
BEFORE INSERT ON payments
WHEN EXISTS (
  SELECT 1
  FROM quotes q
  WHERE q.id = NEW.quote_id
    AND (
      COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'base'), 0) <> q.subtotal_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'travel'), 0) <> q.travel_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'addon'), 0) <> q.addons_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id AND li.kind = 'discount'), 0) <> -q.discount_cents
      OR COALESCE((SELECT SUM(li.amount_cents) FROM quote_line_items li WHERE li.quote_id = q.id), 0) <> q.total_cents
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment quote line sums are invalid');
END;

CREATE TRIGGER payments_identity_immutable
BEFORE UPDATE OF id, request_id, quote_id, booking_id, amount_cents, currency ON payments
WHEN NEW.id IS NOT OLD.id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.quote_id IS NOT OLD.quote_id
  OR NEW.booking_id IS NOT OLD.booking_id
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.currency IS NOT OLD.currency
BEGIN
  SELECT RAISE(ABORT, 'payment monetary identity is immutable');
END;

CREATE TRIGGER payments_refund_bounds_update
BEFORE UPDATE OF amount_cents, refunded_cents ON payments
WHEN typeof(NEW.refunded_cents) <> 'integer'
  OR NEW.refunded_cents < 0
  OR NEW.refunded_cents > NEW.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'payment refunded amount must be within payment amount');
END;

-- Checkout Session and PaymentIntent ids are populated asynchronously. Each
-- may move from NULL to one exact provider id, then remains immutable. The
-- partial unique indexes above reject cross-payment reuse.
CREATE TRIGGER payments_stripe_identity_guard_update
BEFORE UPDATE OF stripe_session_id, stripe_payment_intent ON payments
WHEN (
    NEW.stripe_session_id IS NOT NULL
    AND (
      length(trim(NEW.stripe_session_id)) = 0
      OR NEW.stripe_session_id <> trim(NEW.stripe_session_id)
    )
  )
  OR (
    NEW.stripe_payment_intent IS NOT NULL
    AND (
      length(trim(NEW.stripe_payment_intent)) = 0
      OR NEW.stripe_payment_intent <> trim(NEW.stripe_payment_intent)
    )
  )
  OR (OLD.stripe_session_id IS NOT NULL AND NEW.stripe_session_id IS NOT OLD.stripe_session_id)
  OR (OLD.stripe_payment_intent IS NOT NULL AND NEW.stripe_payment_intent IS NOT OLD.stripe_payment_intent)
BEGIN
  SELECT RAISE(ABORT, 'Stripe payment identities are non-blank and set once');
END;

-- A terminal attempt cannot be reopened against a booking that has since been
-- rebound to another quote. New attempts must be inserted for that quote.
CREATE TRIGGER payments_open_booking_identity_guard
BEFORE UPDATE OF status ON payments
WHEN NEW.status IN ('created', 'pending')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id = NEW.booking_id
      AND b.request_id = NEW.request_id
      AND b.quote_id = NEW.quote_id
  )
BEGIN
  SELECT RAISE(ABORT, 'open payment must match the booking current quote');
END;

-- Bookings always point at a committed quote for the same request.
CREATE TRIGGER bookings_quote_identity_guard_insert
BEFORE INSERT ON bookings
WHEN NOT EXISTS (
  SELECT 1 FROM quotes q
  WHERE q.id = NEW.quote_id
    AND q.request_id = NEW.request_id
    AND q.status <> 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'booking must match a committed quote for its request');
END;

CREATE TRIGGER bookings_quote_identity_guard_update
BEFORE UPDATE OF request_id, quote_id ON bookings
WHEN NOT EXISTS (
  SELECT 1 FROM quotes q
  WHERE q.id = NEW.quote_id
    AND q.request_id = NEW.request_id
    AND q.status <> 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'booking must match a committed quote for its request');
END;

-- Preserve payment-to-booking evidence. The one-per-request booking can move
-- to a refreshed quote only when every prior attempt that references it is
-- provider-terminal and nonfinancial. Each failed/expired attempt keeps its
-- immutable original quote id and amount. Financial outcomes hard-block rebind.
CREATE TRIGGER bookings_payment_reference_immutable
BEFORE UPDATE OF id, request_id ON bookings
WHEN (NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id)
  AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'historical payment booking reference is immutable');
END;

CREATE TRIGGER bookings_quote_rebind_payment_guard
BEFORE UPDATE OF quote_id ON bookings
WHEN NEW.quote_id IS NOT OLD.quote_id
  AND EXISTS (
    SELECT 1 FROM payments p
    WHERE p.booking_id = OLD.id
      AND p.status NOT IN ('failed', 'expired')
  )
BEGIN
  SELECT RAISE(ABORT, 'booking can change quote only after failed or expired payments');
END;
