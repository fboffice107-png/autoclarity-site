-- Accepted legal documents are append-only evidence. Publishing changed terms
-- requires a new (doc_key, version) row; existing versions may never be edited
-- or deleted after a customer could have accepted them.

CREATE TRIGGER agreement_versions_immutable_update
BEFORE UPDATE ON agreement_versions
BEGIN
  SELECT RAISE(ABORT, 'agreement versions are immutable');
END;

CREATE TRIGGER agreement_versions_immutable_delete
BEFORE DELETE ON agreement_versions
BEGIN
  SELECT RAISE(ABORT, 'agreement versions are immutable');
END;
