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
import intakeSource from '../../functions/api/ppi/requests.ts?raw';
import adminPage from '../../ppi/admin/index.html?raw';
import leadReviewPage from '../../ppi/admin/lead-review/index.html?raw';
import leadReviewScript from '../../assets/js/ppi-lead-review.js?raw';
import { parseIntake } from '../../functions/lib/validate.ts';
import {
  LEAD_CLASSIFICATIONS,
  isLeadClassification,
  onRequestGet,
  onRequestPost,
} from '../../functions/api/admin/lead-review.ts';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const ORIGIN = 'https://preview.example.com';

function asD1(db: DatabaseSync): D1Database {
  function prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async first<T>(column?: string) {
        const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async all<T>() {
        return { success: true, results: db.prepare(sql).all(...values) as T[], meta: {} };
      },
      async run<T>() {
        const result = db.prepare(sql).run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } } as T;
      },
    };
    return statement;
  }

  return {
    prepare,
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function migrateAndSeed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of [
    initialMigration,
    reportsMigration,
    intakeMigration,
    paymentSlotMigration,
    refundLedgerMigration,
    disputeLedgerMigration,
    agreementImmutabilityMigration,
    quotePaymentIntegrityMigration,
    attributionMigration,
    leadClassificationMigration,
  ]) db.exec(migration);
  db.exec(`
    INSERT INTO customers
      (id, full_name, email, phone, created_at, updated_at)
    VALUES
      ('cus_review', 'PII SENTINEL NAME', 'pii-sentinel@example.com', '7025550199',
       '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    INSERT INTO vehicles
      (id, year, make, model, vin, listing_url, created_at, updated_at)
    VALUES
      ('veh_review', 2019, 'Toyota', 'Camry', '4T1B11HK5KU212345',
       'https://private.example/listing', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    INSERT INTO ppi_requests
      (id, ref, customer_id, vehicle_id, status, loc_street, loc_city, loc_zip,
       seller_name, customer_notes, attribution_source, created_at, updated_at, deleted_at)
    VALUES
      ('req_review', 'PPI-REVIEW', 'cus_review', 'veh_review', 'submitted',
       'PII SENTINEL STREET', 'Las Vegas', '89109', 'PII SENTINEL SELLER',
       'PII SENTINEL NOTE', 'ppi_google_organic',
       '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL),
      ('req_completed', 'PPI-COMPLETED', 'cus_review', 'veh_review', 'completed',
       NULL, 'Henderson', '89052', NULL, NULL, 'ppi_direct',
       '2020-02-01T00:00:00.000Z', '2020-02-02T00:00:00.000Z', NULL),
      ('req_deleted', 'PPI-DELETED', 'cus_review', 'veh_review', 'submitted',
       NULL, 'Las Vegas', '89109', NULL, NULL, 'ppi_unknown',
       '2019-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z',
       '2020-01-01T00:00:00.000Z');
    INSERT INTO status_history
      (id, request_id, from_status, to_status, actor, reason, created_at)
    VALUES
      ('sh_review', 'req_review', NULL, 'submitted', 'customer', 'Submitted',
       '2020-01-01T00:00:00.000Z'),
      ('sh_completed', 'req_completed', 'report_in_progress', 'completed', 'admin:test', 'Completed',
       '2020-02-02T00:00:00.000Z');
    INSERT INTO messages
      (id, request_id, direction, channel, body_text, status, created_at)
    VALUES
      ('msg_review', 'req_review', 'internal', 'portal', 'PII SENTINEL MESSAGE', 'recorded',
       '2020-01-01T00:00:00.000Z');
    INSERT INTO analytics_events (id, event, source, created_at)
    VALUES ('ev_review', 'ppi_request_submitted', 'ppi_google_organic', '2020-01-01T00:00:00.000Z');
  `);
  return db;
}

function envFor(db: DatabaseSync): Record<string, unknown> {
  return {
    DB: asD1(db),
    PPI_ENV: 'preview',
    ADMIN_DEV_KEY: ADMIN_KEY,
    PUBLIC_BASE_URL: ORIGIN,
  };
}

function adminRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callGet(db: DatabaseSync, path = '/api/admin/lead-review'): Promise<{ status: number; body: Record<string, any> }> {
  const response = await onRequestGet({
    request: adminRequest('GET', path),
    env: envFor(db),
  } as unknown as EventContext<any, string, Record<string, unknown>>);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function callPost(db: DatabaseSync, body: unknown, request?: Request): Promise<{ status: number; body: Record<string, any> }> {
  const response = await onRequestPost({
    request: request ?? adminRequest('POST', '/api/admin/lead-review', body),
    env: envFor(db),
  } as unknown as EventContext<any, string, Record<string, unknown>>);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function protectedState(db: DatabaseSync): Record<string, unknown> {
  return {
    request: db.prepare('SELECT status, created_at, updated_at FROM ppi_requests WHERE id = ?').get('req_review'),
    history: db.prepare('SELECT id, request_id, from_status, to_status, actor, reason, created_at FROM status_history ORDER BY id').all(),
    messages: db.prepare('SELECT id, request_id, direction, channel, body_text, status, created_at FROM messages ORDER BY id').all(),
    analytics: db.prepare('SELECT id, event, step, source, created_at FROM analytics_events ORDER BY id').all(),
    financialCounts: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM quotes) AS quotes,
        (SELECT COUNT(*) FROM bookings) AS bookings,
        (SELECT COUNT(*) FROM payments) AS payments
    `).get(),
  };
}

describe('lead classification validation and protected workflow', () => {
  it('accepts only the exact six-value enum', () => {
    expect(LEAD_CLASSIFICATIONS).toEqual([
      'genuine', 'duplicate', 'spam', 'test', 'closed', 'needs_owner_review',
    ]);
    for (const value of LEAD_CLASSIFICATIONS) expect(isLeadClassification(value)).toBe(true);
    for (const value of ['Genuine', 'qualified', 'customer', '', null, 1, {}, []]) {
      expect(isLeadClassification(value)).toBe(false);
    }
  });

  it('keeps crafted public intake classification input out of persistence', () => {
    const parsed = parseIntake({ leadClassification: 'genuine' });
    expect(parsed.payload).not.toHaveProperty('leadClassification');
    expect(intakeSource).not.toMatch(/lead_classification/iu);
  });

  it('returns an oldest-first, privacy-minimized queue with independent filters', async () => {
    const db = migrateAndSeed();
    try {
      const unresolved = await callGet(db);
      expect(unresolved.status).toBe(200);
      expect(unresolved.body.classificationCounts.needs_owner_review).toBe(2);
      expect(unresolved.body.staleNeedsOwnerReview).toBe(1);
      expect(unresolved.body.queue.map((row: Record<string, unknown>) => row.id)).toEqual([
        'req_review', 'req_completed',
      ]);
      expect(unresolved.body.queue[0]).toMatchObject({
        id: 'req_review',
        ref: 'PPI-REVIEW',
        status: 'submitted',
        classification: 'needs_owner_review',
        vehicle: { year: 2019, make: 'Toyota', model: 'Camry' },
        location: { city: 'Las Vegas', zip: '89109' },
        attributionSource: 'ppi_google_organic',
        hasPayment: false,
        hasBooking: false,
        hasRecordedCompletion: false,
      });
      const serialized = JSON.stringify(unresolved.body);
      for (const privateValue of [
        'PII SENTINEL NAME', 'pii-sentinel@example.com', '7025550199',
        '4T1B11HK5KU212345', 'PII SENTINEL STREET', 'PII SENTINEL SELLER',
        'PII SENTINEL NOTE', 'PII SENTINEL MESSAGE', 'private.example',
      ]) expect(serialized).not.toContain(privateValue);

      const statusFiltered = await callGet(
        db,
        '/api/admin/lead-review?classification=all&status=completed&limit=9999',
      );
      expect(statusFiltered.status).toBe(200);
      expect(statusFiltered.body.filters).toMatchObject({ classification: 'all', status: 'completed', limit: 100 });
      expect(statusFiltered.body.queue.map((row: Record<string, unknown>) => row.id)).toEqual(['req_completed']);
      expect(statusFiltered.body.queue[0].hasRecordedCompletion).toBe(true);

      expect((await callGet(db, '/api/admin/lead-review?classification=invalid')).status).toBe(422);
      expect((await callGet(db, '/api/admin/lead-review?status=invalid')).status).toBe(422);
    } finally {
      db.close();
    }
  });

  it('uses CAS + one minimal audit row without lifecycle, contact, analytics, or money side effects', async () => {
    const db = migrateAndSeed();
    try {
      const before = protectedState(db);
      const changed = await callPost(db, {
        requestId: 'req_review',
        expectedClassification: 'needs_owner_review',
        classification: 'genuine',
      });
      expect(changed).toEqual({ status: 200, body: { ok: true, noChange: false, classification: 'genuine' } });
      expect(db.prepare('SELECT lead_classification FROM ppi_requests WHERE id = ?').get('req_review'))
        .toEqual({ lead_classification: 'genuine' });
      expect(protectedState(db)).toEqual(before);

      const audits = db.prepare(`
        SELECT actor, action, entity, entity_id, details_json
        FROM admin_audit_log WHERE action = 'set_lead_classification'
      `).all();
      expect(audits).toEqual([{
        actor: 'admin:dev-key',
        action: 'set_lead_classification',
        entity: 'ppi_request',
        entity_id: 'req_review',
        details_json: JSON.stringify({ from: 'needs_owner_review', to: 'genuine' }),
      }]);
      expect(JSON.stringify(audits)).not.toContain('PII SENTINEL');

      const noChange = await callPost(db, {
        requestId: 'req_review', expectedClassification: 'genuine', classification: 'genuine',
      });
      expect(noChange.body).toMatchObject({ ok: true, noChange: true });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'set_lead_classification'`).get())
        .toEqual({ n: 1 });

      const conflict = await callPost(db, {
        requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 'spam',
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatchObject({ code: 'conflict', currentClassification: 'genuine' });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'set_lead_classification'`).get())
        .toEqual({ n: 1 });

      const corrected = await callPost(db, {
        requestId: 'req_review', expectedClassification: 'genuine', classification: 'duplicate',
      });
      expect(corrected.status).toBe(200);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE action = 'set_lead_classification'`).get())
        .toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  it('allows every exact label to be set and later corrected', async () => {
    const db = migrateAndSeed();
    try {
      let current = 'needs_owner_review';
      for (const classification of LEAD_CLASSIFICATIONS) {
        if (classification === current) continue;
        const result = await callPost(db, {
          requestId: 'req_review',
          expectedClassification: current,
          classification,
        });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ok: true, noChange: false, classification });
        current = classification;
      }
      expect(current).toBe('needs_owner_review');
      expect(db.prepare('SELECT lead_classification FROM ppi_requests WHERE id = ?').get('req_review'))
        .toEqual({ lead_classification: 'needs_owner_review' });
    } finally {
      db.close();
    }
  });

  it('flags excluded labels with completion evidence instead of hiding them', async () => {
    const db = migrateAndSeed();
    try {
      expect((await callPost(db, {
        requestId: 'req_completed',
        expectedClassification: 'needs_owner_review',
        classification: 'test',
      })).status).toBe(200);
      const all = await callGet(db, '/api/admin/lead-review?classification=all');
      expect(all.body.reconciliationWarningCount).toBe(1);
      expect(all.body.queue.find((row: Record<string, unknown>) => row.id === 'req_completed'))
        .toMatchObject({ classification: 'test', hasRecordedCompletion: true, hasReconciliationEvidence: true });
    } finally {
      db.close();
    }
  });

  it('fails closed on missing auth or unsafe origin and rejects non-exact bodies', async () => {
    const db = migrateAndSeed();
    try {
      const noAuth = adminRequest('POST', '/api/admin/lead-review', {
        requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 'genuine',
      }, { authorization: '' });
      expect((await callPost(db, {}, noAuth)).status).toBe(401);

      const noOrigin = adminRequest('POST', '/api/admin/lead-review', {
        requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 'genuine',
      }, { origin: '' });
      expect((await callPost(db, {}, noOrigin)).status).toBe(403);

      const crossOrigin = adminRequest('POST', '/api/admin/lead-review', {
        requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 'genuine',
      }, { origin: 'https://evil.example' });
      expect((await callPost(db, {}, crossOrigin)).status).toBe(403);

      for (const body of [
        { requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 'Genuine' },
        { requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 1 },
        { requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 'genuine', bulk: true },
        [{ requestId: 'req_review', expectedClassification: 'needs_owner_review', classification: 'genuine' }],
      ]) expect((await callPost(db, body)).status).toBe(422);

      expect((await callPost(db, {
        requestId: 'req_deleted',
        expectedClassification: 'needs_owner_review',
        classification: 'genuine',
      })).status).toBe(404);

      expect(db.prepare('SELECT lead_classification FROM ppi_requests WHERE id = ?').get('req_review'))
        .toEqual({ lead_classification: 'needs_owner_review' });
    } finally {
      db.close();
    }
  });

  it('ships a separate noindex owner page without customer data fields or bulk actions', () => {
    expect(adminPage).toContain('<a class="tab-btn" href="/ppi/admin/lead-review/">Lead review</a>');
    expect(leadReviewPage).toContain('<meta name="robots" content="noindex, nofollow"');
    expect(leadReviewPage).toContain('/assets/css/site.css?v=ac-ai-20260908-r1');
    expect(leadReviewPage).toContain('/assets/css/ppi.css?v=ac-ai-20260908-r1');
    expect(leadReviewPage).toContain('/assets/js/ppi-lead-review.js?v=ac-ai-20260908-r1');
    expect(leadReviewPage).not.toContain('ac-ai-20260907-r2');
    expect(leadReviewPage).toContain('Internal label only—this does not contact the customer');
    expect(leadReviewScript).toContain('/api/admin/lead-review');
    expect(leadReviewScript).toContain('expectedClassification');
    expect(leadReviewScript).toContain('"Lead classification for " + String(requestRef)');
    expect(leadReviewScript).toContain('classificationSelect(row.classification, row.ref || row.id)');
    expect(leadReviewScript).toContain('Zero genuine means zero owner-classified genuine requests');
    expect(leadReviewScript).toContain('Unknown / unattributed');
    expect(leadReviewScript).toContain('AutoClarity iOS app');
    expect(leadReviewScript).not.toContain('Direct / unknown');
    expect(leadReviewScript).not.toMatch(/\bbulk\b|customer[_ -]?(name|email|phone)|seller[_ -]?(name|phone)|listing[_ -]?url|\bvin\b/iu);
  });
});
