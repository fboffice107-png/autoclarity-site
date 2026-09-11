#!/usr/bin/env python3
"""Offline-only extension rehearsal: exact restored pair, then 0011 and 0012.

This supplements, never substitutes for, the isolated 0009 -> 0010 rehearsal.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3

helpers = runpy.run_path(str(Path(__file__).with_name('rehearse-production-migrations.py')))
snapshot = helpers['snapshot']
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pair-database', required=True, type=Path)
parser.add_argument('--migrations', required=True, type=Path)
parser.add_argument('--output-dir', required=True, type=Path)
args = parser.parse_args()
os.umask(0o077)
args.output_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
source = sqlite3.connect(args.pair_database.resolve().as_uri() + '?mode=ro', uri=True)
db = sqlite3.connect(args.output_dir / 'release.sqlite')
source.backup(db)
source.close()
db.execute('PRAGMA foreign_keys=ON')
before = snapshot(db)
assert len(before['journal']) == 10 and [r[1] for r in before['journal'][-2:]] == ['0009_request_attribution.sql','0010_lead_classification.sql']
columns = {t: v['columns'] for t, v in before['tables'].items()}
migrations = []
for name in ['0011_report_fulfillment_integrity.sql', '0012_agreement_acceptance_integrity.sql']:
    content = (args.migrations / name).read_bytes()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    db.executescript('BEGIN;\n' + content.decode() + '\nINSERT INTO d1_migrations(name,applied_at) VALUES(' + repr(name) + ',' + repr(now) + ');\nCOMMIT;')
    migrations.append({'name': name, 'sha256': hashlib.sha256(content).hexdigest(), 'applied_at_local_only': now})
after = snapshot(db, columns)
for table, evidence in before['tables'].items():
    if table != 'd1_migrations':
        assert after['tables'].get(table) == evidence, 'Historical data drift: ' + table
assert after['commerce'] == before['commerce'], 'Commerce/lifecycle drift'
assert after['journal'][:10] == before['journal'] and len(after['journal']) == 12
assert after['integrity'] == ['ok'] and after['foreign_key_violations'] == 0
for kind in ['indexes', 'triggers', 'views']:
    for name, definition in before[kind].items():
        assert after[kind].get(name) == definition, 'Original schema object changed: ' + name
for table, definitions in before['foreign_keys'].items():
    # SQLite renumbers FK IDs when an ALTER adds a new reference. Compare the
    # actual relationship/action definition without its generated sequence ID.
    old = sorted(tuple(row[1:]) for row in definitions)
    new = sorted(tuple(row[1:]) for row in after['foreign_keys'][table])
    assert all(row in new for row in old), 'Existing FK definition changed: ' + table
new_tables = set(after['tables']) - set(before['tables'])
assert new_tables == {'report_version_photos', 'report_deliveries'}, 'Unexpected new table set'
assert all(after['tables'][table]['count'] == 0 for table in new_tables), 'Unexpected historical backfill'
new_views = set(after['views']) - set(before['views'])
assert new_views == {'report_notification_evidence'}, 'Unexpected view set'
assert db.execute('SELECT COUNT(*) FROM report_versions WHERE workflow_revision != 0').fetchone()[0] == 0, 'Legacy report revision inferred'
report = {'result':'PASS','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'migrations':migrations,'before':before,'after':after,'original_data_tables_unchanged':len(before['tables'])-1,'new_tables':sorted(new_tables),'new_indexes':sorted(set(after['indexes'])-set(before['indexes'])),'new_triggers':sorted(set(after['triggers'])-set(before['triggers'])),'checks':'Every original column/row, counts/soft deletes, commerce/lifecycle, original indexes/triggers/FKs, journal and integrity. Legacy report metadata defaults only; no evidence rewrite.'}
report['new_views'] = sorted(new_views)
(args.output_dir / 'invariants.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['result','timestamp','migrations','original_data_tables_unchanged','new_tables','new_indexes']},indent=2))
db.close()
