/// <reference types="vite/client" />

// Telling a paying customer apart from a seeded fixture.
//
// The bias is deliberate and one-directional: a record is real unless it is
// positively identified as a test. Getting that backwards hides a paying
// customer from the only dashboard the owner looks at, which is far worse
// than leaving a fixture visible.

import { describe, expect, it } from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import { initialRecordKind, testRecordReason, isRecordKind, REAL_RECORDS_ONLY } from '../../functions/lib/record-kind.ts';
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

describe('classifying a new record', () => {
  it('treats a real buyer as real', () => {
    for (const person of [
      { ref: 'PPI-260921-VESF', email: 'timothy@gmail.com', fullName: 'Timothy Liaw' },
      { ref: 'PPI-260827-D75X', email: 'logan@yahoo.com', fullName: 'Logan felix' },
      { ref: 'PPI-260101-AAAA', email: 'someone@outlook.com', fullName: "Tess O'Brien" },
    ]) {
      expect(testRecordReason(person), JSON.stringify(person)).toBeNull();
      expect(initialRecordKind(person)).toBe('real');
    }
  });

  it('catches the three ways a test record announces itself', () => {
    expect(testRecordReason({ ref: 'PPI-FIXTURE-CAMRY', email: 'a@gmail.com', fullName: 'Al' }))
      .toContain('PPI-FIXTURE');
    expect(testRecordReason({ ref: 'PPI-260101-AAAA', email: 'buyer@example.com', fullName: 'Al' }))
      .toContain('cannot receive mail');
    expect(testRecordReason({ ref: 'PPI-260101-AAAA', email: 'a@gmail.com', fullName: 'Owner Acceptance Test' }))
      .toContain('TEST');
    // Punctuation and underscores are word separators, not part of the word.
    expect(testRecordReason({ ref: 'PPI-260101-AAAA', email: 'a@gmail.com', fullName: 'Test Customer (Fixture)' }))
      .toContain('TEST');
    expect(testRecordReason({ ref: 'PPI-260101-AAAA', email: 'a@gmail.com', fullName: 'INTERNAL_SMOKE_TEST - DELETED' }))
      .toBeTruthy();
    expect(testRecordReason({ ref: 'PPI-260101-AAAA', email: 'a@gmail.com', fullName: 'Preview Tester' }))
      .toContain('TESTER');
  });

  it('never classifies on a hunch — only on a stated marker', () => {
    // A real customer with an unusual name or a free-mail address stays real.
    for (const person of [
      { ref: 'PPI-260101-AAAA', email: 'x@proton.me', fullName: 'Protestina Smith' },
      { ref: 'PPI-260101-AAAA', email: 'dev@mycompany.io', fullName: 'Dev Patel' },
      // Real surnames that contain a marker as a substring.
      { ref: 'PPI-260101-AAAA', email: 'a@gmail.com', fullName: 'Marco Testa' },
      { ref: 'PPI-260101-AAAA', email: 'a@gmail.com', fullName: 'Giulia Testino' },
      { ref: 'PPI-260101-AAAA', email: 'a@gmail.com', fullName: 'Contessa Delgado' },
    ]) {
      expect(testRecordReason(person), JSON.stringify(person)).toBeNull();
    }
  });

  it('gives a reason a human can read, never a bare boolean', () => {
    const why = testRecordReason({ ref: 'PPI-260101-AAAA', email: 'x@example.invalid', fullName: 'Al' });
    expect(why).toBeTruthy();
    expect(why!.length).toBeGreaterThan(20);
  });

  it('validates the stored value', () => {
    expect(isRecordKind('real')).toBe(true);
    expect(isRecordKind('test')).toBe(true);
    expect(isRecordKind('TEST')).toBe(false);
    expect(isRecordKind(null)).toBe(false);
  });
});

describe('migration 0016 on a production-shaped database', () => {
  function migrated(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    for (const m of [
      initialMigration, reportsMigration, intakeMigration, paymentSlotMigration,
      refundLedgerMigration, disputeLedgerMigration, agreementImmutabilityMigration,
      quotePaymentIntegrityMigration, attributionMigration, leadClassificationMigration,
      reportFulfillmentMigration, agreementAcceptanceMigration,
      bookingProposalMigration, openAvailabilityMigration,
    ]) db.exec(m);
    return db;
  }

  function seed(db: DatabaseSync): void {
    const t = '2026-09-01T00:00:00.000Z';
    const people: Array<[string, string, string, string]> = [
      ['cus_real1', 'Timothy Liaw', 'timothy@gmail.com', 'PPI-260921-VESF'],
      ['cus_real2', 'Logan felix', 'logan@yahoo.com', 'PPI-260827-D75X'],
      ['cus_fix', 'Test Customer (Fixture)', 'fixture@example.com', 'PPI-FIXTURE-CAMRY'],
      ['cus_smoke', 'INTERNAL_SMOKE_TEST - DELETED', 'smoke@example.invalid', 'PPI-INTERNAL-SMOKE-1'],
      ['cus_owner', 'Owner Acceptance Test', 'owner@gmail.com', 'PPI-260725-MQZ9'],
      ['cus_verif', 'AutoClarity Production Verification', 'sup@getautoclarity.com', 'PPI-260908-S7BA'],
    ];
    db.exec(`INSERT INTO vehicles (id, make, model, created_at, updated_at) VALUES ('veh_1','Toyota','Corolla','${t}','${t}');`);
    for (const [cid, name, email, ref] of people) {
      db.exec(`
        INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
        VALUES ('${cid}', '${name.replaceAll("'", "''")}', '${email}', '7025550100', '${t}', '${t}');
        INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
        VALUES ('req_${cid}', '${ref}', '${cid}', 'veh_1', 'submitted', '${t}', '${t}');
      `);
    }
  }

  it('defaults every existing row to real before deciding anything', () => {
    const db = migrated();
    try {
      seed(db);
      // Column added with a real default: no row is hidden by the ALTER itself.
      db.exec(recordKindMigration.slice(0, recordKindMigration.indexOf('UPDATE ppi_requests')));
      const kinds = db.prepare(`SELECT DISTINCT record_kind FROM ppi_requests`).all() as Array<{ record_kind: string }>;
      expect(kinds).toEqual([{ record_kind: 'real' }]);
    } finally { db.close(); }
  });

  it('files exactly the fixtures and rehearsals as tests, and nobody else', () => {
    const db = migrated();
    try {
      seed(db);
      db.exec(recordKindMigration);
      const rows = db.prepare(`SELECT ref, record_kind FROM ppi_requests ORDER BY ref`).all() as Array<{ ref: string; record_kind: string }>;
      const byRef = Object.fromEntries(rows.map((r) => [r.ref, r.record_kind]));
      expect(byRef['PPI-260921-VESF']).toBe('real');   // Timothy
      expect(byRef['PPI-260827-D75X']).toBe('real');   // the AMG
      expect(byRef['PPI-FIXTURE-CAMRY']).toBe('test');
      expect(byRef['PPI-INTERNAL-SMOKE-1']).toBe('test');
      expect(byRef['PPI-260725-MQZ9']).toBe('test');
      expect(byRef['PPI-260908-S7BA']).toBe('test');
      expect(rows.filter((r) => r.record_kind === 'real')).toHaveLength(2);
    } finally { db.close(); }
  });

  it('keeps every test record — nothing is deleted', () => {
    const db = migrated();
    try {
      seed(db);
      const before = db.prepare(`SELECT COUNT(*) AS n FROM ppi_requests`).get();
      db.exec(recordKindMigration);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ppi_requests`).get()).toEqual(before);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ppi_requests WHERE deleted_at IS NOT NULL`).get())
        .toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('classifies soft-deleted rows too, instead of leaving them labelled real', () => {
    // A smoke test that was soft-deleted kept the 'real' default when the
    // backfill only looked at live rows — a row saying "real business" that
    // nobody sees until they audit the table.
    const db = migrated();
    try {
      const t = '2026-09-01T00:00:00.000Z';
      db.exec(`
        INSERT INTO vehicles (id, make, model, created_at, updated_at) VALUES ('veh_d','T','C','${t}','${t}');
        INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
        VALUES ('cus_d', 'INTERNAL_SMOKE_TEST - DELETED', 'smoke@example.invalid', '7025550100', '${t}', '${t}');
        INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at, deleted_at)
        VALUES ('req_d', 'PPI-INTERNAL-SMOKE-1', 'cus_d', 'veh_d', 'submitted', '${t}', '${t}', '${t}');
      `);
      db.exec(recordKindMigration);
      expect(db.prepare(`SELECT record_kind FROM ppi_requests WHERE id = 'req_d'`).get())
        .toEqual({ record_kind: 'test' });
    } finally { db.close(); }
  });

  it('refuses a value that is neither real nor test', () => {
    const db = migrated();
    try {
      seed(db);
      db.exec(recordKindMigration);
      expect(() => db.exec(`UPDATE ppi_requests SET record_kind = 'maybe' WHERE ref = 'PPI-260921-VESF'`))
        .toThrow();
    } finally { db.close(); }
  });

  it('the SQL backfill and the TypeScript rule agree on every name', () => {
    const db = migrated();
    try {
      const t = '2026-09-01T00:00:00.000Z';
      db.exec(`INSERT INTO vehicles (id, make, model, created_at, updated_at) VALUES ('veh_x','T','C','${t}','${t}');`);
      const names = [
        'Timothy Liaw', 'Logan felix', 'Marco Testa', 'Giulia Testino', 'Protestina Smith',
        'Owner Acceptance Test', 'Test Customer (Fixture)', 'INTERNAL_SMOKE_TEST - DELETED',
        'Preview Tester', 'AutoClarity Production Verification', 'Hosted Deploy Verifier',
        'Sandbox Buyer', 'Dev Patel', 'Anne-Marie O Brien',
      ];
      names.forEach((name, i) => {
        db.exec(`
          INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
          VALUES ('c${i}', '${name.replaceAll("'", "''")}', 'p${i}@gmail.com', '7025550100', '${t}', '${t}');
          INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
          VALUES ('r${i}', 'PPI-2601-${String(i).padStart(4, '0')}', 'c${i}', 'veh_x', 'submitted', '${t}', '${t}');
        `);
      });
      db.exec(recordKindMigration);
      const rows = db.prepare(`SELECT ref, record_kind, (SELECT full_name FROM customers WHERE id = customer_id) AS nm FROM ppi_requests`).all() as Array<{ record_kind: string; nm: string }>;
      for (const row of rows) {
        const fromTs = initialRecordKind({ ref: 'PPI-2601-0000', email: 'p@gmail.com', fullName: row.nm });
        expect(row.record_kind, `SQL and TS disagree on "${row.nm}"`).toBe(fromTs);
      }
    } finally { db.close(); }
  });

  it('the business predicate selects only the real records', () => {
    const db = migrated();
    try {
      seed(db);
      db.exec(recordKindMigration);
      const real = db.prepare(`SELECT ref FROM ppi_requests WHERE ${REAL_RECORDS_ONLY} ORDER BY ref`).all() as Array<{ ref: string }>;
      expect(real.map((r) => r.ref)).toEqual(['PPI-260827-D75X', 'PPI-260921-VESF']);
    } finally { db.close(); }
  });
});
