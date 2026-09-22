/// <reference types="vite/client" />

// Production rehearsal for migration 0014.
//
// The schema test next door proves 0014 on an empty database. This one proves
// it on a POPULATED one — a customer part-way through booking, a customer who
// has already paid, and a completed job with a published report — because the
// migration will be applied to a live database with real money in it, and an
// active booking has to survive the upgrade and still be completable
// afterwards on exactly the rows it started with.

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

/** Both migrations this release applies, in order. */
const RELEASE_MIGRATIONS = `${bookingProposalMigration}\n${openAvailabilityMigration}`;

const T0 = '2026-09-01T00:00:00.000Z';
const APPT = '2026-09-30T20:00:00.000Z';

/** Production today: every migration that has already been applied. */
function productionSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of [
    initialMigration, reportsMigration, intakeMigration, paymentSlotMigration,
    refundLedgerMigration, disputeLedgerMigration, agreementImmutabilityMigration,
    quotePaymentIntegrityMigration, attributionMigration, leadClassificationMigration,
    reportFulfillmentMigration, agreementAcceptanceMigration,
  ]) db.exec(m);
  return db;
}

function slotSql(id: string, requestId: string, startsAt: string, status: string): string {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + 120 * 60_000);
  return `INSERT INTO appointment_slots
    (id, request_id, starts_at, ends_at, blocked_starts_at, blocked_ends_at, status, created_at, updated_at)
    VALUES ('${id}', '${requestId}', '${start.toISOString()}', '${end.toISOString()}',
            '${new Date(start.getTime() - 45 * 60_000).toISOString()}',
            '${new Date(end.getTime() + 60 * 60_000).toISOString()}',
            '${status}', '${T0}', '${T0}');`;
}

/** Three customers mid-flight, exactly as a live database would hold them. */
function seedLiveTraffic(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at) VALUES
      ('cus_live1', 'Mid Booking', 'mid@example.com', '7025550101', '${T0}', '${T0}'),
      ('cus_live2', 'Already Paid', 'paid@example.com', '7025550102', '${T0}', '${T0}'),
      ('cus_live3', 'Finished Job', 'done@example.com', '7025550103', '${T0}', '${T0}');
    INSERT INTO vehicles (id, year, make, model, mod_status, created_at, updated_at) VALUES
      ('veh_live1', 2019, 'Toyota', 'Corolla', 'stock', '${T0}', '${T0}'),
      ('veh_live2', 2020, 'BMW', '330i', 'stock', '${T0}', '${T0}'),
      ('veh_live3', 2018, 'Honda', 'Accord', 'light', '${T0}', '${T0}');
    INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, loc_zip, travel_miles, suggested_tier, created_at, updated_at) VALUES
      ('req_live1', 'PPI-LIVE-1', 'cus_live1', 'veh_live1', 'awaiting_payment', '89147', 8.2, 'standard', '${T0}', '${T0}'),
      ('req_live2', 'PPI-LIVE-2', 'cus_live2', 'veh_live2', 'confirmed', '89015', 25.6, 'euro_luxury_performance', '${T0}', '${T0}'),
      ('req_live3', 'PPI-LIVE-3', 'cus_live3', 'veh_live3', 'completed', '89135', 3.6, 'standard', '${T0}', '${T0}');
  `);

  // Quotes are born as drafts, receive line items, then commit (trigger 0008).
  for (const [quoteId, requestId, total] of [
    ['qot_live1', 'req_live1', 19900],
    ['qot_live2', 'req_live2', 34900],
    ['qot_live3', 'req_live3', 19900],
  ] as const) {
    db.exec(`
      INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents,
                          travel_cents, addons_cents, discount_cents, total_cents, expires_at,
                          approved_by, created_at, updated_at)
      VALUES ('${quoteId}', '${requestId}', 1, 'draft', 'standard', 'usd', ${total - (total - 19900)},
              ${total - 19900}, 0, 0, ${total}, '2027-01-01T00:00:00.000Z', 'owner', '${T0}', '${T0}');
      INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
      VALUES ('qli_${quoteId}_b', '${quoteId}', 'base', 'Standard Vehicle PPI', 19900, 0);
      ${total > 19900 ? `INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
      VALUES ('qli_${quoteId}_t', '${quoteId}', 'travel', 'Mobile-service charge', ${total - 19900}, 1);` : ''}
      UPDATE quotes SET status = '${requestId === 'req_live1' ? 'sent' : 'accepted'}' WHERE id = '${quoteId}';
    `);
  }

  db.exec(slotSql('slt_live1', 'req_live1', APPT, 'held'));
  db.exec(slotSql('slt_live2', 'req_live2', '2026-10-02T20:00:00.000Z', 'confirmed'));
  db.exec(slotSql('slt_live3', 'req_live3', '2026-09-10T20:00:00.000Z', 'confirmed'));

  db.exec(`
    INSERT INTO bookings (id, request_id, quote_id, slot_id, status, created_at, updated_at) VALUES
      ('bkg_live1', 'req_live1', 'qot_live1', 'slt_live1', 'pending_payment', '${T0}', '${T0}'),
      ('bkg_live2', 'req_live2', 'qot_live2', 'slt_live2', 'confirmed', '${T0}', '${T0}'),
      ('bkg_live3', 'req_live3', 'qot_live3', 'slt_live3', 'confirmed', '${T0}', '${T0}');
    INSERT INTO payments (id, request_id, quote_id, booking_id, amount_cents, currency, status,
                          stripe_session_id, stripe_payment_intent, created_at, updated_at) VALUES
      ('pay_live2', 'req_live2', 'qot_live2', 'bkg_live2', 34900, 'usd', 'succeeded',
       'cs_live_2', 'pi_live_2', '${T0}', '${T0}'),
      ('pay_live3', 'req_live3', 'qot_live3', 'bkg_live3', 19900, 'usd', 'succeeded',
       'cs_live_3', 'pi_live_3', '${T0}', '${T0}');
    INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
    VALUES ('agv_live', 'cancellation_policy', 3, 'Cancellation and Refund Policy',
            'Body', 'sha-live', '${T0}');
    INSERT INTO agreement_acceptances (id, request_id, quote_id, agreement_version_id, accepted,
                                       typed_name, ip, user_agent, created_at)
    VALUES ('aca_live2', 'req_live2', 'qot_live2', 'agv_live', 1, 'Already Paid',
            '198.51.100.9', 'test-agent', '${T0}');
    INSERT INTO magic_links (id, request_id, token_hash, purpose, expires_at, created_at)
    VALUES ('ml_live1', 'req_live1', 'hash-live-1', 'portal', '2027-01-01T00:00:00.000Z', '${T0}'),
           ('ml_live2', 'req_live2', 'hash-live-2', 'portal', '2027-01-01T00:00:00.000Z', '${T0}');
  `);
}

function census(db: DatabaseSync): Record<string, unknown> {
  const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
  return {
    requests: one(`SELECT COUNT(*) AS n FROM ppi_requests`),
    quotes: one(`SELECT COUNT(*) AS n, SUM(total_cents) AS cents FROM quotes`),
    lineItems: one(`SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM quote_line_items`),
    slots: one(`SELECT COUNT(*) AS n FROM appointment_slots`),
    bookings: one(`SELECT COUNT(*) AS n FROM bookings`),
    payments: one(`SELECT COUNT(*) AS n, SUM(amount_cents) AS cents FROM payments`),
    acceptances: one(`SELECT COUNT(*) AS n FROM agreement_acceptances`),
    links: one(`SELECT COUNT(*) AS n FROM magic_links WHERE revoked_at IS NULL`),
    statuses: one(`SELECT group_concat(status, ',') AS s FROM (SELECT status FROM ppi_requests ORDER BY id)`),
  };
}

describe('0014 applied to a populated production database', () => {
  it('changes no existing row: money, bookings, evidence and links survive intact', () => {
    const db = productionSchema();
    try {
      seedLiveTraffic(db);
      const before = census(db);
      db.exec(RELEASE_MIGRATIONS);
      expect(census(db)).toEqual(before);

      // Spot-check the rows that matter most, field by field.
      expect(db.prepare(`SELECT total_cents, status FROM quotes WHERE id = 'qot_live2'`).get())
        .toEqual({ total_cents: 34900, status: 'accepted' });
      expect(db.prepare(`SELECT amount_cents, status, stripe_payment_intent FROM payments WHERE id = 'pay_live2'`).get())
        .toEqual({ amount_cents: 34900, status: 'succeeded', stripe_payment_intent: 'pi_live_2' });
      expect(db.prepare(`SELECT typed_name, accepted FROM agreement_acceptances WHERE id = 'aca_live2'`).get())
        .toEqual({ typed_name: 'Already Paid', accepted: 1 });
      // Existing customer links keep working — nothing is revoked.
      expect(db.prepare(`SELECT COUNT(*) AS n FROM magic_links WHERE revoked_at IS NOT NULL`).get())
        .toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('lets a customer who was mid-booking finish on the rows they started with', () => {
    const db = productionSchema();
    try {
      seedLiveTraffic(db);
      db.exec(RELEASE_MIGRATIONS);

      // req_live1 was at awaiting_payment with a held slot. Complete it exactly
      // as the webhook would, against the pre-migration quote, slot and booking.
      db.exec(`
        UPDATE appointment_slots SET status = 'confirmed', hold_expires_at = NULL WHERE id = 'slt_live1';
        UPDATE bookings SET status = 'confirmed', confirmed_at = '${T0}' WHERE id = 'bkg_live1';
        UPDATE ppi_requests SET status = 'confirmed' WHERE id = 'req_live1';
        INSERT INTO payments (id, request_id, quote_id, booking_id, amount_cents, currency, status,
                              stripe_session_id, stripe_payment_intent, created_at, updated_at)
        VALUES ('pay_live1', 'req_live1', 'qot_live1', 'bkg_live1', 19900, 'usd', 'succeeded',
                'cs_live_1', 'pi_live_1', '${T0}', '${T0}');
      `);

      expect(db.prepare(`SELECT status FROM ppi_requests WHERE id = 'req_live1'`).get())
        .toEqual({ status: 'confirmed' });
      expect(db.prepare(`SELECT amount_cents FROM payments WHERE id = 'pay_live1'`).get())
        .toEqual({ amount_cents: 19900 });
      // They were charged the price they were quoted before the upgrade.
      expect(db.prepare(`SELECT total_cents FROM quotes WHERE id = 'qot_live1'`).get())
        .toEqual({ total_cents: 19900 });
    } finally { db.close(); }
  });

  it('still refuses to double-book a confirmed appointment after the upgrade', () => {
    const db = productionSchema();
    try {
      seedLiveTraffic(db);
      db.exec(RELEASE_MIGRATIONS);
      // req_live2 holds a confirmed 2026-10-02 appointment. Another customer
      // may be OFFERED that window, but can never reserve it.
      db.exec(slotSql('slt_intruder', 'req_live1', '2026-10-02T20:00:00.000Z', 'offered'));
      expect(() => db.exec(`UPDATE appointment_slots SET status = 'held' WHERE id = 'slt_intruder'`))
        .toThrow(/overlaps an active window/u);
    } finally { db.close(); }
  });

  it('is idempotent enough to survive a half-applied retry', () => {
    const db = productionSchema();
    try {
      seedLiveTraffic(db);
      db.exec(RELEASE_MIGRATIONS);
      const after = census(db);
      // The table and index guards are IF NOT EXISTS and the triggers are
      // dropped before creation, so re-running everything except the ALTERs
      // (which SQLite rejects as duplicate columns, exactly as intended) is
      // safe. Prove the trigger half specifically, since that is what a
      // partially applied migration would most likely repeat.
      const triggerHalf = openAvailabilityMigration.slice(openAvailabilityMigration.indexOf('DROP TRIGGER'));
      db.exec(triggerHalf);
      expect(census(db)).toEqual(after);
      db.exec(slotSql('slt_intruder2', 'req_live1', '2026-10-02T20:00:00.000Z', 'offered'));
      expect(() => db.exec(`UPDATE appointment_slots SET status = 'confirmed' WHERE id = 'slt_intruder2'`))
        .toThrow(/overlaps an active window/u);
    } finally { db.close(); }
  });

  it('refuses a duplicated ALTER, so a re-run fails loudly instead of corrupting', () => {
    const db = productionSchema();
    try {
      db.exec(RELEASE_MIGRATIONS);
      expect(() => db.exec(RELEASE_MIGRATIONS)).toThrow(/duplicate column/iu);
    } finally { db.close(); }
  });
});
