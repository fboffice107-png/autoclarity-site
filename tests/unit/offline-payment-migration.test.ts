/// <reference types="vite/client" />

// 0017 — recording money that arrived outside Stripe.
//
// A real customer paid $325 in cash for an inspection. The system had nowhere
// to put that: the request stayed at "submitted" and the money was missing
// from every figure the owner reads. These tests run the exact write sequence
// the admin action performs against the real schema, so the 0008 payment
// identity triggers — which are strict, and rightly so — are proven to accept
// an honest offline record and reject a dishonest one.

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
import reportFulfillmentMigration from '../../migrations/0011_report_fulfillment_integrity.sql?raw';
import agreementAcceptanceMigration from '../../migrations/0012_agreement_acceptance_integrity.sql?raw';
import bookingProposalMigration from '../../migrations/0014_booking_proposal_flow.sql?raw';
import openAvailabilityMigration from '../../migrations/0015_open_availability.sql?raw';
import recordKindMigration from '../../migrations/0016_record_kind.sql?raw';
import offlinePaymentMigration from '../../migrations/0017_offline_payments.sql?raw';

const T0 = '2026-08-27T17:51:51.613Z';
const PAID = 32500;

function migrated(applyOffline = true): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of [
    initialMigration, reportsMigration, intakeMigration, paymentSlotMigration,
    refundLedgerMigration, disputeLedgerMigration, agreementImmutabilityMigration,
    quotePaymentIntegrityMigration, attributionMigration, leadClassificationMigration,
    reportFulfillmentMigration, agreementAcceptanceMigration, bookingProposalMigration,
    openAvailabilityMigration, recordKindMigration,
  ]) db.exec(m);
  if (applyOffline) db.exec(offlinePaymentMigration);
  return db;
}

/** A submitted request with no quote, booking or payment — the AMG's shape. */
function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES ('cus_a', 'Logan felix', 'logan@example.com', '5550100', '${T0}', '${T0}');
    INSERT INTO vehicles (id, year, make, model, trim, created_at, updated_at)
    VALUES ('veh_a', 2018, 'Mercedes-Benz', 'GLS-Class', 'AMG GL S 63', '${T0}', '${T0}');
    INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
    VALUES ('req_a', 'PPI-260827-D75X', 'cus_a', 'veh_a', 'submitted', '${T0}', '${T0}');
  `);
}

/** Exactly what the record_offline_payment batch writes, in the same order. */
function recordOffline(db: DatabaseSync, opts: { sessionId?: string; intent?: string; amount?: number } = {}): void {
  const amount = opts.amount ?? PAID;
  db.exec(`
    INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents,
                        travel_cents, addons_cents, discount_cents, total_cents,
                        expires_at, admin_note_internal, approved_by, created_at, updated_at)
    VALUES ('qot_o', 'req_a', 1, 'draft', 'euro_luxury_performance', 'usd', ${amount},
            0, 0, 0, ${amount}, '${T0}', 'Recorded from a payment collected outside Stripe: Zelle',
            'admin', '${T0}', '${T0}');
    INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
    VALUES ('qli_o', 'qot_o', 'base', 'Luxury & Performance pre-purchase inspection', ${amount}, 0);
    UPDATE quotes SET status = 'accepted' WHERE id = 'qot_o';
    INSERT INTO bookings (id, request_id, quote_id, slot_id, status, confirmed_at, created_at, updated_at)
    VALUES ('bkg_o', 'req_a', 'qot_o', NULL, 'confirmed', '${T0}', '${T0}', '${T0}');
    INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent,
                          amount_cents, currency, status, refunded_cents, method, offline_note, created_at, updated_at)
    VALUES ('pay_o', 'req_a', 'qot_o', 'bkg_o',
            ${opts.sessionId ? `'${opts.sessionId}'` : 'NULL'},
            ${opts.intent ? `'${opts.intent}'` : 'NULL'},
            ${amount}, 'usd', 'succeeded', 0, 'offline', 'Zelle', '${T0}', '${T0}');
    INSERT OR IGNORE INTO analytics_events (id, event, step, source, created_at)
    VALUES ('ev_payment_pay_o', 'ppi_payment_confirmed', 'workflow', 'ppi_offline', '${T0}');
  `);
}

describe('0017 — a job paid outside Stripe', () => {
  it('adds the columns and leaves every existing payment a Stripe payment', () => {
    const db = migrated(false);
    try {
      seed(db);
      // A pre-existing Stripe payment, written before the migration.
      db.exec(`
        INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents,
                            travel_cents, addons_cents, discount_cents, total_cents, expires_at, approved_by, created_at, updated_at)
        VALUES ('qot_s', 'req_a', 1, 'draft', 'standard', 'usd', 19900, 0, 0, 0, 19900, '${T0}', 'admin', '${T0}', '${T0}');
        INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
        VALUES ('qli_s', 'qot_s', 'base', 'Standard', 19900, 0);
        UPDATE quotes SET status = 'accepted' WHERE id = 'qot_s';
        INSERT INTO bookings (id, request_id, quote_id, status, created_at, updated_at)
        VALUES ('bkg_s', 'req_a', 'qot_s', 'confirmed', '${T0}', '${T0}');
        INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent,
                              amount_cents, currency, status, created_at, updated_at)
        VALUES ('pay_s', 'req_a', 'qot_s', 'bkg_s', 'cs_live_1', 'pi_live_1', 19900, 'usd', 'succeeded', '${T0}', '${T0}');
      `);

      db.exec(offlinePaymentMigration);

      const cols = db.prepare(`PRAGMA table_info(payments)`).all().map((c: { name: string }) => c.name);
      expect(cols).toContain('method');
      expect(cols).toContain('offline_note');
      // The existing charge is untouched and correctly labelled.
      const row = db.prepare(`SELECT method, amount_cents, stripe_session_id FROM payments WHERE id = 'pay_s'`).get() as Record<string, unknown>;
      expect(row['method']).toBe('stripe');
      expect(row['amount_cents']).toBe(19900);
      expect(row['stripe_session_id']).toBe('cs_live_1');
    } finally { db.close(); }
  });

  it('accepts the whole record the admin action writes, triggers and all', () => {
    const db = migrated();
    try {
      seed(db);
      expect(() => recordOffline(db)).not.toThrow();

      const p = db.prepare(`SELECT * FROM payments WHERE id = 'pay_o'`).get() as Record<string, unknown>;
      expect(p['amount_cents']).toBe(PAID);
      expect(p['status']).toBe('succeeded');
      expect(p['method']).toBe('offline');
      expect(p['offline_note']).toBe('Zelle');
      // No invented provider identity.
      expect(p['stripe_session_id']).toBeNull();
      expect(p['stripe_payment_intent']).toBeNull();

      // The booking is confirmed but carries no invented appointment window.
      const b = db.prepare(`SELECT status, slot_id FROM bookings WHERE id = 'bkg_o'`).get() as Record<string, unknown>;
      expect(b['status']).toBe('confirmed');
      expect(b['slot_id']).toBeNull();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM appointment_slots`).get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('counts as revenue in the same query the dashboard uses', () => {
    const db = migrated();
    try {
      seed(db);
      recordOffline(db);
      const row = db.prepare(`
        SELECT COUNT(*) AS paid, COALESCE(SUM(p.amount_cents), 0) AS gross
        FROM payments p
        JOIN analytics_events e
          ON e.id = 'ev_payment_' || p.id AND e.event = 'ppi_payment_confirmed'
        WHERE p.status IN ('succeeded', 'partially_refunded', 'disputed')
          AND p.request_id IN (SELECT id FROM ppi_requests WHERE deleted_at IS NULL AND record_kind = 'real')
      `).get() as Record<string, unknown>;
      expect(row['paid']).toBe(1);
      expect(row['gross']).toBe(PAID);
    } finally { db.close(); }
  });

  it('refuses an offline payment that claims a Stripe identity', () => {
    for (const bad of [{ sessionId: 'cs_live_fake' }, { intent: 'pi_live_fake' }]) {
      const db = migrated();
      try {
        seed(db);
        expect(() => recordOffline(db, bad)).toThrow(/cannot carry Stripe identities/);
      } finally { db.close(); }
    }
  });

  it('refuses to relabel a Stripe charge as cash, or cash as a Stripe charge', () => {
    const db = migrated();
    try {
      seed(db);
      recordOffline(db);
      expect(() => db.exec(`UPDATE payments SET method = 'stripe' WHERE id = 'pay_o'`))
        .toThrow(/payment method is immutable/);
      expect(() => db.exec(`UPDATE payments SET stripe_payment_intent = 'pi_live_x' WHERE id = 'pay_o'`))
        .toThrow(/cannot carry Stripe identities/);
    } finally { db.close(); }
  });

  it('still refuses a payment whose amount does not match its quote', () => {
    // 0008 is the reason an offline record cannot quietly invent a number.
    const db = migrated();
    try {
      seed(db);
      db.exec(`
        INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents,
                            travel_cents, addons_cents, discount_cents, total_cents, expires_at, approved_by, created_at, updated_at)
        VALUES ('qot_x', 'req_a', 1, 'draft', 'standard', 'usd', 19900, 0, 0, 0, 19900, '${T0}', 'admin', '${T0}', '${T0}');
        INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
        VALUES ('qli_x', 'qot_x', 'base', 'Standard', 19900, 0);
        UPDATE quotes SET status = 'accepted' WHERE id = 'qot_x';
        INSERT INTO bookings (id, request_id, quote_id, status, created_at, updated_at)
        VALUES ('bkg_x', 'req_a', 'qot_x', 'confirmed', '${T0}', '${T0}');
      `);
      expect(() => db.exec(`
        INSERT INTO payments (id, request_id, quote_id, booking_id, amount_cents, currency, status, method, created_at, updated_at)
        VALUES ('pay_x', 'req_a', 'qot_x', 'bkg_x', 32500, 'usd', 'succeeded', 'offline', '${T0}', '${T0}');
      `)).toThrow(/payment/i);
    } finally { db.close(); }
  });

  it('does not let a recorded payment fake a delivered report', () => {
    // "Completed" means the customer received their report. Recording money
    // must never be able to claim that on its own.
    const db = migrated();
    try {
      seed(db);
      recordOffline(db);
      const reports = db.prepare(`SELECT COUNT(*) AS n FROM inspection_reports WHERE request_id = 'req_a'`).get() as Record<string, unknown>;
      expect(reports['n']).toBe(0);
    } finally { db.close(); }
  });
});
