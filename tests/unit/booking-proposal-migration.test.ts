/// <reference types="vite/client" />

// Migration 0014 does two things worth proving against a real SQLite engine:
// it adds the booking-proposal records without disturbing anything existing,
// and it changes what counts as an appointment conflict so the owner can offer
// three alternatives on one afternoon — which the 0004 triggers made impossible.

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

const T0 = '2030-01-01T00:00:00.000Z';

/** The production schema as it stands today, then 0014 on top. */
function migrated(applyBooking = true): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of [
    initialMigration, reportsMigration, intakeMigration, paymentSlotMigration,
    refundLedgerMigration, disputeLedgerMigration, agreementImmutabilityMigration,
    quotePaymentIntegrityMigration, attributionMigration, leadClassificationMigration,
    reportFulfillmentMigration, agreementAcceptanceMigration,
  ]) db.exec(m);
  if (applyBooking) db.exec(bookingProposalMigration);
  return db;
}

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES ('cus_a', 'Test Buyer', 'buyer@example.com', '5550100', '${T0}', '${T0}');
    INSERT INTO vehicles (id, make, model, created_at, updated_at)
    VALUES ('veh_a', 'Toyota', 'Corolla', '${T0}', '${T0}');
    INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
    VALUES
      ('req_a', 'PPI-A', 'cus_a', 'veh_a', 'quote_sent', '${T0}', '${T0}'),
      ('req_b', 'PPI-B', 'cus_a', 'veh_a', 'quote_sent', '${T0}', '${T0}');
    INSERT INTO quotes
      (id, request_id, version, status, tier, currency, subtotal_cents, travel_cents,
       addons_cents, discount_cents, total_cents, expires_at, approved_by, created_at, updated_at)
    VALUES ('qot_a', 'req_a', 1, 'draft', 'standard', 'usd', 19900, 0, 0, 0, 19900,
            '2031-01-01T00:00:00.000Z', 'admin', '${T0}', '${T0}');
    INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
    VALUES ('qli_a', 'qot_a', 'base', 'Standard Vehicle PPI', 19900, 0);
    UPDATE quotes SET status = 'sent' WHERE id = 'qot_a';
  `);
}

/** Three same-day options with the shipped 120/45/60 minute windows. */
function insertSlot(db: DatabaseSync, id: string, requestId: string, startsAt: string, status = 'offered'): void {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + 120 * 60_000);
  const blockedStart = new Date(start.getTime() - 45 * 60_000).toISOString();
  const blockedEnd = new Date(end.getTime() + 60 * 60_000).toISOString();
  db.exec(`
    INSERT INTO appointment_slots
      (id, request_id, starts_at, ends_at, blocked_starts_at, blocked_ends_at, status, created_at, updated_at)
    VALUES ('${id}', '${requestId}', '${start.toISOString()}', '${end.toISOString()}',
            '${blockedStart}', '${blockedEnd}', '${status}', '${T0}', '${T0}');
  `);
}

describe('0014 — booking proposal records', () => {
  it('adds the new columns without touching existing data', () => {
    const db = migrated();
    try {
      seed(db);
      const cols = db.prepare(`PRAGMA table_info(ppi_requests)`).all().map((c: { name: string }) => c.name);
      expect(cols).toContain('customer_selected_tier');
      expect(cols).toContain('tier_selection_source');
      expect(cols).toContain('tier_review_needed');
      expect(db.prepare(`PRAGMA table_info(vehicles)`).all().map((c: { name: string }) => c.name)).toContain('mod_details');

      // Rows that existed before the migration keep working and default safely.
      const row = db.prepare(`SELECT customer_selected_tier, tier_review_needed FROM ppi_requests WHERE id = 'req_a'`).get() as Record<string, unknown>;
      expect(row['customer_selected_tier']).toBeNull();
      expect(row['tier_review_needed']).toBe(0);
    } finally { db.close(); }
  });

  it('lets one idempotency key create exactly one proposal', () => {
    const db = migrated();
    try {
      seed(db);
      const insert = () => db.exec(`
        INSERT INTO booking_proposals
          (id, request_id, quote_id, slot_ids_json, total_cents, customer_message,
           notification_status, idempotency_key, created_by, created_at, updated_at)
        VALUES ('bpr_1', 'req_a', 'qot_a', '["slt_1"]', 19900, 'hello', 'saved', 'key-1', 'admin', '${T0}', '${T0}');
      `);
      insert();
      // A double click, a retried fetch and a duplicated tab all land here.
      expect(() => db.exec(`
        INSERT INTO booking_proposals
          (id, request_id, quote_id, slot_ids_json, total_cents, customer_message,
           notification_status, idempotency_key, created_by, created_at, updated_at)
        VALUES ('bpr_2', 'req_a', 'qot_a', '["slt_1"]', 19900, 'hello', 'saved', 'key-1', 'admin', '${T0}', '${T0}');
      `)).toThrow();
      expect(db.prepare(`SELECT COUNT(*) AS n FROM booking_proposals`).get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});

describe('0014 — alternatives for one inspection may share a buffer window', () => {
  const NINE = '2030-06-03T16:00:00.000Z';      // 9:00 AM Las Vegas
  const TWELVE_THIRTY = '2030-06-03T19:30:00.000Z';
  const FOUR = '2030-06-03T23:00:00.000Z';

  it('is exactly what the 0004 triggers used to prevent', () => {
    const db = migrated(false);
    try {
      seed(db);
      insertSlot(db, 'slt_1', 'req_a', NINE);
      // The shipped template times, on the shipped buffers, aborted.
      expect(() => insertSlot(db, 'slt_2', 'req_a', TWELVE_THIRTY)).toThrow(/overlaps an active window/u);
    } finally { db.close(); }
  });

  it('now accepts all three suggested template times on one request', () => {
    const db = migrated();
    try {
      seed(db);
      insertSlot(db, 'slt_1', 'req_a', NINE);
      insertSlot(db, 'slt_2', 'req_a', TWELVE_THIRTY);
      insertSlot(db, 'slt_3', 'req_a', FOUR);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM appointment_slots WHERE request_id = 'req_a' AND status = 'offered'`).get())
        .toEqual({ n: 3 });
    } finally { db.close(); }
  });

  it('still refuses to offer an overlapping window to a DIFFERENT customer', () => {
    const db = migrated();
    try {
      seed(db);
      insertSlot(db, 'slt_1', 'req_a', NINE);
      expect(() => insertSlot(db, 'slt_x', 'req_b', TWELVE_THIRTY)).toThrow(/overlaps an active window/u);
    } finally { db.close(); }
  });

  it('holding one option does not trip on its own sibling options', () => {
    const db = migrated();
    try {
      seed(db);
      insertSlot(db, 'slt_1', 'req_a', NINE);
      insertSlot(db, 'slt_2', 'req_a', TWELVE_THIRTY);
      db.exec(`UPDATE appointment_slots SET status = 'held', hold_expires_at = '${T0}' WHERE id = 'slt_2'`);
      expect(db.prepare(`SELECT status FROM appointment_slots WHERE id = 'slt_2'`).get()).toEqual({ status: 'held' });
    } finally { db.close(); }
  });

  it('once a time is held, nobody else can be offered or hold that window', () => {
    const db = migrated();
    try {
      seed(db);
      insertSlot(db, 'slt_1', 'req_a', NINE);
      db.exec(`UPDATE appointment_slots SET status = 'held' WHERE id = 'slt_1'`);
      expect(() => insertSlot(db, 'slt_x', 'req_b', NINE)).toThrow(/overlaps an active window/u);
      expect(() => insertSlot(db, 'slt_y', 'req_b', TWELVE_THIRTY)).toThrow(/overlaps an active window/u);
    } finally { db.close(); }
  });

  it('a confirmed appointment still blocks every other request', () => {
    const db = migrated();
    try {
      seed(db);
      insertSlot(db, 'slt_1', 'req_a', NINE, 'confirmed');
      expect(() => insertSlot(db, 'slt_x', 'req_b', NINE)).toThrow(/overlaps an active window/u);
    } finally { db.close(); }
  });

  it('keeps the exact-start-time double-booking guard from 0001', () => {
    const db = migrated();
    try {
      seed(db);
      insertSlot(db, 'slt_1', 'req_a', NINE);
      insertSlot(db, 'slt_2', 'req_a', NINE); // same instant, both merely offered
      db.exec(`UPDATE appointment_slots SET status = 'held' WHERE id = 'slt_1'`);
      // Two held/confirmed rows can never share a start time.
      expect(() => db.exec(`UPDATE appointment_slots SET status = 'held' WHERE id = 'slt_2'`)).toThrow();
    } finally { db.close(); }
  });
});
