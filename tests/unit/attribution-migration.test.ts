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

const migrationsBeforeAttribution = [
  initialMigration,
  reportsMigration,
  intakeMigration,
  paymentSlotMigration,
  refundLedgerMigration,
  disputeLedgerMigration,
  agreementImmutabilityMigration,
  quotePaymentIntegrityMigration,
];

describe('request attribution migration', () => {
  it('applies after the exact production sequence and enforces the same enum as runtime validation', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      for (const migration of [...migrationsBeforeAttribution, attributionMigration]) db.exec(migration);

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

  it('upgrades preexisting requests and payment evidence without changing financial totals', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      for (const migration of migrationsBeforeAttribution) db.exec(migration);
      db.exec(`
        INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
        VALUES ('cus_existing', 'Existing Customer', 'existing@example.com', '7025550100', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO vehicles (id, make, model, created_at, updated_at)
        VALUES ('veh_existing', 'Test', 'Vehicle', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
        VALUES ('req_existing', 'PPI-EXISTING', 'cus_existing', 'veh_existing', 'confirmed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
        VALUES ('qot_existing', 'req_existing', 1, 'draft', 'standard', 'usd', 20000, 20000, '2030-02-01T00:00:00.000Z', 'admin:test', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
        VALUES ('qli_existing', 'qot_existing', 'base', 'Existing PPI', 20000, 0);
        UPDATE quotes SET status = 'accepted' WHERE id = 'qot_existing';
        INSERT INTO bookings (id, request_id, quote_id, status, confirmed_at, created_at, updated_at)
        VALUES ('bkg_existing', 'req_existing', 'qot_existing', 'confirmed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent, amount_cents, currency, status, refunded_cents, created_at, updated_at)
        VALUES ('pay_existing', 'req_existing', 'qot_existing', 'bkg_existing', 'cs_existing', 'pi_existing', 20000, 'usd', 'partially_refunded', 5000, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      `);
      const before = db.prepare(`SELECT
        (SELECT COUNT(*) FROM ppi_requests) AS requests,
        (SELECT COUNT(*) FROM payments) AS payments,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM payments) AS gross_cents,
        (SELECT COALESCE(SUM(refunded_cents), 0) FROM payments) AS refunded_cents`).get();

      db.exec(attributionMigration);

      expect(db.prepare(`SELECT attribution_source FROM ppi_requests WHERE id = 'req_existing'`).get())
        .toEqual({ attribution_source: 'ppi_unknown' });
      expect(db.prepare(`SELECT
        (SELECT COUNT(*) FROM ppi_requests) AS requests,
        (SELECT COUNT(*) FROM payments) AS payments,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM payments) AS gross_cents,
        (SELECT COALESCE(SUM(refunded_cents), 0) FROM payments) AS refunded_cents`).get()).toEqual(before);
      expect(db.prepare(`SELECT dflt_value FROM pragma_table_info('ppi_requests') WHERE name = 'attribution_source'`).get())
        .toEqual({ dflt_value: "'ppi_unknown'" });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM pragma_index_list('ppi_requests') WHERE name = 'idx_requests_attribution_source'`).get())
        .toEqual({ n: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
