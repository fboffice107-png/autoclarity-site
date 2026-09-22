-- 0017 — money collected outside Stripe.
--
-- Real jobs get paid in ways Checkout never sees: cash at the car, Zelle, a
-- transfer arranged over text. Before this, such a job could not be recorded at
-- all, so the dashboard showed a real customer sitting at "submitted" forever
-- and the revenue figures were missing money that was genuinely collected.
--
-- `method` says how the money actually arrived. It defaults to 'stripe'
-- because every payment that exists today came through Checkout, and it is
-- immutable once written: a Stripe charge can never be relabelled as cash to
-- dodge reconciliation, and a cash record can never claim to be a Stripe
-- charge that support could look up and fail to find.
--
-- An offline payment carries NO Stripe identities. That is enforced rather
-- than assumed, because a fabricated session or intent id would be a lie that
-- the refund and dispute paths would later act on.

ALTER TABLE payments ADD COLUMN method TEXT NOT NULL DEFAULT 'stripe'
  CHECK (method IN ('stripe', 'offline'));

-- How the money arrived, in the owner's own words ("Zelle", "cash at the
-- vehicle"). Shown beside the amount so a recorded payment is never mistaken
-- for one the processor can confirm.
ALTER TABLE payments ADD COLUMN offline_note TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method, created_at DESC);

-- An offline payment must never carry a provider identity.
CREATE TRIGGER payments_offline_has_no_provider_identity_insert
BEFORE INSERT ON payments
WHEN NEW.method = 'offline'
  AND (NEW.stripe_session_id IS NOT NULL OR NEW.stripe_payment_intent IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a payment collected outside Stripe cannot carry Stripe identities');
END;

CREATE TRIGGER payments_offline_has_no_provider_identity_update
BEFORE UPDATE OF stripe_session_id, stripe_payment_intent ON payments
WHEN NEW.method = 'offline'
  AND (NEW.stripe_session_id IS NOT NULL OR NEW.stripe_payment_intent IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a payment collected outside Stripe cannot carry Stripe identities');
END;

-- How the money arrived is a fact about the past, so it is set once.
CREATE TRIGGER payments_method_immutable
BEFORE UPDATE OF method ON payments
WHEN NEW.method IS NOT OLD.method
BEGIN
  SELECT RAISE(ABORT, 'payment method is immutable');
END;
