-- Persist one privacy-minimized, allowlisted acquisition category on each
-- request so server-authoritative payments and completions can be attributed.
-- Existing requests and submissions without a trustworthy category stay
-- explicitly unknown. Raw URLs, UTM values, campaigns, search terms, and
-- referrer paths are never stored here.

ALTER TABLE ppi_requests ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'ppi_unknown'
  CHECK (
    attribution_source = 'ppi_unknown'
    OR attribution_source GLOB 'ppi_*'
  );

CREATE INDEX IF NOT EXISTS idx_requests_attribution_source
  ON ppi_requests(attribution_source);
