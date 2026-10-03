/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
// @ts-expect-error Node SQLite is supplied by the test runtime, outside Worker app types.
import { DatabaseSync } from 'node:sqlite';
import migration from '../../migrations/0018_private_sunday_discovery.sql?raw';

describe('optional private-Sunday/discovery migration', () => {
  it('retains existing data and adds nullable fields without backfilling or rewriting a request', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE ppi_requests (id TEXT PRIMARY KEY, seller_type TEXT, perm_inspection INTEGER, status TEXT);
      INSERT INTO ppi_requests VALUES ('legacy-private', 'private', 1, 'submitted'), ('paid-dealer', 'dealership', 1, 'confirmed');`);
    db.exec(migration);
    const rows = db.prepare('SELECT * FROM ppi_requests ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'legacy-private', seller_type: 'private', perm_inspection: 1, status: 'submitted', inspection_location_type: null, dealership_name: null, discovery_source: null, discovery_detail: null },
      { id: 'paid-dealer', seller_type: 'dealership', perm_inspection: 1, status: 'confirmed', inspection_location_type: null, dealership_name: null, discovery_source: null, discovery_detail: null },
    ]);
    expect(() => db.exec("UPDATE ppi_requests SET discovery_source='invented' WHERE id='legacy-private'")).toThrow();
    db.close();
  });
});
