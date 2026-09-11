#!/usr/bin/env python3
"""Export exact current agreement bodies and PII-free acceptance counts offline."""
import argparse
import datetime
import hashlib
import json
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--database', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--candidate-source-json', type=Path)
args = parser.parse_args()
db = sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
documents = [dict(r) for r in db.execute('''SELECT av.*, (SELECT COUNT(*) FROM agreement_acceptances aa WHERE aa.agreement_version_id=av.id) acceptance_count FROM agreement_versions av JOIN (SELECT doc_key,MAX(version) version FROM agreement_versions GROUP BY doc_key) latest ON av.doc_key=latest.doc_key AND av.version=latest.version ORDER BY av.doc_key''')]
for doc in documents:
    assert hashlib.sha256(doc['body_md'].encode()).hexdigest() == doc['sha256'], 'Agreement checksum mismatch: ' + doc['id']
history = [dict(r) for r in db.execute('''SELECT av.id,av.doc_key,av.version,av.title,av.sha256,av.created_at,COUNT(aa.id) acceptance_count FROM agreement_versions av LEFT JOIN agreement_acceptances aa ON aa.agreement_version_id=av.id GROUP BY av.id ORDER BY av.doc_key,av.version''')]
audit = dict(db.execute('''SELECT COUNT(*) total, SUM(quote_id IS NULL) unbound_legacy, SUM(NOT EXISTS(SELECT 1 FROM quotes q WHERE q.id=aa.quote_id AND q.request_id=aa.request_id)) missing_or_mismatched_quote FROM agreement_acceptances aa''').fetchone())
lines = ['# Exact production agreement counsel-review packet', '', 'Captured from the fresh production export at 2026-09-11T17:48:05Z; generated offline at ' + datetime.datetime.now(datetime.timezone.utc).isoformat() + '.', '', 'These are existing production terms, not legal approval or proposed replacement wording. The current server requires **all nine documents** below for the current exact quote. `created_at` is the available database timestamp; there is no separate published timestamp or required boolean. Current status is derived from the maximum version per document key and the exact source agreement set. Customer acceptance rows retain request, quote, document version, typed name, acceptance state, timestamp, IP and user agent. No customer identity or acceptance body is reproduced here.', '', 'Counsel decisions: confirm service scope and diagnostic/road-test/seller authorization; cancellation, vehicle transfer and refund promises against actual operating procedures; limitations and buyer reliance; photo/data retention and privacy disclosure; electronic consent; required Nevada/local disclosures based on DMV classification. Insurance must cover the actual work and custody/road-test model. Changed legal text must be a **new version**, never an edit of accepted evidence.', '', '## Acceptance evidence (aggregate only)', '', '```json', json.dumps(audit, indent=2), '```', '', '## Historical version inventory', '', '| ID | Version | Created | Acceptances | SHA-256 |', '|---|---:|---|---:|---|']
for doc in history:
    lines.append('| ' + doc['id'] + ' | ' + str(doc['version']) + ' | ' + doc['created_at'] + ' | ' + str(doc['acceptance_count']) + ' | ' + doc['sha256'] + ' |')
for doc in documents:
    lines.extend(['', '## ' + doc['title'], '', '- ID: `' + doc['id'] + '`', '- Document key: `' + doc['doc_key'] + '`; version: ' + str(doc['version']), '- Created: ' + doc['created_at'], '- Required at Checkout: yes; acceptances referencing this exact version: ' + str(doc['acceptance_count']), '- SHA-256 (exact UTF-8 body): `' + doc['sha256'] + '`', '', 'Exact body follows:', '', '```markdown', doc['body_md'], '```'])
if args.candidate_source_json:
    candidates = json.loads(args.candidate_source_json.read_text())
    current = {d['doc_key']: d for d in documents}
    pending = []
    for doc in candidates:
        stored = current[doc['docKey']]
        if doc['version'] == stored['version']:
            assert (doc['title'], doc['bodyMd']) == (stored['title'], stored['body_md']), 'Same-version source mutation'
        else:
            assert doc['version'] > stored['version'], 'Source version downgrade'
            pending.append(doc)
    lines.extend(['', '## Candidate-only versions requiring legal approval', '', str(len(candidates) - len(pending)) + ' current documents match the candidate byte-for-byte. The frozen reconciled candidate already proposes the following ' + str(len(pending)) + ' **new** versions; these are not yet production terms. On the first candidate agreement load, existing seeding logic appends them and requires their acceptance for Checkout. Historical bodies and quote-bound acceptances stay unchanged. No new legal wording was authored in this remediation pass. Counsel/owner must approve these exact new bodies before release. Their creation/publication timestamps do not yet exist in production.'])
    for doc in pending:
        lines.extend(['', '### Proposed ' + doc['title'] + ' v' + str(doc['version']), '', '- ID: `ag_' + doc['docKey'] + '_v' + str(doc['version']) + '`', '- Proposed SHA-256: `' + hashlib.sha256(doc['bodyMd'].encode()).hexdigest() + '`', '- Required after candidate seeding: yes. Existing historical acceptance does not silently count as acceptance of this new version.', '', '```markdown', doc['bodyMd'], '```'])
args.output.write_text('\n'.join(lines) + '\n')
print(json.dumps({'current_documents': len(documents), 'all_versions': len(history), 'checksums': 'PASS', 'acceptance_audit': audit, 'output': str(args.output)}, indent=2))
