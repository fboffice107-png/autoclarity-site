-- Owner-reviewed lead quality is intentionally separate from the service,
-- booking, payment, and customer-contact lifecycle. Existing and future rows
-- stay unresolved until the owner classifies them explicitly.

ALTER TABLE ppi_requests
  ADD COLUMN lead_classification TEXT NOT NULL DEFAULT 'needs_owner_review'
  CHECK (lead_classification IN (
    'genuine',
    'duplicate',
    'spam',
    'test',
    'closed',
    'needs_owner_review'
  ));

CREATE INDEX IF NOT EXISTS idx_requests_lead_review
  ON ppi_requests(lead_classification, status, created_at)
  WHERE deleted_at IS NULL;
