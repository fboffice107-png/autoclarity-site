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
import leadClassificationMigration from '../../migrations/0010_lead_classification.sql?raw';
import { LEAD_CLASSIFICATIONS } from '../../functions/api/admin/lead-review.ts';

const BEFORE_CLASSIFICATION = [
  initialMigration,
  reportsMigration,
  intakeMigration,
  paymentSlotMigration,
  refundLedgerMigration,
  disputeLedgerMigration,
  agreementImmutabilityMigration,
  quotePaymentIntegrityMigration,
  attributionMigration,
];

function applyExistingMigrations(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of BEFORE_CLASSIFICATION) db.exec(migration);
}

function seedFinancialRequest(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES ('cus_lead', 'Migration Customer', 'migration@example.com', '7025550100',
            '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO vehicles (id, year, make, model, created_at, updated_at)
    VALUES ('veh_lead', 2020, 'Test', 'Vehicle',
            '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO ppi_requests
      (id, ref, customer_id, vehicle_id, status, attribution_source, created_at, updated_at)
    VALUES
      ('req_lead', 'PPI-LEAD', 'cus_lead', 'veh_lead', 'completed',
       'ppi_google_business_profile', '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z');
    INSERT INTO status_history
      (id, request_id, from_status, to_status, actor, created_at)
    VALUES ('sh_lead', 'req_lead', 'report_in_progress', 'completed', 'admin:test',
            '2030-01-02T00:00:00.000Z');
    INSERT INTO quotes
      (id, request_id, version, status, tier, currency, subtotal_cents, total_cents,
       expires_at, approved_by, created_at, updated_at)
    VALUES
      ('qot_lead', 'req_lead', 1, 'draft', 'standard', 'usd', 19900, 19900,
       '2030-02-01T00:00:00.000Z', 'admin:test',
       '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
    VALUES ('qli_lead', 'qot_lead', 'base', 'Inspection', 19900, 0);
    UPDATE quotes SET status = 'accepted' WHERE id = 'qot_lead';
    INSERT INTO bookings
      (id, request_id, quote_id, status, confirmed_at, created_at, updated_at)
    VALUES
      ('bkg_lead', 'req_lead', 'qot_lead', 'completed',
       '2030-01-02T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z');
    INSERT INTO payments
      (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent,
       amount_cents, currency, status, refunded_cents, created_at, updated_at)
    VALUES
      ('pay_lead', 'req_lead', 'qot_lead', 'bkg_lead', 'cs_lead', 'pi_lead',
       19900, 'usd', 'succeeded', 0,
       '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z');

    INSERT INTO ppi_requests
      (id, ref, customer_id, vehicle_id, status, attribution_source, created_at, updated_at)
    VALUES
      ('req_legacy_refunded', 'PPI-LEGACY-REFUNDED', 'cus_lead', 'veh_lead', 'refunded',
       'ppi_unknown', '2029-12-01T00:00:00.000Z', '2029-12-03T00:00:00.000Z');
    INSERT INTO status_history
      (id, request_id, from_status, to_status, actor, created_at)
    VALUES
      ('sh_legacy_confirmed', 'req_legacy_refunded', 'awaiting_payment', 'confirmed',
       'system:stripe-webhook', '2029-12-02T00:00:00.000Z'),
      ('sh_legacy_refunded', 'req_legacy_refunded', 'confirmed', 'refunded',
       'system:stripe-webhook', '2029-12-03T00:00:00.000Z');
    INSERT INTO quotes
      (id, request_id, version, status, tier, currency, subtotal_cents, total_cents,
       expires_at, approved_by, created_at, updated_at)
    VALUES
      ('qot_legacy_refunded', 'req_legacy_refunded', 1, 'draft', 'standard', 'usd',
       19900, 19900, '2030-02-01T00:00:00.000Z', 'admin:test',
       '2029-12-01T00:00:00.000Z', '2029-12-01T00:00:00.000Z');
    INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
    VALUES ('qli_legacy_refunded', 'qot_legacy_refunded', 'base', 'Inspection', 19900, 0);
    UPDATE quotes SET status = 'accepted' WHERE id = 'qot_legacy_refunded';
    INSERT INTO bookings
      (id, request_id, quote_id, status, confirmed_at, created_at, updated_at)
    VALUES
      ('bkg_legacy_refunded', 'req_legacy_refunded', 'qot_legacy_refunded', 'refunded',
       '2029-12-02T00:00:00.000Z', '2029-12-01T00:00:00.000Z',
       '2029-12-03T00:00:00.000Z');
    INSERT INTO payments
      (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent,
       amount_cents, currency, status, refunded_cents, created_at, updated_at)
    VALUES
      ('pay_legacy_refunded', 'req_legacy_refunded', 'qot_legacy_refunded',
       'bkg_legacy_refunded', 'cs_legacy_refunded', 'pi_legacy_refunded',
       19900, 'usd', 'refunded', 19900,
       '2029-12-01T00:00:00.000Z', '2029-12-03T00:00:00.000Z');
  `);
}

function invariantSnapshot(db: DatabaseSync): Record<string, unknown> {
  return {
    counts: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM ppi_requests) AS requests,
        (SELECT COUNT(*) FROM status_history) AS history,
        (SELECT COUNT(*) FROM quotes) AS quotes,
        (SELECT COUNT(*) FROM bookings) AS bookings,
        (SELECT COUNT(*) FROM payments) AS payments
    `).get(),
    money: db.prepare('SELECT SUM(amount_cents) AS amount, SUM(refunded_cents) AS refunded FROM payments').get(),
    lifecycle: db.prepare('SELECT status, created_at, updated_at FROM ppi_requests WHERE id = ?').get('req_lead'),
  };
}

describe('lead classification migration', () => {
  it('applies after migrations 0001–0009 without changing lifecycle or money evidence', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyExistingMigrations(db);
      seedFinancialRequest(db);
      const before = invariantSnapshot(db);

      expect(() => db.exec(leadClassificationMigration)).not.toThrow();
      expect(invariantSnapshot(db)).toEqual(before);
      expect(db.prepare(
        'SELECT lead_classification FROM ppi_requests WHERE id = ?',
      ).get('req_lead')).toEqual({ lead_classification: 'needs_owner_review' });
      expect(db.prepare(
        'SELECT lead_classification FROM ppi_requests WHERE id = ?',
      ).get('req_legacy_refunded')).toEqual({ lead_classification: 'needs_owner_review' });
      expect(db.prepare(
        `SELECT amount_cents, refunded_cents, status FROM payments WHERE id = 'pay_legacy_refunded'`,
      ).get()).toEqual({ amount_cents: 19900, refunded_cents: 19900, status: 'refunded' });
      expect(db.prepare(
        `SELECT COUNT(*) AS n FROM status_history
         WHERE request_id = 'req_legacy_refunded' AND to_status = 'completed'`,
      ).get()).toEqual({ n: 0 });

      for (const [index, classification] of LEAD_CLASSIFICATIONS.entries()) {
        expect(() => db.prepare(`
          INSERT INTO ppi_requests
            (id, ref, customer_id, vehicle_id, status, attribution_source,
             lead_classification, created_at, updated_at)
          VALUES (?, ?, 'cus_lead', 'veh_lead', 'submitted', 'ppi_unknown', ?,
                  '2030-01-03T00:00:00.000Z', '2030-01-03T00:00:00.000Z')
        `).run(`req_enum_${index}`, `PPI-ENUM-${index}`, classification)).not.toThrow();
      }

      for (const fabricated of ['Genuine', 'customer', 'qualified', '', 'spam<script>']) {
        expect(() => db.prepare(
          'UPDATE ppi_requests SET lead_classification = ? WHERE id = ?',
        ).run(fabricated, 'req_lead')).toThrow(/CHECK constraint/);
      }
      expect(() => db.prepare(
        'UPDATE ppi_requests SET lead_classification = NULL WHERE id = ?',
      ).run('req_lead')).toThrow(/NOT NULL constraint/);

      expect(db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_requests_lead_review'`,
      ).get()).toEqual({ name: 'idx_requests_lead_review' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
    }
  });
});
