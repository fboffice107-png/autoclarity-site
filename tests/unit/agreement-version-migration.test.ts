/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import initialMigration from '../../migrations/0001_init.sql?raw';
import reportsMigration from '../../migrations/0002_inspection_reports.sql?raw';
import intakeMigration from '../../migrations/0003_intake_idempotency.sql?raw';
import paymentSlotMigration from '../../migrations/0004_payment_slot_integrity.sql?raw';
import refundLedgerMigration from '../../migrations/0005_provider_refund_ledger.sql?raw';
import disputeLedgerMigration from '../../migrations/0006_payment_disputes.sql?raw';
import agreementImmutabilityMigration from '../../migrations/0007_agreement_version_immutability.sql?raw';

describe('agreement version immutability migration', () => {
  it('preserves existing versions, blocks update/delete, and permits a new version', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(initialMigration);
      db.exec(reportsMigration);
      db.exec(intakeMigration);
      db.exec(paymentSlotMigration);
      db.exec(refundLedgerMigration);
      db.exec(disputeLedgerMigration);
      db.exec(`
        INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
        VALUES ('ag_test_v1', 'test_terms', 1, 'Test Terms', 'Version one', 'sha-v1', '2030-01-01T00:00:00.000Z');
      `);

      expect(() => db.exec(agreementImmutabilityMigration)).not.toThrow();
      expect(() => db.exec(
        `UPDATE agreement_versions SET body_md = 'Rewritten' WHERE id = 'ag_test_v1'`,
      )).toThrow(/agreement versions are immutable/);
      expect(() => db.exec(
        `DELETE FROM agreement_versions WHERE id = 'ag_test_v1'`,
      )).toThrow(/agreement versions are immutable/);
      expect(() => db.exec(`
        INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
        VALUES ('ag_test_v2', 'test_terms', 2, 'Test Terms', 'Version two', 'sha-v2', '2030-02-01T00:00:00.000Z');
      `)).not.toThrow();

      expect(db.prepare(
        `SELECT id, version, body_md FROM agreement_versions WHERE doc_key = 'test_terms' ORDER BY version`,
      ).all()).toEqual([
        { id: 'ag_test_v1', version: 1, body_md: 'Version one' },
        { id: 'ag_test_v2', version: 2, body_md: 'Version two' },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
