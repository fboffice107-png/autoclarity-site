/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
// The production runtime is D1/SQLite. Node 22's built-in SQLite binding lets
// this regression execute the real migration SQL without a test-only parser.
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import initialMigration from '../../migrations/0001_init.sql?raw';
import reportsMigration from '../../migrations/0002_inspection_reports.sql?raw';
import intakeMigration from '../../migrations/0003_intake_idempotency.sql?raw';
import paymentSlotMigration from '../../migrations/0004_payment_slot_integrity.sql?raw';

describe('payment and appointment migration', () => {
  it('uses default appointment buffers when stored configuration is malformed JSON', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(initialMigration);
      db.exec(reportsMigration);
      db.exec(intakeMigration);
      db.exec(`
        INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
        VALUES ('cus_migration', 'Migration Test', 'migration@example.com', '555-0100', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');

        INSERT INTO vehicles (id, make, model, created_at, updated_at)
        VALUES ('veh_migration', 'Test', 'Vehicle', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');

        INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, created_at, updated_at)
        VALUES ('req_migration', 'PPI-MIGRATION', 'cus_migration', 'veh_migration', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');

        INSERT INTO appointment_slots (id, request_id, starts_at, ends_at, created_at, updated_at)
        VALUES ('slot_migration', 'req_migration', '2030-01-02T10:00:00.000Z', '2030-01-02T11:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');

        INSERT INTO configuration (key, value_json, updated_at, updated_by)
        VALUES ('ppi', '{ definitely-not-json', '2030-01-01T00:00:00.000Z', 'migration-test');
      `);

      expect(() => db.exec(paymentSlotMigration)).not.toThrow();
      expect(db.prepare(`
        SELECT blocked_starts_at, blocked_ends_at
        FROM appointment_slots
        WHERE id = 'slot_migration'
      `).get()).toEqual({
        blocked_starts_at: '2030-01-02T09:15:00.000Z',
        blocked_ends_at: '2030-01-02T12:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });
});
