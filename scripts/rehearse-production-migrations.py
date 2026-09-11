#!/usr/bin/env python3
"""Offline-only D1 export rehearsal. Never connects to a service or prints rows.

Creates a new owner-only output directory. The restored database contains PII;
keep it private, outside the repository, and never serve it with Pages dev.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def snapshot(db, columns=None):
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    result = {"tables": {}, "indexes": {}, "triggers": {}, "views": {}, "schemas": {}, "foreign_keys": {}}
    for table in tables:
        cols = columns[table] if columns and table in columns else [r[1] for r in db.execute('PRAGMA table_info(' + ident(table) + ')')]
        rows = list(db.execute('SELECT ' + ','.join(map(ident, cols)) + ' FROM ' + ident(table)))
        # BLOBs retain their exact bytes and type, without exposing any row data.
        encoded = sorted(canonical([[type(v).__name__, v.hex() if isinstance(v, bytes) else v] for v in row]) for row in rows)
        result['tables'][table] = {"count": len(rows), "columns": cols, "rows_sha256": digest(b'\n'.join(encoded))}
        result['foreign_keys'][table] = list(db.execute('PRAGMA foreign_key_list(' + ident(table) + ')'))
        if 'deleted_at' in cols:
            result['tables'][table]['soft_deleted'] = db.execute('SELECT COUNT(*) FROM ' + ident(table) + ' WHERE deleted_at IS NOT NULL').fetchone()[0]
    for kind, key in [('index', 'indexes'), ('trigger', 'triggers'), ('view', 'views'), ('table', 'schemas')]:
        result[key] = dict(db.execute('SELECT name, sql FROM sqlite_master WHERE type=? ORDER BY name', (kind,)))
    result['integrity'] = [r[0] for r in db.execute('PRAGMA integrity_check')]
    result['foreign_key_violations'] = len(list(db.execute('PRAGMA foreign_key_check')))
    result['journal'] = list(db.execute('SELECT id,name,applied_at FROM d1_migrations ORDER BY id'))
    result['commerce'] = {
        'gross_captured_cents': db.execute("SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE status IN ('succeeded','partially_refunded','refunded','disputed')").fetchone()[0],
        'refunded_cents': db.execute('SELECT COALESCE(SUM(refunded_cents),0) FROM payments').fetchone()[0],
        'payments_by_status': list(db.execute('SELECT status,COUNT(*),SUM(amount_cents),SUM(refunded_cents) FROM payments GROUP BY status ORDER BY status')),
        'requests_by_status': list(db.execute('SELECT status,COUNT(*) FROM ppi_requests GROUP BY status ORDER BY status')),
        'bookings_by_status': list(db.execute('SELECT status,COUNT(*) FROM bookings GROUP BY status ORDER BY status')),
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', required=True, type=Path)
    parser.add_argument('--migrations', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    args.output_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
    db = sqlite3.connect(args.output_dir / 'rehearsal.sqlite')
    source = args.export.read_bytes()
    db.executescript(source.decode('utf-8'))
    db.execute('PRAGMA foreign_keys=ON')
    before = snapshot(db)
    assert before['integrity'] == ['ok'], 'Source integrity check failed'
    assert before['foreign_key_violations'] == 0, 'Source foreign key violations'
    assert [r[1] for r in before['journal']] == [p.name for p in sorted(args.migrations.glob('000[1-8]_*.sql'))], 'Unexpected production journal; owner review required'
    columns = {t: v['columns'] for t, v in before['tables'].items()}
    migrations = []
    for filename in ['0009_request_attribution.sql', '0010_lead_classification.sql']:
        content = (args.migrations / filename).read_bytes()
        # Exactly these two source files, each atomically with its local journal entry.
        applied_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        db.executescript('BEGIN;\n' + content.decode('utf-8') + '\nINSERT INTO d1_migrations(name,applied_at) VALUES(' + repr(filename) + ',' + repr(applied_at) + ');\nCOMMIT;')
        migrations.append({'name': filename, 'sha256': digest(content), 'applied_at_local_only': applied_at})
    after = snapshot(db, columns)
    assert before['tables'].keys() == after['tables'].keys(), 'Unexpected table set drift'
    for table in before['tables']:
        if table != 'd1_migrations':
            assert before['tables'][table] == after['tables'][table], 'Historical row drift in ' + table
    assert after['journal'][:len(before['journal'])] == before['journal'], 'Existing journal rewritten'
    assert len(after['journal']) == len(before['journal']) + 2, 'Unexpected journal additions'
    assert before['commerce'] == after['commerce'], 'Commerce/lifecycle drift'
    assert before['foreign_keys'] == after['foreign_keys'], 'Foreign key definition drift'
    assert before['triggers'] == after['triggers'], 'Trigger drift'
    assert before['views'] == after['views'], 'View drift'
    assert after['integrity'] == ['ok'] and after['foreign_key_violations'] == 0
    for name, definition in before['indexes'].items():
        assert after['indexes'].get(name) == definition, 'Index removed or changed: ' + name
    assert set(after['indexes']) - set(before['indexes']) == {'idx_requests_attribution_source', 'idx_requests_lead_review'}, 'Unexpected indexes'
    for name, definition in before['schemas'].items():
        if name != 'ppi_requests':
            assert after['schemas'][name] == definition, 'Unexpected schema drift: ' + name
    info = list(db.execute('PRAGMA table_info(ppi_requests)'))
    assert [r[1] for r in info] == columns['ppi_requests'] + ['attribution_source', 'lead_classification'], 'Unexpected request columns'
    assert all(r[3] == 1 for r in info[-2:]), 'New columns must be NOT NULL'
    defaults = list(db.execute('SELECT attribution_source,lead_classification,COUNT(*) FROM ppi_requests GROUP BY attribution_source,lead_classification'))
    assert defaults == [('ppi_unknown','needs_owner_review', before['tables']['ppi_requests']['count'])] or before['tables']['ppi_requests']['count'] == 0, 'Historical classification inferred'
    # Constraints are actually exercised; the savepoint guarantees no retained mutation.
    for column in ['attribution_source', 'lead_classification']:
        db.execute('SAVEPOINT constraint_probe')
        try:
            db.execute('UPDATE ppi_requests SET ' + ident(column) + "='invalid_preflight_value'")
        except sqlite3.IntegrityError:
            pass
        else:
            if before['tables']['ppi_requests']['count']:
                raise AssertionError('Missing CHECK constraint: ' + column)
        finally:
            db.execute('ROLLBACK TO constraint_probe')
            db.execute('RELEASE constraint_probe')
    evidence = {'result': 'PASS', 'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'export_sha256': digest(source), 'migrations': migrations, 'before': before, 'after': after, 'new_columns': [list(r) for r in info[-2:]], 'historical_defaults': defaults, 'checks': 'Exact original-column row multiset hashes, counts, soft deletes, commerce/status aggregates, schemas, FKs, indexes, triggers, journal, integrity and negative CHECK probes. No heuristic classification.'}
    (args.output_dir / 'invariants.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'result': 'PASS', 'export_sha256': digest(source), 'tables_compared': len(before['tables']) - 1, 'counts': {t: v['count'] for t, v in before['tables'].items()}, 'commerce': before['commerce'], 'indexes_before_after': [len(before['indexes']), len(after['indexes'])], 'journal_before_after': [len(before['journal']),len(after['journal'])], 'evidence': str(args.output_dir / 'invariants.json')}, indent=2))
    db.close()


if __name__ == '__main__':
    main()
