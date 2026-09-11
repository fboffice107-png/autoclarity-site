-- Acceptance records are append-only evidence, including legacy records whose
-- quote identity was never captured. Do not backfill, reinterpret or rewrite
-- any historical acceptance. Future records must bind a same-request committed
-- quote; a new quote/document acceptance is a new row, never an update.

CREATE TRIGGER agreement_acceptances_immutable_update
BEFORE UPDATE ON agreement_acceptances
BEGIN
  SELECT RAISE(ABORT, 'agreement acceptances are immutable');
END;

CREATE TRIGGER agreement_acceptances_immutable_delete
BEFORE DELETE ON agreement_acceptances
BEGIN
  SELECT RAISE(ABORT, 'agreement acceptances are immutable');
END;

CREATE TRIGGER agreement_acceptances_identity_insert
BEFORE INSERT ON agreement_acceptances
BEGIN
  -- SQLite REPLACE can delete a conflict without running DELETE triggers when
  -- recursive_triggers is off. Reject the collision before it reaches REPLACE.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM agreement_acceptances WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'agreement acceptances are immutable') END;
  SELECT CASE WHEN NEW.id IS NULL OR length(trim(NEW.id)) = 0
    THEN RAISE(ABORT, 'agreement acceptance id is required') END;
  SELECT CASE WHEN NEW.quote_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM quotes
    WHERE id = NEW.quote_id AND request_id = NEW.request_id AND status <> 'draft'
  ) THEN RAISE(ABORT, 'agreement acceptance requires a same-request committed quote') END;
END;

-- Close the same REPLACE loophole for documents protected by 0007. An exact
-- source-seeding retry is ignored, retaining the original created_at. A
-- collision by either id or (doc_key, version) with changed content/identity
-- aborts, including when the caller uses INSERT OR IGNORE/REPLACE.
CREATE TRIGGER agreement_versions_identity_insert
BEFORE INSERT ON agreement_versions
WHEN EXISTS (
  SELECT 1 FROM agreement_versions
  WHERE id = NEW.id OR (doc_key = NEW.doc_key AND version = NEW.version)
)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agreement_versions
    WHERE id = NEW.id AND doc_key = NEW.doc_key AND version = NEW.version
      AND title = NEW.title AND body_md = NEW.body_md AND sha256 = NEW.sha256
  ) THEN RAISE(ABORT, 'agreement versions are immutable') END;
  SELECT RAISE(IGNORE);
END;

-- The quote referenced by acceptance is also evidence. Preserve any historical
-- draft-linked evidence without reclassifying it, and prevent REPLACE from
-- bypassing 0008's committed-quote UPDATE guards. Quote lifecycle statuses can
-- still advance normally and fresh quote versions can still be appended.
CREATE TRIGGER accepted_quotes_identity_immutable_update
BEFORE UPDATE OF id, request_id, version, tier, currency, subtotal_cents,
  travel_cents, addons_cents, discount_cents, total_cents ON quotes
WHEN EXISTS (SELECT 1 FROM agreement_acceptances WHERE quote_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'accepted quote identity is immutable');
END;

CREATE TRIGGER accepted_quotes_no_replace
BEFORE INSERT ON quotes
WHEN EXISTS (
  SELECT 1 FROM quotes existing
  JOIN agreement_acceptances acceptance ON acceptance.quote_id = existing.id
  WHERE existing.id = NEW.id
    OR (existing.request_id = NEW.request_id AND existing.version = NEW.version)
)
BEGIN
  SELECT RAISE(ABORT, 'accepted quote identity is immutable');
END;
