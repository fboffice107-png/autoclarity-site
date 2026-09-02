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

describe('payment dispute ledger migration', () => {
  it('preserves payment state and enforces immutable, payment-bound dispute identity', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(initialMigration);
      db.exec(reportsMigration);
      db.exec(intakeMigration);
      db.exec(paymentSlotMigration);
      db.exec(`
        INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
        VALUES ('cus_dispute_migration', 'Dispute Migration', 'dispute@example.com', '555-0100', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO vehicles (id, make, model, created_at, updated_at)
        VALUES ('veh_dispute_migration', 'Test', 'Vehicle', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
        VALUES ('req_dispute_migration', 'PPI-DISPUTE-MIGRATION', 'cus_dispute_migration', 'veh_dispute_migration', 'disputed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
        VALUES ('quo_dispute_migration', 'req_dispute_migration', 1, 'accepted', 'standard', 'usd', 19900, 19900, '2031-01-01T00:00:00.000Z', 'test', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO payments
          (id, request_id, quote_id, stripe_payment_intent, amount_cents, currency, status, refunded_cents, created_at, updated_at)
        VALUES
          ('pay_dispute_migration', 'req_dispute_migration', 'quo_dispute_migration', 'pi_dispute_migration', 19900, 'usd', 'disputed', 5000, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      `);
      db.exec(refundLedgerMigration);
      const before = db.prepare(`SELECT status, refunded_cents FROM payments WHERE id = 'pay_dispute_migration'`).get();

      expect(() => db.exec(disputeLedgerMigration)).not.toThrow();
      expect(db.prepare(`SELECT status, refunded_cents FROM payments WHERE id = 'pay_dispute_migration'`).get()).toEqual(before);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM payment_disputes`).get()).toEqual({ n: 0 });

      db.exec(`
        INSERT INTO payment_disputes
          (provider_dispute_id, payment_id, payment_intent, provider_charge_id,
           amount_cents, currency, provider_created, provider_status,
           status_event_created, status_event_id, created_at, updated_at)
        VALUES
          ('du_valid_migration', 'pay_dispute_migration', 'pi_dispute_migration', 'ch_dispute_migration',
           5000, 'usd', 100, 'needs_response', 101, 'evt_dispute_created',
           '2030-01-01T00:00:01.000Z', '2030-01-01T00:00:01.000Z');
      `);
      expect(db.prepare(`
        SELECT provider_status, funds_state, status_event_created, funds_event_created
        FROM payment_disputes WHERE provider_dispute_id = 'du_valid_migration'
      `).get()).toEqual({
        provider_status: 'needs_response',
        funds_state: 'unknown',
        status_event_created: 101,
        funds_event_created: null,
      });

      expect(() => db.exec(`
        INSERT INTO payment_disputes
          (provider_dispute_id, payment_id, payment_intent, provider_charge_id,
           amount_cents, currency, provider_created, created_at, updated_at)
        VALUES ('du_over_amount', 'pay_dispute_migration', 'pi_dispute_migration', 'ch_over_amount',
                19901, 'usd', 100, '2030-01-01T00:00:02.000Z', '2030-01-01T00:00:02.000Z');
      `)).toThrow(/payment dispute amount exceeds payment amount/);
      expect(() => db.exec(`
        INSERT INTO payment_disputes
          (provider_dispute_id, payment_id, payment_intent, provider_charge_id,
           amount_cents, currency, provider_created, created_at, updated_at)
        VALUES ('du_wrong_currency', 'pay_dispute_migration', 'pi_dispute_migration', 'ch_wrong_currency',
                5000, 'eur', 100, '2030-01-01T00:00:02.000Z', '2030-01-01T00:00:02.000Z');
      `)).toThrow(/payment dispute currency mismatch/);
      expect(() => db.exec(`
        INSERT INTO payment_disputes
          (provider_dispute_id, payment_id, payment_intent, provider_charge_id,
           amount_cents, currency, provider_created, created_at, updated_at)
        VALUES ('du_wrong_intent', 'pay_dispute_migration', 'pi_wrong_intent', 'ch_wrong_intent',
                5000, 'usd', 100, '2030-01-01T00:00:02.000Z', '2030-01-01T00:00:02.000Z');
      `)).toThrow(/payment dispute PaymentIntent mismatch/);

      expect(() => db.exec(`
        UPDATE payment_disputes SET amount_cents = 4000
        WHERE provider_dispute_id = 'du_valid_migration';
      `)).toThrow(/payment dispute identity is immutable/);
      expect(() => db.exec(`
        UPDATE payment_disputes
        SET provider_status = 'won', status_event_created = 200, status_event_id = 'evt_dispute_won',
            funds_state = 'reinstated', funds_event_created = 190, funds_event_id = 'evt_dispute_funds',
            updated_at = '2030-01-01T00:00:03.000Z'
        WHERE provider_dispute_id = 'du_valid_migration';
      `)).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
