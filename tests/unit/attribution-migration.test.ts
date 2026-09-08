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
import quotePaymentIntegrityMigration from '../../migrations/0008_quote_payment_integrity.sql?raw';
import attributionMigration from '../../migrations/0009_request_attribution.sql?raw';
import { ATTRIBUTION_SOURCES } from '../../functions/lib/validate.ts';

describe('request attribution migration', () => {
  it('applies after the exact production sequence and enforces the same enum as runtime validation', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      for (const migration of [
        initialMigration,
        reportsMigration,
        intakeMigration,
        paymentSlotMigration,
        refundLedgerMigration,
        disputeLedgerMigration,
        agreementImmutabilityMigration,
        quotePaymentIntegrityMigration,
        attributionMigration,
      ]) db.exec(migration);

      db.exec(`
        INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
        VALUES ('cus_attr', 'Attribution Test', 'attr@example.com', '7025550100', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO vehicles (id, make, model, created_at, updated_at)
        VALUES ('veh_attr', 'Test', 'Vehicle', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      `);

      ATTRIBUTION_SOURCES.forEach((source, index) => {
        expect(() => db.prepare(`
          INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, attribution_source, created_at, updated_at)
          VALUES (?, ?, 'cus_attr', 'veh_attr', 'submitted', ?, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')
        `).run(`req_attr_${index}`, `PPI-ATTR-${index}`, source)).not.toThrow();
      });

      for (const fabricated of ['ppi_fabricated_agent_paid<script>', 'ppi_google_social', 'ppi_chatgpt']) {
        expect(() => db.prepare(`
          INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, attribution_source, created_at, updated_at)
          VALUES (?, ?, 'cus_attr', 'veh_attr', 'submitted', ?, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')
        `).run(`req_bad_${fabricated.length}`, `PPI-BAD-${fabricated.length}`, fabricated)).toThrow(/CHECK constraint/);
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
