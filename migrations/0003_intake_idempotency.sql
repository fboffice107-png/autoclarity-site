-- Durable intake idempotency. A supplied browser submission key is retained on
-- the request for exact retries; the short-lived fingerprint claim closes the
-- simultaneous-tab race even when two tabs have different client keys.

ALTER TABLE ppi_requests ADD COLUMN submission_key TEXT;

CREATE UNIQUE INDEX idx_requests_submission_key
  ON ppi_requests(submission_key) WHERE submission_key IS NOT NULL;

CREATE TABLE intake_submission_claims (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES ppi_requests(id),
  fingerprint TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_intake_claims_expiry ON intake_submission_claims(expires_at);
