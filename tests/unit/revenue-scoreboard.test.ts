/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { loadRevenueWindow } from '../../functions/api/admin/overview.ts';

afterEach(() => vi.useRealTimers());

const migrations = [
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

function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; },
        async all<T>() { return { results: db.prepare(sql).all(...values) as T[] }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function seedPaidRequest(
  db: DatabaseSync,
  suffix: string,
  createdDaysAgo: number,
  amountCents: number,
  source: string,
  status: 'succeeded' | 'disputed',
  refundedCents = 0,
): void {
  const createdAt = isoDaysAgo(createdDaysAgo);
  const customerId = `cus_${suffix}`;
  const vehicleId = `veh_${suffix}`;
  const requestId = `req_${suffix}`;
  const quoteId = `qot_${suffix}`;
  const bookingId = `bkg_${suffix}`;
  const paymentId = `pay_${suffix}`;
  db.prepare(`INSERT INTO customers (id, full_name, email, phone, created_at, updated_at) VALUES (?, ?, ?, '7025550100', ?, ?)`)
    .run(customerId, `Customer ${suffix}`, `${suffix}@example.com`, createdAt, createdAt);
  db.prepare(`INSERT INTO vehicles (id, make, model, created_at, updated_at) VALUES (?, 'Test', 'Vehicle', ?, ?)`)
    .run(vehicleId, createdAt, createdAt);
  db.prepare(`INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, attribution_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(requestId, `PPI-${suffix.toUpperCase()}`, customerId, vehicleId, status === 'disputed' ? 'disputed' : 'confirmed', source, createdAt, createdAt);

  for (const [kind, days] of [['ready_for_review', createdDaysAgo - 0.2], ['quote_sent', createdDaysAgo - 0.4]] as const) {
    db.prepare(`INSERT INTO status_history (id, request_id, to_status, actor, created_at) VALUES (?, ?, ?, 'admin:test', ?)`)
      .run(`sh_${suffix}_${kind}`, requestId, kind, isoDaysAgo(days));
  }
  if (suffix === 'recent') {
    db.prepare(`INSERT INTO status_history (id, request_id, to_status, actor, created_at) VALUES (?, ?, 'completed', 'admin:test', ?)`)
      .run(`sh_${suffix}_completed`, requestId, isoDaysAgo(1));
  }

  db.prepare(`INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at) VALUES (?, ?, 1, 'draft', 'standard', 'usd', ?, ?, '2031-01-01T00:00:00.000Z', 'admin:test', ?, ?)`)
    .run(quoteId, requestId, amountCents, amountCents, createdAt, createdAt);
  db.prepare(`INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort) VALUES (?, ?, 'base', 'Test PPI', ?, 0)`)
    .run(`qli_${suffix}`, quoteId, amountCents);
  db.prepare(`UPDATE quotes SET status = 'accepted' WHERE id = ?`).run(quoteId);
  db.prepare(`INSERT INTO bookings (id, request_id, quote_id, status, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, 'confirmed', ?, ?, ?)`)
    .run(bookingId, requestId, quoteId, isoDaysAgo(Math.max(createdDaysAgo - 1, 0.1)), createdAt, createdAt);
  db.prepare(`INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent, amount_cents, currency, status, refunded_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?)`)
    .run(paymentId, requestId, quoteId, bookingId, `cs_${suffix}`, `pi_${suffix}`, amountCents, status, refundedCents, createdAt, createdAt);
  db.prepare(`INSERT INTO analytics_events (id, event, source, created_at) VALUES (?, 'ppi_payment_confirmed', ?, ?)`)
    .run(`ev_payment_${paymentId}`, source, isoDaysAgo(Math.max(createdDaysAgo - 1.5, 0.1)));
}

function seedUnpaidRequest(db: DatabaseSync, suffix: string, source: string): void {
  const createdAt = isoDaysAgo(5);
  const customerId = `cus_${suffix}`;
  const vehicleId = `veh_${suffix}`;
  db.prepare(`INSERT INTO customers (id, full_name, email, phone, created_at, updated_at) VALUES (?, ?, ?, '7025550100', ?, ?)`)
    .run(customerId, `Customer ${suffix}`, `${suffix}@example.com`, createdAt, createdAt);
  db.prepare(`INSERT INTO vehicles (id, make, model, created_at, updated_at) VALUES (?, 'Test', 'Vehicle', ?, ?)`)
    .run(vehicleId, createdAt, createdAt);
  db.prepare(`INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, attribution_source, created_at, updated_at) VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?)`)
    .run(`req_${suffix}`, `PPI-${suffix.toUpperCase()}`, customerId, vehicleId, source, createdAt, createdAt);
}

describe('7/30/90 revenue scoreboard', () => {
  it('keeps operational events, payment cohorts, disputes, refunds, sources and app clicks distinct', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-04-01T12:00:00.000Z'));
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      for (const migration of migrations) db.exec(migration);

      seedPaidRequest(db, 'recent', 5, 20_000, 'ppi_google_business_profile', 'disputed', 5_000);
      seedPaidRequest(db, 'month', 20, 30_000, 'ppi_chatgpt_search', 'succeeded');
      seedPaidRequest(db, 'old', 100, 40_000, 'ppi_direct', 'succeeded');

      const recentPayment = 'pay_recent';
      const refundCreated = Math.floor(Date.parse(isoDaysAgo(20)) / 1000);
      const refundSucceeded = Math.floor(Date.parse(isoDaysAgo(1)) / 1000);
      db.prepare(`INSERT INTO provider_refunds (provider_refund_id, payment_id, amount_cents, currency, provider_created, status, last_event_created, last_event_id, created_at, updated_at) VALUES ('re_recent', ?, 5000, 'usd', ?, 'succeeded', ?, 'evt_refund_recent', ?, ?)`)
        .run(recentPayment, refundCreated, refundSucceeded, isoDaysAgo(1), isoDaysAgo(1));
      db.prepare(`INSERT INTO payment_disputes (provider_dispute_id, payment_id, payment_intent, provider_charge_id, amount_cents, currency, provider_created, provider_status, status_event_created, status_event_id, funds_state, created_at, updated_at) VALUES ('du_recent', ?, 'pi_recent', 'ch_recent', 3000, 'usd', ?, 'under_review', ?, 'evt_dispute_status', 'unknown', ?, ?)`)
        .run(recentPayment, refundSucceeded, refundSucceeded, isoDaysAgo(1), isoDaysAgo(1));
      for (const [id, source, days] of [
        ['ev_app_recent', 'ppi_google_business_profile', 1],
        ['ev_app_month', 'ppi_chatgpt_search', 10],
        ['ev_app_old', 'ppi_direct', 100],
      ] as const) {
        db.prepare(`INSERT INTO analytics_events (id, event, source, created_at) VALUES (?, 'app_store_outbound_click', ?, ?)`)
          .run(id, source, isoDaysAgo(days));
      }

      const seven = await loadRevenueWindow(asD1(db), 7);
      expect(seven.operations).toMatchObject({
        saved_requests: 1,
        qualified_requests: 1,
        quoted_requests: 1,
        checkout_starts: 1,
        successful_payments: 1,
        confirmed_bookings: 1,
        completed_inspections: 1,
        successful_refunds: 1,
        successful_refund_cents: 5000,
        dispute_cases_opened: 1,
        disputed_payments: 1,
        app_store_outbound_clicks: 1,
      });
      expect(seven.paymentCohort).toMatchObject({
        paid_payments: 1,
        gross_collected_cents: 20_000,
        refunded_cents: 5_000,
        disputed_excluded_cents: 15_000,
        recognized_net_cents: 0,
        average_paid_ticket_cents: 20_000,
      });
      expect(seven.dataQuality.capturedPaymentsMissingConfirmationEvent).toBe(0);
      expect(seven.sources).toHaveLength(1);
      expect(seven.sources[0]).toMatchObject({
        source: 'ppi_google_business_profile',
        requests: 1,
        paid: 1,
        completed: 1,
        refund_count: 1,
        dispute_cases: 1,
        disputed_requests: 1,
        disputed_excluded_cents: 15_000,
        recognized_net_cents: 0,
        request_to_paid_rate: null,
      });

      const thirty = await loadRevenueWindow(asD1(db), 30);
      expect(thirty.operations.saved_requests).toBe(2);
      expect(thirty.operations.successful_payments).toBe(2);
      expect(thirty.appStoreOutboundClicks).toBe(2);
      expect(thirty.paymentCohort).toMatchObject({
        paid_payments: 2,
        gross_collected_cents: 50_000,
        refunded_cents: 5_000,
        disputed_excluded_cents: 15_000,
        recognized_net_cents: 30_000,
        average_paid_ticket_cents: 25_000,
      });
      expect(thirty.sources.map((row) => row['source'])).toEqual([
        'ppi_chatgpt_search',
        'ppi_google_business_profile',
      ]);

      const ninety = await loadRevenueWindow(asD1(db), 90);
      expect(ninety.operations.saved_requests).toBe(2);
      expect(ninety.paymentCohort.gross_collected_cents).toBe(50_000);
    } finally {
      db.close();
    }
  });

  it('reports a mature zero-payment source cohort as a real zero percent rate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-04-01T12:00:00.000Z'));
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      for (const migration of migrations) db.exec(migration);
      for (let index = 0; index < 20; index += 1) {
        seedUnpaidRequest(db, `zero_${index}`, 'ppi_bing_places');
      }

      const thirty = await loadRevenueWindow(asD1(db), 30);
      expect(thirty.sources).toHaveLength(1);
      expect(thirty.sources[0]).toMatchObject({
        source: 'ppi_bing_places',
        requests: 20,
        paid: 0,
        request_to_paid_rate: 0,
        request_to_completed_rate: 0,
      });
    } finally {
      db.close();
    }
  });
});
