/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import initialMigration from '../../migrations/0001_init.sql?raw';
import reportsMigration from '../../migrations/0002_inspection_reports.sql?raw';
import intakeMigration from '../../migrations/0003_intake_idempotency.sql?raw';
import paymentSlotMigration from '../../migrations/0004_payment_slot_integrity.sql?raw';
import refundLedgerMigration from '../../migrations/0005_provider_refund_ledger.sql?raw';

describe('provider refund ledger migration', () => {
  it('backfills known Refund ids and preserves unknown historical balances', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(initialMigration);
      db.exec(reportsMigration);
      db.exec(intakeMigration);
      db.exec(paymentSlotMigration);
      db.exec(`
        INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
        VALUES ('cus_refund_migration', 'Refund Migration', 'refund@example.com', '555-0100', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO vehicles (id, make, model, created_at, updated_at)
        VALUES ('veh_refund_migration', 'Test', 'Vehicle', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
        VALUES ('req_refund_migration', 'PPI-REFUND-MIGRATION', 'cus_refund_migration', 'veh_refund_migration', 'refunded', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO quotes (id, request_id, version, status, tier, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
        VALUES ('quo_refund_migration', 'req_refund_migration', 1, 'accepted', 'standard', 19900, 19900, '2031-01-01T00:00:00.000Z', 'test', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO payments (id, request_id, quote_id, amount_cents, status, refunded_cents, created_at, updated_at)
        VALUES
          ('pay_legacy_refund', 'req_refund_migration', 'quo_refund_migration', 19900, 'refunded', 19900, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
          ('pay_known_refund', 'req_refund_migration', 'quo_refund_migration', 19900, 'partially_refunded', 5000, '2030-01-01T00:00:01.000Z', '2030-01-01T00:00:01.000Z');
        INSERT INTO refund_operations
          (id, payment_id, request_id, starting_refunded_cents, requested_amount_cents, idempotency_key, status, attempt_count, provider_refund_id, created_at, updated_at)
        VALUES ('rfo_known', 'pay_known_refund', 'req_refund_migration', 0, 5000, 'refund/rfo_known/1', 'confirmed', 1, 're_known_migration', '2030-01-01T00:00:02.000Z', '2030-01-01T00:00:02.000Z');
        INSERT INTO refund_operation_attempts
          (id, operation_id, attempt_no, idempotency_key, provider_refund_id, provider_status, outcome_status, created_at, updated_at)
        VALUES ('rfa_known', 'rfo_known', 1, 'refund/rfo_known/1', 're_known_migration', 'succeeded', 'confirmed', '2030-01-01T00:00:02.000Z', '2030-01-01T00:00:02.000Z');
      `);

      expect(() => db.exec(refundLedgerMigration)).not.toThrow();
      expect(db.prepare(`SELECT status, amount_cents, last_event_created FROM provider_refunds WHERE provider_refund_id = 're_known_migration'`).get()).toEqual({
        status: 'succeeded',
        amount_cents: 5000,
        last_event_created: 0,
      });
      expect(db.prepare(`SELECT legacy_refunded_cents FROM payment_refund_ledger_state WHERE payment_id = 'pay_known_refund'`).get()).toEqual({ legacy_refunded_cents: 0 });
      expect(db.prepare(`SELECT legacy_refunded_cents FROM payment_refund_ledger_state WHERE payment_id = 'pay_legacy_refund'`).get()).toEqual({ legacy_refunded_cents: 19900 });

      db.exec(`
        INSERT INTO provider_refunds
          (provider_refund_id, payment_id, amount_cents, currency, provider_created,
           legacy_claim_cents, status, last_event_created, last_event_id, created_at, updated_at)
        VALUES
          ('re_legacy_materialized', 'pay_legacy_refund', 19900, 'usd', 0,
           19900, 'failed', 100, 'evt_legacy_failed', '2030-01-01T00:00:03.000Z', '2030-01-01T00:00:03.000Z');
      `);
      expect(db.prepare(`
        SELECT s.legacy_refunded_cents - SUM(pr.legacy_claim_cents)
          + SUM(CASE WHEN pr.status = 'succeeded' THEN pr.amount_cents ELSE 0 END) AS effective_cents
        FROM payment_refund_ledger_state s
        JOIN provider_refunds pr ON pr.payment_id = s.payment_id
        WHERE s.payment_id = 'pay_legacy_refund'
      `).get()).toEqual({ effective_cents: 0 });

      db.exec(`UPDATE provider_refunds SET status = 'succeeded' WHERE provider_refund_id = 're_legacy_materialized'`);
      expect(() => db.exec(`
        INSERT INTO provider_refunds
          (provider_refund_id, payment_id, amount_cents, currency, provider_created,
           legacy_claim_cents, status, last_event_created, last_event_id, created_at, updated_at)
        VALUES
          ('re_legacy_materialized', 'pay_legacy_refund', 19900, 'usd', 0,
           19900, 'succeeded', 100, 'evt_legacy_failed', '2030-01-01T00:00:03.000Z', '2030-01-01T00:00:03.000Z')
        ON CONFLICT(provider_refund_id) DO UPDATE SET status = excluded.status
      `)).not.toThrow();
      expect(() => db.exec(`
        INSERT INTO provider_refunds
          (provider_refund_id, payment_id, amount_cents, currency, legacy_claim_cents,
           status, last_event_created, last_event_id, created_at, updated_at)
        VALUES
          ('re_over_refund', 'pay_legacy_refund', 1, 'usd', 0,
           'succeeded', 101, 'evt_over_refund', '2030-01-01T00:00:04.000Z', '2030-01-01T00:00:04.000Z')
      `)).toThrow(/provider refund total exceeds payment amount/);
    } finally {
      db.close();
    }
  });
});
