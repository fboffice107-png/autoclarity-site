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
import agreementVersionMigration from '../../migrations/0007_agreement_version_immutability.sql?raw';
import quotePaymentMigration from '../../migrations/0008_quote_payment_integrity.sql?raw';
import attributionMigration from '../../migrations/0009_request_attribution.sql?raw';
import classificationMigration from '../../migrations/0010_lead_classification.sql?raw';
import reportIntegrityMigration from '../../migrations/0011_report_fulfillment_integrity.sql?raw';
import acceptanceMigration from '../../migrations/0012_agreement_acceptance_integrity.sql?raw';

const timestamp = '2030-01-01T00:00:00.000Z';
const later = '2030-02-01T00:00:00.000Z';

function quote(db: DatabaseSync, id: string, requestId = 'req_a', version = 1, commit = true): void {
  db.prepare(`INSERT INTO quotes
    (id, request_id, version, status, tier, currency, subtotal_cents, total_cents,
     expires_at, approved_by, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', 'standard', 'usd', 10000, 10000, ?, 'owner', ?, ?)`)
    .run(id, requestId, version, '2031-01-01T00:00:00.000Z', timestamp, timestamp);
  db.prepare(`INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents)
    VALUES (?, ?, 'base', 'Inspection', 10000)`).run(`line_${id}`, id);
  if (commit) db.prepare(`UPDATE quotes SET status = 'sent' WHERE id = ?`).run(id);
}

function acceptance(
  db: DatabaseSync,
  id: string | null,
  quoteId: string | null = 'quote_a',
  requestId = 'req_a',
  documentId = 'agreement_v1',
  accepted = 1,
): void {
  db.prepare(`INSERT INTO agreement_acceptances
    (id, request_id, quote_id, agreement_version_id, typed_name, accepted, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, 'Fixture Buyer', ?, '198.51.100.17', 'Fixture Browser', ?)`)
    .run(id, requestId, quoteId, documentId, accepted, timestamp);
}

function fixture(applyIntegrity = true): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF;');
  for (const migration of [initialMigration, reportsMigration, intakeMigration, paymentSlotMigration,
    refundLedgerMigration, disputeLedgerMigration, agreementVersionMigration, quotePaymentMigration,
    attributionMigration, classificationMigration, reportIntegrityMigration]) db.exec(migration);
  db.prepare(`INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES ('customer', 'Fixture Buyer', 'fixture@example.com', '555-0100', ?, ?)`).run(timestamp, timestamp);
  db.prepare(`INSERT INTO vehicles (id, make, model, created_at, updated_at)
    VALUES ('vehicle', 'Test', 'Vehicle', ?, ?)`).run(timestamp, timestamp);
  for (const id of ['req_a', 'req_b']) {
    db.prepare(`INSERT INTO ppi_requests
      (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
      VALUES (?, ?, 'customer', 'vehicle', 'awaiting_agreement', ?, ?)`)
      .run(id, id.toUpperCase(), timestamp, timestamp);
  }
  db.prepare(`INSERT INTO agreement_versions
    (id, doc_key, version, title, body_md, sha256, created_at)
    VALUES ('agreement_v1', 'terms', 1, 'Fixture Terms', 'Original body', 'original-hash', ?)`)
    .run(timestamp);
  quote(db, 'quote_a');
  quote(db, 'quote_b', 'req_b');
  if (applyIntegrity) db.exec(acceptanceMigration);
  return db;
}

describe('agreement acceptance integrity migration', () => {
  it('reproduces pre-migration REPLACE bypasses without enabling recursive triggers', () => {
    const db = fixture(false);
    try {
      acceptance(db, 'acceptance_a');
      db.exec(`INSERT OR REPLACE INTO agreement_versions
        (id, doc_key, version, title, body_md, sha256, created_at)
        VALUES ('agreement_v1', 'terms', 1, 'Rewritten Terms', 'Rewritten body', 'changed-hash', '${later}')`);
      db.exec(`INSERT OR REPLACE INTO quotes
        (id, request_id, version, status, tier, subtotal_cents, total_cents,
         expires_at, approved_by, created_at, updated_at)
        VALUES ('quote_a', 'req_a', 1, 'draft', 'standard', 20000, 20000,
                '${later}', 'owner', '${later}', '${later}')`);
      db.exec(`INSERT OR REPLACE INTO agreement_acceptances
        (id, request_id, quote_id, agreement_version_id, typed_name, accepted, created_at)
        VALUES ('acceptance_a', 'req_a', 'quote_a', 'agreement_v1', 'Rewritten Person', 0, '${later}')`);
      expect(db.prepare(`SELECT body_md FROM agreement_versions WHERE id = 'agreement_v1'`).get())
        .toEqual({ body_md: 'Rewritten body' });
      expect(db.prepare(`SELECT total_cents FROM quotes WHERE id = 'quote_a'`).get())
        .toEqual({ total_cents: 20000 });
      expect(db.prepare(`SELECT typed_name FROM agreement_acceptances WHERE id = 'acceptance_a'`).get())
        .toEqual({ typed_name: 'Rewritten Person' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('preserves every existing acceptance including null and legacy draft quote evidence', () => {
    const db = fixture(false);
    try {
      quote(db, 'legacy_draft', 'req_a', 2, false);
      for (let index = 0; index < 45; index += 1) {
        acceptance(db, `legacy_${index}`, index % 3 === 0 ? null : index % 3 === 1 ? 'quote_a' : 'legacy_draft');
      }
      const before = db.prepare('SELECT * FROM agreement_acceptances ORDER BY id').all();
      const quotesBefore = db.prepare('SELECT * FROM quotes ORDER BY id').all();
      db.exec(acceptanceMigration);
      expect(db.prepare('SELECT * FROM agreement_acceptances ORDER BY id').all()).toEqual(before);
      expect(db.prepare('SELECT * FROM quotes ORDER BY id').all()).toEqual(quotesBefore);
      expect(before).toHaveLength(45);
      expect(() => db.exec(`UPDATE quotes SET total_cents = 20000 WHERE id = 'legacy_draft'`))
        .toThrow(/accepted quote identity is immutable/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { db.close(); }
  });

  it.each([
    ['id', 'different-id'], ['request_id', 'req_b'], ['quote_id', 'quote_b'],
    ['agreement_version_id', 'different-document'], ['typed_name', 'Another Person'],
    ['accepted', 0], ['ip', '203.0.113.88'], ['user_agent', 'Rewritten Browser'], ['created_at', later],
  ])('prevents changing accepted %s evidence', (column, value) => {
    const db = fixture();
    try {
      acceptance(db, 'acceptance_a');
      const before = db.prepare('SELECT * FROM agreement_acceptances').get();
      expect(() => db.prepare(`UPDATE agreement_acceptances SET ${column} = ? WHERE id = 'acceptance_a'`).run(value))
        .toThrow(/agreement acceptances are immutable/);
      expect(db.prepare('SELECT * FROM agreement_acceptances').get()).toEqual(before);
    } finally { db.close(); }
  });

  it('prevents deletion, UPSERT and REPLACE of an acceptance with recursive triggers disabled', () => {
    const db = fixture();
    try {
      acceptance(db, 'acceptance_a');
      const before = db.prepare('SELECT * FROM agreement_acceptances').get();
      expect(db.prepare('PRAGMA recursive_triggers').get()).toEqual({ recursive_triggers: 0 });
      expect(() => db.exec(`DELETE FROM agreement_acceptances WHERE id = 'acceptance_a'`))
        .toThrow(/agreement acceptances are immutable/);
      for (const prefix of ['INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE']) {
        expect(() => db.exec(`${prefix} INTO agreement_acceptances
          (id, request_id, quote_id, agreement_version_id, typed_name, accepted, created_at)
          VALUES ('acceptance_a', 'req_a', 'quote_a', 'agreement_v1', 'Rewritten', 0, '${later}')`))
          .toThrow(/agreement acceptances are immutable/);
      }
      expect(() => db.exec(`INSERT INTO agreement_acceptances
        (id, request_id, quote_id, agreement_version_id, typed_name, created_at)
        VALUES ('acceptance_a', 'req_a', 'quote_a', 'agreement_v1', 'Rewritten', '${later}')
        ON CONFLICT(id) DO UPDATE SET typed_name = excluded.typed_name`))
        .toThrow(/agreement acceptances are immutable/);
      expect(db.prepare('SELECT * FROM agreement_acceptances').get()).toEqual(before);
    } finally { db.close(); }
  });

  it('requires same-request committed quote and nonempty acceptance identity only for future rows', () => {
    const db = fixture();
    try {
      quote(db, 'draft', 'req_a', 2, false);
      for (const quoteId of [null, 'missing', 'quote_b', 'draft']) {
        expect(() => acceptance(db, `invalid_${quoteId}`, quoteId))
          .toThrow(/same-request committed quote/);
      }
      for (const id of [null, '', ' ']) {
        expect(() => acceptance(db, id)).toThrow(/acceptance id is required/);
      }
      expect(db.prepare('SELECT * FROM agreement_acceptances').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('appends new quote/document acceptance without changing the prior acceptance or rejecting decline evidence', () => {
    const db = fixture();
    try {
      acceptance(db, 'acceptance_a');
      const original = db.prepare(`SELECT * FROM agreement_acceptances WHERE id = 'acceptance_a'`).get();
      db.exec(`UPDATE quotes SET status = 'superseded' WHERE id = 'quote_a'`);
      quote(db, 'quote_a_v2', 'req_a', 2);
      db.exec(`INSERT INTO agreement_versions
        (id, doc_key, version, title, body_md, sha256, created_at)
        VALUES ('agreement_v2', 'terms', 2, 'Fixture Terms', 'New body', 'new-hash', '${later}')`);
      acceptance(db, 'decline_v2', 'quote_a_v2', 'req_a', 'agreement_v2', 0);
      acceptance(db, 'acceptance_v2', 'quote_a_v2', 'req_a', 'agreement_v2');
      expect(db.prepare(`SELECT * FROM agreement_acceptances WHERE id = 'acceptance_a'`).get()).toEqual(original);
      expect(db.prepare('SELECT COUNT(*) AS count FROM agreement_acceptances').get()).toEqual({ count: 3 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('prevents accepted document replacement by id or document/version collision', () => {
    const db = fixture();
    try {
      acceptance(db, 'acceptance_a');
      const before = db.prepare('SELECT * FROM agreement_versions').all();
      for (const [id, key, version, title, body, hash] of [
        ['agreement_v1', 'terms', 1, 'Fixture Terms', 'Rewritten', 'other-hash'],
        ['changed-id', 'terms', 1, 'Fixture Terms', 'Original body', 'original-hash'],
        ['agreement_v1', 'different-terms', 2, 'Fixture Terms', 'Original body', 'original-hash'],
        ['agreement_v1', 'terms', 1, 'Changed Title', 'Original body', 'original-hash'],
      ]) {
        expect(() => db.prepare(`INSERT OR REPLACE INTO agreement_versions
          (id, doc_key, version, title, body_md, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, key, version, title, body, hash, later)).toThrow(/agreement versions are immutable/);
      }
      expect(db.prepare('SELECT * FROM agreement_versions').all()).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('retains original document timestamp for identical concurrent source-seeding retries', () => {
    const db = fixture();
    try {
      const before = db.prepare('SELECT * FROM agreement_versions').all();
      for (const prefix of ['INSERT', 'INSERT OR IGNORE', 'INSERT OR REPLACE']) {
        expect(() => db.exec(`${prefix} INTO agreement_versions
          (id, doc_key, version, title, body_md, sha256, created_at)
          VALUES ('agreement_v1', 'terms', 1, 'Fixture Terms', 'Original body', 'original-hash', '${later}')`))
          .not.toThrow();
      }
      expect(db.prepare('SELECT * FROM agreement_versions').all()).toEqual(before);
    } finally { db.close(); }
  });

  it('prevents replacing the quote underneath acceptance by id or request/version collision', () => {
    const db = fixture();
    try {
      acceptance(db, 'acceptance_a');
      const before = db.prepare('SELECT * FROM quotes ORDER BY id').all();
      for (const id of ['quote_a', 'replacement_quote']) {
        expect(() => db.prepare(`INSERT OR REPLACE INTO quotes
          (id, request_id, version, status, tier, subtotal_cents, total_cents,
           expires_at, approved_by, created_at, updated_at)
          VALUES (?, 'req_a', 1, 'draft', 'standard', 20000, 20000, ?, 'owner', ?, ?)`)
          .run(id, later, later, later)).toThrow(/accepted quote identity is immutable/);
      }
      expect(db.prepare('SELECT * FROM quotes ORDER BY id').all()).toEqual(before);
    } finally { db.close(); }
  });
});
