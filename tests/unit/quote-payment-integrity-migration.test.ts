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

function migratedThrough0007(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(initialMigration);
  db.exec(reportsMigration);
  db.exec(intakeMigration);
  db.exec(paymentSlotMigration);
  db.exec(refundLedgerMigration);
  db.exec(disputeLedgerMigration);
  db.exec(agreementImmutabilityMigration);
  db.exec(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES ('cus_integrity', 'Integrity Test', 'integrity@example.com', '555-0100', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO vehicles (id, make, model, created_at, updated_at)
    VALUES ('veh_integrity', 'Test', 'Vehicle', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
    VALUES
      ('req_integrity', 'PPI-INTEGRITY', 'cus_integrity', 'veh_integrity', 'awaiting_payment', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
      ('req_integrity_other', 'PPI-INTEGRITY-OTHER', 'cus_integrity', 'veh_integrity', 'awaiting_payment', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
  `);
  return db;
}

function insertQuote(
  db: DatabaseSync,
  id: string,
  status: 'draft' | 'sent' | 'accepted' | 'superseded' = 'sent',
  requestId = 'req_integrity',
  version = 1,
): void {
  db.exec(`
    INSERT INTO quotes
      (id, request_id, version, status, tier, currency, subtotal_cents, travel_cents,
       addons_cents, discount_cents, total_cents, expires_at, approved_by, created_at, updated_at)
    VALUES
      ('${id}', '${requestId}', ${version}, '${status}', 'standard', 'usd', 10000, 1000,
       2000, 500, 12500, '2031-01-01T00:00:00.000Z', 'test',
       '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort) VALUES
      ('qli_${id}_base', '${id}', 'base', 'Base', 10000, 0),
      ('qli_${id}_travel', '${id}', 'travel', 'Travel', 1000, 1),
      ('qli_${id}_addon', '${id}', 'addon', 'Addon', 2000, 2),
      ('qli_${id}_discount', '${id}', 'discount', 'Discount', -500, 3);
  `);
}

function insertCommittedQuote(
  db: DatabaseSync,
  id: string,
  requestId = 'req_integrity',
  version = 1,
): void {
  insertQuote(db, id, 'draft', requestId, version);
  db.prepare(`UPDATE quotes SET status = 'sent' WHERE id = ?`).run(id);
}

function insertBooking(
  db: DatabaseSync,
  id: string,
  quoteId: string,
  requestId = 'req_integrity',
): void {
  db.prepare(
    `INSERT INTO bookings (id, request_id, quote_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending_payment', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
  ).run(id, requestId, quoteId);
}

interface PaymentFixture {
  id: string;
  requestId?: string;
  quoteId: string;
  bookingId: string;
  amountCents?: number;
  currency?: string;
  status?: 'created' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'refunded' | 'partially_refunded' | 'disputed';
  refundedCents?: number;
  stripeSessionId?: string | null;
  stripePaymentIntent?: string | null;
}

function insertPayment(db: DatabaseSync, input: PaymentFixture): void {
  db.prepare(
    `INSERT INTO payments
       (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent,
        amount_cents, currency, status, refunded_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
  ).run(
    input.id,
    input.requestId ?? 'req_integrity',
    input.quoteId,
    input.bookingId,
    input.stripeSessionId ?? null,
    input.stripePaymentIntent ?? null,
    input.amountCents ?? 12500,
    input.currency ?? 'usd',
    input.status ?? 'created',
    input.refundedCents ?? 0,
  );
}

describe('quote and payment integrity migration', () => {
  for (const status of ['sent', 'accepted', 'superseded', 'expired', 'cancelled'] as const) {
    it(`preflight rejects an invalid historical ${status} quote`, () => {
      const db = migratedThrough0007();
      try {
        db.exec(`
          INSERT INTO quotes
            (id, request_id, version, status, tier, currency, subtotal_cents, total_cents,
             expires_at, approved_by, created_at, updated_at)
          VALUES ('qot_bad_${status}', 'req_integrity', 1, '${status}', 'standard', 'usd',
                  10000, 10000, '2031-01-01T00:00:00.000Z', 'test',
                  '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        `);
        expect(() => db.exec(quotePaymentIntegrityMigration)).toThrow(/CHECK constraint failed/);
      } finally {
        db.close();
      }
    });
  }

  it('preflight rejects every payment whose quote and booking identity is not exact', () => {
    const db = migratedThrough0007();
    try {
      insertQuote(db, 'qot_preflight');
      db.exec(`
        INSERT INTO bookings (id, request_id, quote_id, status, created_at, updated_at)
        VALUES ('bkg_preflight', 'req_integrity', 'qot_preflight', 'pending_payment',
                '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO payments
          (id, request_id, quote_id, booking_id, amount_cents, currency, status, created_at, updated_at)
        VALUES ('pay_preflight', 'req_integrity', 'qot_preflight', 'bkg_preflight', 12499,
                'usd', 'created', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      `);
      expect(() => db.exec(quotePaymentIntegrityMigration)).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('preflight rejects out-of-bounds historical refund totals', () => {
    const db = migratedThrough0007();
    try {
      insertQuote(db, 'qot_bad_refund');
      insertBooking(db, 'bkg_bad_refund', 'qot_bad_refund');
      insertPayment(db, {
        id: 'pay_bad_refund',
        quoteId: 'qot_bad_refund',
        bookingId: 'bkg_bad_refund',
        status: 'refunded',
        refundedCents: 12501,
      });
      expect(() => db.exec(quotePaymentIntegrityMigration)).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('preflight rejects duplicate or blank historical Stripe identities', () => {
    const duplicate = migratedThrough0007();
    try {
      insertQuote(duplicate, 'qot_provider_1');
      insertBooking(duplicate, 'bkg_provider_1', 'qot_provider_1');
      insertPayment(duplicate, {
        id: 'pay_provider_1',
        quoteId: 'qot_provider_1',
        bookingId: 'bkg_provider_1',
        status: 'expired',
        stripePaymentIntent: 'pi_duplicate',
      });
      insertQuote(duplicate, 'qot_provider_2', 'sent', 'req_integrity_other');
      insertBooking(duplicate, 'bkg_provider_2', 'qot_provider_2', 'req_integrity_other');
      insertPayment(duplicate, {
        id: 'pay_provider_2',
        requestId: 'req_integrity_other',
        quoteId: 'qot_provider_2',
        bookingId: 'bkg_provider_2',
        status: 'expired',
        stripePaymentIntent: 'pi_duplicate',
      });
      expect(() => duplicate.exec(quotePaymentIntegrityMigration)).toThrow(/CHECK constraint failed/);
    } finally {
      duplicate.close();
    }

    const blank = migratedThrough0007();
    try {
      insertQuote(blank, 'qot_provider_blank');
      insertBooking(blank, 'bkg_provider_blank', 'qot_provider_blank');
      insertPayment(blank, {
        id: 'pay_provider_blank',
        quoteId: 'qot_provider_blank',
        bookingId: 'bkg_provider_blank',
        status: 'expired',
        stripeSessionId: '   ',
      });
      expect(() => blank.exec(quotePaymentIntegrityMigration)).toThrow(/CHECK constraint failed/);
    } finally {
      blank.close();
    }
  });

  it('preflight preserves a terminal payment after its one-per-request booking was rebound', () => {
    const db = migratedThrough0007();
    try {
      insertQuote(db, 'qot_historical');
      insertQuote(db, 'qot_current', 'sent', 'req_integrity', 2);
      insertBooking(db, 'bkg_rebound', 'qot_historical');
      insertPayment(db, {
        id: 'pay_historical',
        quoteId: 'qot_historical',
        bookingId: 'bkg_rebound',
        status: 'expired',
        stripeSessionId: 'cs_historical',
      });
      db.exec(`UPDATE bookings SET quote_id = 'qot_current' WHERE id = 'bkg_rebound'`);

      expect(() => db.exec(quotePaymentIntegrityMigration)).not.toThrow();
      expect(db.prepare(`SELECT quote_id FROM bookings WHERE id = 'bkg_rebound'`).get())
        .toEqual({ quote_id: 'qot_current' });
      expect(db.prepare(`SELECT quote_id, booking_id FROM payments WHERE id = 'pay_historical'`).get())
        .toEqual({ quote_id: 'qot_historical', booking_id: 'bkg_rebound' });
    } finally {
      db.close();
    }
  });

  it('preserves valid historical rows and enforces committed quote and payment identity', () => {
    const db = migratedThrough0007();
    try {
      insertQuote(db, 'qot_valid');
      db.exec(`
        INSERT INTO bookings (id, request_id, quote_id, status, created_at, updated_at)
        VALUES ('bkg_valid', 'req_integrity', 'qot_valid', 'pending_payment',
                '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
        INSERT INTO payments
          (id, request_id, quote_id, booking_id, amount_cents, currency, status, created_at, updated_at)
        VALUES ('pay_valid', 'req_integrity', 'qot_valid', 'bkg_valid', 12500, 'usd', 'created',
                '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      `);

      expect(() => db.exec(quotePaymentIntegrityMigration)).not.toThrow();
      expect(db.prepare(`SELECT status, total_cents FROM quotes WHERE id = 'qot_valid'`).get())
        .toEqual({ status: 'sent', total_cents: 12500 });
      expect(db.prepare(`SELECT amount_cents, currency FROM payments WHERE id = 'pay_valid'`).get())
        .toEqual({ amount_cents: 12500, currency: 'usd' });

      expect(() => db.exec(`
        INSERT INTO quotes
          (id, request_id, version, status, tier, currency, subtotal_cents, total_cents,
           expires_at, approved_by, created_at, updated_at)
        VALUES ('qot_direct_sent', 'req_integrity', 2, 'sent', 'standard', 'usd', 10000, 10000,
                '2031-01-01T00:00:00.000Z', 'test', '2030-01-01T00:00:00.000Z',
                '2030-01-01T00:00:00.000Z');
      `)).toThrow(/inserted as draft/);
      expect(() => db.exec(`UPDATE quotes SET total_cents = 12400 WHERE id = 'qot_valid'`))
        .toThrow(/monetary identity is immutable/);
      expect(() => db.exec(`UPDATE quotes SET status = 'draft' WHERE id = 'qot_valid'`))
        .toThrow(/cannot return to draft/);
      expect(() => db.exec(`UPDATE quote_line_items SET amount_cents = 9999 WHERE id = 'qli_qot_valid_base'`))
        .toThrow(/editable only while draft/);
      expect(() => db.exec(`DELETE FROM quote_line_items WHERE id = 'qli_qot_valid_base'`))
        .toThrow(/editable only while draft/);
      expect(() => db.exec(`UPDATE payments SET amount_cents = 1 WHERE id = 'pay_valid'`))
        .toThrow(/payment monetary identity is immutable/);

      insertQuote(db, 'qot_other', 'draft', 'req_integrity', 2);
      db.exec(`UPDATE quotes SET status = 'sent' WHERE id = 'qot_other'`);
      expect(() => db.exec(`UPDATE bookings SET quote_id = 'qot_other' WHERE id = 'bkg_valid'`))
        .toThrow(/only after failed or expired/);

      db.exec(`UPDATE payments SET status = 'expired' WHERE id = 'pay_valid'`);
      expect(() => db.exec(`UPDATE bookings SET quote_id = 'qot_other' WHERE id = 'bkg_valid'`))
        .not.toThrow();
      expect(db.prepare(`SELECT quote_id FROM payments WHERE id = 'pay_valid'`).get())
        .toEqual({ quote_id: 'qot_valid' });
      expect(db.prepare(`SELECT quote_id FROM bookings WHERE id = 'bkg_valid'`).get())
        .toEqual({ quote_id: 'qot_other' });
      expect(() => db.exec(`UPDATE payments SET status = 'pending' WHERE id = 'pay_valid'`))
        .toThrow(/open payment must match the booking current quote/);

      expect(() => db.exec(`
        INSERT INTO payments
          (id, request_id, quote_id, booking_id, amount_cents, currency, status, created_at, updated_at)
        VALUES ('pay_wrong_amount', 'req_integrity', 'qot_other', 'bkg_valid', 1, 'usd', 'created',
                '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      `)).toThrow(/does not match quote and booking|payment quote components are invalid/);
      expect(() => insertPayment(db, {
        id: 'pay_refreshed',
        quoteId: 'qot_other',
        bookingId: 'bkg_valid',
        stripeSessionId: 'cs_refreshed',
      })).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('validates draft components and exact signed line sums before use', () => {
    const db = migratedThrough0007();
    try {
      db.exec(quotePaymentIntegrityMigration);
      insertQuote(db, 'qot_bad_lines', 'draft');
      db.exec(`UPDATE quote_line_items SET amount_cents = -2000 WHERE id = 'qli_qot_bad_lines_addon'`);
      expect(() => db.exec(`UPDATE quotes SET status = 'sent' WHERE id = 'qot_bad_lines'`))
        .toThrow(/components and line items must match/);
      db.exec(`UPDATE quote_line_items SET amount_cents = 2000 WHERE id = 'qli_qot_bad_lines_addon'`);
      expect(() => db.exec(`UPDATE quotes SET currency = 'USD', status = 'sent' WHERE id = 'qot_bad_lines'`))
        .toThrow(/components and line items must match/);
      expect(() => db.exec(`UPDATE quotes SET currency = 'usd', status = 'sent' WHERE id = 'qot_bad_lines'`))
        .not.toThrow();
    } finally {
      db.close();
    }
  });
});
