-- 0016 — tell real customers apart from test records.
--
-- The dashboard had no way to distinguish a paying customer from a seeded
-- fixture or a smoke test, so two dozen requests read as if they were all
-- business. Two of them are real.
--
-- `record_kind` is the owner-visible truth: 'real' or 'test'. It defaults to
-- 'real' so a genuine intake is never hidden by accident — a record has to be
-- positively identified as a test to leave the business view. The owner can
-- change any record's kind from the dashboard, and that override overwrites
-- this column, so no later backfill can undo their judgement.
--
-- Nothing is deleted. The fixtures and smoke tests stay in the database and
-- stay viewable behind a "show test records" toggle, because they document
-- real refund, dispute and delivery rehearsals.

ALTER TABLE ppi_requests ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'real'
  CHECK (record_kind IN ('real', 'test'));

CREATE INDEX IF NOT EXISTS idx_requests_record_kind
  ON ppi_requests(record_kind, created_at DESC);

-- Backfill by positive identification only. Each marker is something a real
-- buyer's request cannot plausibly carry:
--
--   * reserved reference prefixes used by the seeder and the smoke scripts;
--   * reserved documentation domains (RFC 2606/6761), which can never receive
--     mail — so nobody could ever have been contacted at one;
--   * words written into the name field to say what the record was for.
--
-- Name markers match WHOLE WORDS. "Testa" is a real surname and "Protestina"
-- a real given name; a substring match would hide a paying customer. The
-- normalised name below turns punctuation and underscores into spaces and pads
-- the ends, so "Test Customer (Fixture)" and "INTERNAL_SMOKE_TEST - DELETED"
-- both match while "Marco Testa" does not.
--
-- Anything not matching stays 'real'.
-- Deliberately NOT limited to live rows. A soft-deleted smoke test left at
-- the 'real' default would be a row labelled "real business" that nobody ever
-- looks at until they restore or audit it. Classify every row honestly; the
-- queries that care about deletion filter on deleted_at separately.
UPDATE ppi_requests
SET record_kind = 'test'
WHERE (
    ref LIKE 'PPI-FIXTURE%'
    OR ref LIKE 'PPI-INTERNAL%'
    OR customer_id IN (
      SELECT id FROM (
        SELECT
          id,
          lower(email) AS addr,
          ' ' || upper(
            replace(replace(replace(replace(replace(replace(
              full_name, '_', ' '), '-', ' '), '(', ' '), ')', ' '), '.', ' '), ',', ' ')
          ) || ' ' AS name_words
        FROM customers
      )
      WHERE addr LIKE '%@example.com'
         OR addr LIKE '%@example.invalid'
         OR addr LIKE '%@example.org'
         OR addr LIKE '%@example.net'
         OR addr LIKE '%@test.invalid'
         OR name_words LIKE '% TEST %'
         OR name_words LIKE '% TESTS %'
         OR name_words LIKE '% TESTER %'
         OR name_words LIKE '% TESTING %'
         OR name_words LIKE '% FIXTURE %'
         OR name_words LIKE '% FIXTURES %'
         OR name_words LIKE '% SMOKE %'
         OR name_words LIKE '% SANDBOX %'
         OR name_words LIKE '% VERIFICATION %'
         OR name_words LIKE '% VERIFIER %'
         OR name_words LIKE '% DELETED %'
         OR name_words LIKE '% PLACEHOLDER %'
         OR name_words LIKE '% DUMMY %'
    )
  );
