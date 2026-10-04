-- Additive delivery ledger. Existing proposals/outbox and customer data are
-- untouched; older proposals are shown without invented delivery history.
CREATE TABLE proposal_deliveries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  proposal_id TEXT NOT NULL REFERENCES booking_proposals(id),
  operation_key TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('initial','retry','resend')),
  state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','complete','interrupted')),
  email_message_id TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending',
  email_reason TEXT,
  email_sent_at TEXT,
  email_attempted INTEGER NOT NULL DEFAULT 0,
  sms_to TEXT,
  sms_body TEXT,
  sms_status TEXT NOT NULL DEFAULT 'pending',
  sms_reason TEXT,
  sms_job_id TEXT,
  sms_attempted INTEGER NOT NULL DEFAULT 0,
  owner_message_id TEXT,
  owner_status TEXT NOT NULL DEFAULT 'pending',
  owner_reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(proposal_id, operation_key),
  UNIQUE(proposal_id, parent_id)
);
CREATE INDEX proposal_deliveries_request ON proposal_deliveries(request_id, proposal_id, created_at);
