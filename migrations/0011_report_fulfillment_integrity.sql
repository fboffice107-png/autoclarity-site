-- Additive fulfillment metadata only. No historical lifecycle, customer,
-- payment, report body, or classification is rewritten or inferred.
ALTER TABLE inspection_reports ADD COLUMN inspector_name TEXT;
ALTER TABLE inspection_reports ADD COLUMN reviewed_at TEXT;
ALTER TABLE inspection_reports ADD COLUMN reviewed_by TEXT;
ALTER TABLE inspection_reports ADD COLUMN amendment_reason TEXT;
ALTER TABLE inspection_reports ADD COLUMN write_token TEXT;
ALTER TABLE report_sections ADD COLUMN title TEXT;
ALTER TABLE report_items ADD COLUMN label TEXT;
ALTER TABLE report_photos ADD COLUMN sha256 TEXT;
ALTER TABLE report_versions ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (workflow_revision IN (0,1));
ALTER TABLE report_versions ADD COLUMN created_at TEXT;
ALTER TABLE report_versions ADD COLUMN reviewed_at TEXT;
ALTER TABLE report_versions ADD COLUMN reviewed_by TEXT;
ALTER TABLE report_versions ADD COLUMN previous_version_id TEXT REFERENCES report_versions(id);

CREATE TABLE report_version_photos (
  version_id TEXT NOT NULL REFERENCES report_versions(id),
  photo_id TEXT NOT NULL REFERENCES report_photos(id),
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  PRIMARY KEY (version_id, photo_id)
);
CREATE INDEX idx_version_photos_photo ON report_version_photos(photo_id);
CREATE TABLE report_deliveries (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL UNIQUE REFERENCES report_versions(id),
  report_id TEXT NOT NULL REFERENCES inspection_reports(id),
  request_id TEXT NOT NULL REFERENCES ppi_requests(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel = 'portal'),
  created_at TEXT NOT NULL,
  notification_key TEXT NOT NULL UNIQUE,
  notification_message_id TEXT REFERENCES messages(id)
);
CREATE INDEX idx_report_deliveries_request ON report_deliveries(request_id);

-- Keep the original delivery reference forever. Existing safe email retries
-- create append-only, deduplicated descendants rather than mutating history.
CREATE VIEW report_notification_evidence AS
WITH RECURSIVE chain(delivery_id,request_id,version_id,message_id,depth) AS (
 SELECT d.id,d.request_id,d.version_id,d.notification_message_id,0 FROM report_deliveries d
 WHERE d.notification_message_id IS NOT NULL
 UNION ALL
 SELECT c.delivery_id,c.request_id,c.version_id,m.id,c.depth+1 FROM chain c JOIN messages m
 ON m.dedupe_key IN ('email_link_refresh:'||c.message_id,'email_manual_fresh:'||c.message_id)
 WHERE c.depth<8 AND m.request_id=c.request_id AND m.template='report_ready'
   AND m.direction='outbound' AND m.channel='email'
)
SELECT c.*,m.status,NOT EXISTS(SELECT 1 FROM messages child
  WHERE child.request_id=c.request_id AND child.template='report_ready' AND child.direction='outbound' AND child.channel='email'
    AND child.dedupe_key IN ('email_link_refresh:'||c.message_id,'email_manual_fresh:'||c.message_id)) AS is_current
FROM chain c JOIN messages m ON m.id=c.message_id
WHERE m.request_id=c.request_id AND m.template='report_ready' AND m.direction='outbound' AND m.channel='email';

-- New references must agree with their owning request; old rows remain intact.
CREATE TRIGGER trg_report_identity_insert BEFORE INSERT ON inspection_reports
WHEN NOT EXISTS (SELECT 1 FROM ppi_requests r WHERE r.id = NEW.request_id
  AND r.customer_id = NEW.customer_id AND r.vehicle_id = NEW.vehicle_id)
  OR NEW.published_version_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'report identity or initial pointer invalid'); END;
CREATE TRIGGER trg_report_identity_immutable BEFORE UPDATE OF id,request_id,customer_id,vehicle_id,booking_id,quote_id,started_by,created_at ON inspection_reports
BEGIN SELECT RAISE(ABORT, 'report identity is immutable'); END;
CREATE TRIGGER trg_report_no_delete BEFORE DELETE ON inspection_reports
WHEN EXISTS (SELECT 1 FROM report_versions WHERE report_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'published report cannot be deleted'); END;

CREATE TRIGGER trg_report_version_identity BEFORE INSERT ON report_versions
WHEN NEW.workflow_revision != 1
  OR NOT EXISTS (SELECT 1 FROM inspection_reports ir WHERE ir.id = NEW.report_id AND ir.request_id = NEW.request_id)
  OR (NEW.workflow_revision = 1 AND (
    NEW.created_at IS NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL
    OR length(NEW.payload_sha256) != 64
    OR NOT EXISTS (SELECT 1 FROM inspection_reports ir WHERE ir.id = NEW.report_id
      AND ir.state = 'ready_for_review' AND ir.reviewed_at = NEW.reviewed_at
      AND ir.reviewed_by = NEW.reviewed_by
      AND ir.published_version_id IS NEW.previous_version_id)
    OR NEW.version != COALESCE((SELECT MAX(version) + 1 FROM report_versions WHERE report_id = NEW.report_id), 1)
    OR (NEW.previous_version_id IS NULL AND NEW.kind != 'original')
    OR (NEW.previous_version_id IS NOT NULL AND (NEW.kind != 'amendment' OR length(trim(COALESCE(NEW.amendment_reason,''))) < 5))
  ))
BEGIN SELECT RAISE(ABORT, 'report version identity or review invalid'); END;
CREATE TRIGGER trg_report_version_metadata_immutable BEFORE UPDATE OF id,amendment_reason,pdf_object_key,workflow_revision,created_at,reviewed_at,reviewed_by,previous_version_id ON report_versions
BEGIN SELECT RAISE(ABORT, 'published report metadata is immutable'); END;
CREATE TRIGGER trg_report_version_no_delete BEFORE DELETE ON report_versions
BEGIN SELECT RAISE(ABORT, 'published versions cannot be deleted'); END;
CREATE TRIGGER trg_report_version_supersession BEFORE UPDATE OF status,superseded_at ON report_versions
WHEN NOT (OLD.status = 'published' AND NEW.status = 'superseded' AND NEW.superseded_at IS NOT NULL
 AND EXISTS (SELECT 1 FROM report_versions n WHERE n.previous_version_id = OLD.id
   AND n.report_id = OLD.report_id AND n.request_id = OLD.request_id AND n.version > OLD.version))
BEGIN SELECT RAISE(ABORT, 'invalid report supersession'); END;

CREATE TRIGGER trg_report_pointer_guard BEFORE UPDATE OF published_version_id ON inspection_reports
WHEN NEW.published_version_id IS NOT OLD.published_version_id AND (
 NEW.published_version_id IS NULL OR NOT EXISTS (
   SELECT 1 FROM report_versions rv WHERE rv.id = NEW.published_version_id
     AND rv.report_id = NEW.id AND rv.request_id = NEW.request_id AND rv.status = 'published'
     AND (OLD.published_version_id IS NULL OR (rv.previous_version_id = OLD.published_version_id
       AND rv.version > (SELECT version FROM report_versions WHERE id = OLD.published_version_id)))
     AND (rv.workflow_revision = 0 OR EXISTS (SELECT 1 FROM report_deliveries d WHERE d.version_id = rv.id
       AND d.request_id = NEW.request_id AND d.customer_id = NEW.customer_id))
 ))
BEGIN SELECT RAISE(ABORT, 'invalid published report pointer'); END;

CREATE TRIGGER trg_report_photo_manifest_identity BEFORE INSERT ON report_version_photos
WHEN NOT EXISTS (
 SELECT 1 FROM report_versions rv JOIN report_photos p ON p.id = NEW.photo_id
 WHERE rv.id = NEW.version_id AND rv.report_id = NEW.report_id AND rv.request_id = NEW.request_id
   AND p.report_id = rv.report_id AND p.deleted_at IS NULL AND p.object_key = NEW.object_key
   AND p.sha256 = NEW.sha256 AND p.content_type = NEW.content_type AND p.size_bytes = NEW.size_bytes)
BEGIN SELECT RAISE(ABORT, 'invalid report photo manifest'); END;
CREATE TRIGGER trg_report_photo_manifest_immutable BEFORE UPDATE ON report_version_photos
BEGIN SELECT RAISE(ABORT, 'published photo manifest is immutable'); END;
CREATE TRIGGER trg_report_photo_manifest_no_delete BEFORE DELETE ON report_version_photos
BEGIN SELECT RAISE(ABORT, 'published photo manifest cannot be deleted'); END;
CREATE TRIGGER trg_report_photo_identity_immutable BEFORE UPDATE OF id,report_id,object_key,sha256,content_type,size_bytes ON report_photos
BEGIN SELECT RAISE(ABORT, 'report photo bytes and identity are immutable'); END;
CREATE TRIGGER trg_report_photo_referenced_immutable BEFORE UPDATE ON report_photos
WHEN EXISTS (SELECT 1 FROM report_version_photos WHERE photo_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'published report photo is immutable'); END;
CREATE TRIGGER trg_report_photo_referenced_no_delete BEFORE DELETE ON report_photos
WHEN EXISTS (SELECT 1 FROM report_version_photos WHERE photo_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'published report photo cannot be deleted'); END;

CREATE TRIGGER trg_report_delivery_identity BEFORE INSERT ON report_deliveries
WHEN NOT EXISTS (SELECT 1 FROM report_versions rv JOIN inspection_reports ir ON ir.id = rv.report_id
 WHERE rv.id = NEW.version_id AND rv.report_id = NEW.report_id AND rv.request_id = NEW.request_id
   AND ir.customer_id = NEW.customer_id AND NEW.notification_key = 'report_ready:' || rv.id)
BEGIN SELECT RAISE(ABORT, 'invalid report delivery identity'); END;
CREATE TRIGGER trg_report_delivery_immutable BEFORE UPDATE OF id,version_id,report_id,request_id,customer_id,channel,created_at,notification_key ON report_deliveries
BEGIN SELECT RAISE(ABORT, 'report delivery identity is immutable'); END;
CREATE TRIGGER trg_report_delivery_message_guard BEFORE UPDATE OF notification_message_id ON report_deliveries
WHEN (OLD.notification_message_id IS NOT NULL AND NEW.notification_message_id IS NOT OLD.notification_message_id)
 OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.notification_message_id
   AND m.request_id = NEW.request_id AND m.dedupe_key = NEW.notification_key
   AND m.template = 'report_ready' AND m.direction = 'outbound' AND m.channel = 'email')
BEGIN SELECT RAISE(ABORT, 'invalid report notification reference'); END;
CREATE TRIGGER trg_report_delivery_no_delete BEFORE DELETE ON report_deliveries
BEGIN SELECT RAISE(ABORT, 'report delivery evidence cannot be deleted'); END;
CREATE TRIGGER trg_report_message_reference_immutable BEFORE UPDATE OF id,request_id,dedupe_key,template,direction,channel,to_email,subject,body_text,created_at ON messages
WHEN OLD.template='report_ready' OR EXISTS (SELECT 1 FROM report_deliveries WHERE notification_message_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'report message identity is immutable'); END;
CREATE TRIGGER trg_report_message_no_delete BEFORE DELETE ON messages
WHEN OLD.template='report_ready' OR EXISTS (SELECT 1 FROM report_deliveries WHERE notification_message_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'report message evidence cannot be deleted'); END;
CREATE TRIGGER trg_report_audit_immutable BEFORE UPDATE ON report_audit
BEGIN SELECT RAISE(ABORT, 'report audit is append only'); END;
CREATE TRIGGER trg_report_audit_no_delete BEFORE DELETE ON report_audit
BEGIN SELECT RAISE(ABORT, 'report audit is append only'); END;

-- INSERT OR REPLACE otherwise bypasses UPDATE/DELETE guards with SQLite's
-- default recursive_triggers setting. No immutable identity can be replaced.
CREATE TRIGGER trg_report_replace_guard BEFORE INSERT ON inspection_reports
WHEN EXISTS(SELECT 1 FROM inspection_reports WHERE id=NEW.id OR request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT, 'report identity cannot be replaced'); END;
CREATE TRIGGER trg_report_version_replace_guard BEFORE INSERT ON report_versions
WHEN EXISTS(SELECT 1 FROM report_versions WHERE id=NEW.id OR (report_id=NEW.report_id AND version=NEW.version))
BEGIN SELECT RAISE(ABORT, 'report version cannot be replaced'); END;
CREATE TRIGGER trg_report_photo_replace_guard BEFORE INSERT ON report_photos
WHEN EXISTS(SELECT 1 FROM report_photos WHERE id=NEW.id OR object_key=NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'report photo cannot be replaced'); END;
CREATE TRIGGER trg_report_manifest_replace_guard BEFORE INSERT ON report_version_photos
WHEN EXISTS(SELECT 1 FROM report_version_photos WHERE version_id=NEW.version_id AND photo_id=NEW.photo_id)
BEGIN SELECT RAISE(ABORT, 'photo manifest cannot be replaced'); END;
CREATE TRIGGER trg_report_delivery_replace_guard BEFORE INSERT ON report_deliveries
WHEN EXISTS(SELECT 1 FROM report_deliveries WHERE id=NEW.id OR version_id=NEW.version_id OR notification_key=NEW.notification_key)
BEGIN SELECT RAISE(ABORT, 'report delivery cannot be replaced'); END;
CREATE TRIGGER trg_report_audit_replace_guard BEFORE INSERT ON report_audit
WHEN EXISTS(SELECT 1 FROM report_audit WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'report audit cannot be replaced'); END;
CREATE TRIGGER trg_report_message_replace_guard BEFORE INSERT ON messages
WHEN EXISTS(SELECT 1 FROM messages m WHERE m.template='report_ready'
 AND (m.id=NEW.id OR (m.dedupe_key IS NOT NULL AND m.dedupe_key=NEW.dedupe_key)))
BEGIN SELECT RAISE(ABORT, 'report notification cannot be replaced'); END;

CREATE TRIGGER trg_report_completion_delivery_guard BEFORE UPDATE OF status ON ppi_requests
WHEN NEW.status='completed' AND OLD.status!='completed' AND EXISTS(
 SELECT 1 FROM inspection_reports ir JOIN report_versions rv ON rv.id=ir.published_version_id
 WHERE ir.request_id=NEW.id AND rv.workflow_revision=1)
 AND NOT EXISTS(SELECT 1 FROM inspection_reports ir JOIN report_versions rv ON rv.id=ir.published_version_id
 JOIN report_deliveries d ON d.version_id=rv.id
 WHERE ir.request_id=NEW.id AND ir.state='published' AND rv.status='published'
   AND rv.request_id=NEW.id AND rv.report_id=ir.id AND d.request_id=NEW.id AND d.customer_id=NEW.customer_id
   AND EXISTS(SELECT 1 FROM report_notification_evidence n WHERE n.version_id=rv.id AND n.request_id=NEW.id AND (n.status='sent' OR (n.status='recorded' AND n.is_current=1))))
BEGIN SELECT RAISE(ABORT, 'report delivery required before completion'); END;
