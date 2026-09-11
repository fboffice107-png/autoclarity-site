/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import initialMigration from '../../migrations/0001_init.sql?raw';
import reportsMigration from '../../migrations/0002_inspection_reports.sql?raw';
import {
  completeWithPublishedReport,
  loadPublishedReportVersion,
} from '../../functions/lib/published-report.ts';
import { loadPortalView } from '../../functions/lib/portal.ts';
import { DEFAULT_CONFIG } from '../../functions/lib/config.ts';
import { sha256Hex } from '../../functions/lib/util.ts';
import type { Env } from '../../functions/lib/types.ts';
import portalScript from '../../assets/js/ppi-portal.js?raw';

interface SqliteStatementLike {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
}

function sqliteD1(sqlite: SqliteLike): D1Database {
  const statement = (sql: string, bound: unknown[] = []): D1PreparedStatement => ({
    bind(...values: unknown[]) {
      return statement(sql, values);
    },
    async first<T = unknown>(columnName?: string): Promise<T | null> {
      const value = sqlite.prepare(sql).get(...bound);
      if (value === undefined) return null;
      if (columnName) return ((value as Record<string, unknown>)[columnName] as T) ?? null;
      return value as T;
    },
    async run<T = Record<string, unknown>>() {
      const result = sqlite.prepare(sql).run(...bound);
      return {
        success: true,
        results: [] as T[],
        meta: { changes: Number(result.changes) },
      } as D1Result<T>;
    },
    async all<T = Record<string, unknown>>() {
      return {
        success: true,
        results: sqlite.prepare(sql).all(...bound) as T[],
        meta: {},
      } as D1Result<T>;
    },
  }) as D1PreparedStatement;

  const db = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results: D1Result[] = [];
        for (const prepared of statements) results.push(await prepared.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return db as unknown as D1Database;
}

function seedDatabase(): { sqlite: InstanceType<typeof DatabaseSync>; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(initialMigration);
  sqlite.exec(reportsMigration);
  // Reader-defense fixtures intentionally model potentially corrupt legacy
  // rows predating the new insert guards. Full 0011 enforcement is exercised
  // separately in report-workflow.test.ts and the HTTP fulfillment tests.
  sqlite.exec(`ALTER TABLE report_versions ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE inspection_reports ADD COLUMN amendment_reason TEXT;
    CREATE TABLE report_deliveries(id TEXT,version_id TEXT,request_id TEXT,report_id TEXT,customer_id TEXT,notification_message_id TEXT,notification_key TEXT);
    CREATE VIEW report_notification_evidence AS SELECT d.id AS delivery_id,d.version_id,d.request_id,m.status,1 AS is_current FROM report_deliveries d JOIN messages m ON m.id=d.notification_message_id;`);
  sqlite.exec(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES
      ('cus_report_a', 'Report Customer A', 'report-a@example.com', '702-555-0101', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
      ('cus_report_b', 'Report Customer B', 'report-b@example.com', '702-555-0102', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO vehicles (id, year, make, model, created_at, updated_at)
    VALUES
      ('veh_report_a', 2020, 'Test', 'Vehicle A', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
      ('veh_report_b', 2021, 'Test', 'Vehicle B', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO ppi_requests
      (id, ref, customer_id, vehicle_id, status, loc_city, loc_state, created_at, updated_at)
    VALUES
      ('req_report_a', 'PPI-REPORT-A', 'cus_report_a', 'veh_report_a', 'report_in_progress', 'Las Vegas', 'NV', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
      ('req_report_b', 'PPI-REPORT-B', 'cus_report_b', 'veh_report_b', 'report_in_progress', 'Henderson', 'NV', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
  `);
  return { sqlite, db: sqliteD1(sqlite) };
}

interface ReportFixtureOptions {
  requestId?: 'req_report_a' | 'req_report_b';
  reportId?: string;
  versionId?: string;
  state?: 'in_progress' | 'published';
  versionStatus?: 'published' | 'superseded';
  payload?: Record<string, unknown>;
  digest?: string;
  pointAtVersion?: boolean;
  version?: number;
  kind?: 'original' | 'amendment';
}

function validReportPayload(summary = 'Selected customer-safe snapshot'): Record<string, unknown> {
  return {
    schema: 'autoclarity.ppi.report',
    schemaVersion: 1,
    inspector: 'Test Inspector',
    overall: {
      score: 8.4,
      verdict: 'proceed',
      verdictLabel: 'Publisher-provided label is not authoritative',
      executiveSummary: summary,
      positiveFindings: 'No immediate safety concern observed.',
    },
    sections: [{
      title: 'Road test and controls',
      performed: 'performed',
      summary: 'Road test completed where permitted.',
      internalInspectorNotes: 'never expose section-only notes',
      items: [{
        label: 'Brake operation',
        result: 'pass',
        note: 'Pedal feel was consistent during the test.',
        priority: 'informational',
        photos: [{ caption: 'Brake-fluid reservoir', objectKey: 'private/reports/secret.jpg' }],
        inspectorNotes: 'never expose item-only notes',
      }],
    }],
    limitations: {
      standard: ['Visual and operational inspection only; components were not disassembled.'],
    },
    internalInspectorNotes: 'never expose top-level notes',
    pdfObjectKey: 'private/reports/report.pdf',
  };
}

async function insertReportFixture(
  db: D1Database,
  options: ReportFixtureOptions = {},
): Promise<{ reportId: string; versionId: string; payload: Record<string, unknown>; payloadJson: string }> {
  const requestId = options.requestId ?? 'req_report_a';
  const suffix = requestId.endsWith('_b') ? 'b' : 'a';
  const reportId = options.reportId ?? `rpt_report_${suffix}`;
  const versionId = options.versionId ?? `rv_report_${suffix}_1`;
  const payload = options.payload ?? validReportPayload(`Snapshot ${versionId}`);
  const payloadJson = JSON.stringify(payload);
  const digest = options.digest ?? await sha256Hex(payloadJson);
  const state = options.state ?? 'published';
  const versionStatus = options.versionStatus ?? 'published';
  const version = options.version ?? 1;
  const kind = options.kind ?? 'original';
  const customerId = `cus_report_${suffix}`;
  const vehicleId = `veh_report_${suffix}`;

  await db
    .prepare(
      `INSERT INTO inspection_reports
         (id, request_id, customer_id, vehicle_id, state, started_by, published_version_id, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'test:inspector', ?, '2030-01-02T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z')`,
    )
    .bind(reportId, requestId, customerId, vehicleId, state, options.pointAtVersion === false ? null : versionId)
    .run();
  await db
    .prepare(
      `INSERT INTO report_versions
         (id, report_id, request_id, version, status, kind, payload_json, payload_sha256, published_by, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test:inspector', '2030-01-02T00:00:00.000Z')`,
    )
    .bind(versionId, reportId, requestId, version, versionStatus, kind, payloadJson, digest)
    .run();
  return { reportId, versionId, payload, payloadJson };
}

describe('published report authority', () => {
  it('reads the exact legacy string limitation without rewriting the immutable body or digest', async () => {
    const {sqlite,db}=seedDatabase();
    try{
      const payload={...validReportPayload(),limitations:{standard:'Exact legacy limitation paragraph.'}};
      const fixture=await insertReportFixture(db,{payload});
      const report=await loadPublishedReportVersion(db,'req_report_a');
      expect(report?.payload.limitations.standard).toEqual(['Exact legacy limitation paragraph.']);
      sqlite.exec("UPDATE inspection_reports SET state='in_progress',amendment_reason='Owner is preparing a reviewed amendment'");
      expect((await loadPublishedReportVersion(db,'req_report_a'))?.versionId).toBe(fixture.versionId);
      expect(sqlite.prepare('SELECT payload_json,payload_sha256 FROM report_versions WHERE id=?').get(fixture.versionId))
        .toEqual(expect.objectContaining({payload_json:fixture.payloadJson,payload_sha256:await sha256Hex(fixture.payloadJson)}));
    }finally{sqlite.close();}
  });
  it('loads the report pointer, not a newer loose version, and the portal exposes that exact snapshot only', async () => {
    const { sqlite, db } = seedDatabase();
    try {
      const selected = await insertReportFixture(db);
      const decoyPayload = { schema: 'autoclarity.ppi.report', overall: { executiveSummary: 'Loose newer decoy' } };
      const decoyJson = JSON.stringify(decoyPayload);
      await db
        .prepare(
          `INSERT INTO report_versions
             (id, report_id, request_id, version, status, kind, payload_json, payload_sha256, published_by, published_at)
           VALUES ('rv_report_a_2', ?, 'req_report_a', 2, 'published', 'amendment', ?, ?, 'test:inspector', '2030-01-03T00:00:00.000Z')`,
        )
        .bind(selected.reportId, decoyJson, await sha256Hex(decoyJson))
        .run();

      const loaded = await loadPublishedReportVersion(db, 'req_report_a');
      expect(loaded).toMatchObject({
        reportId: selected.reportId,
        versionId: selected.versionId,
        version: 1,
        payload: {
          schema: 'autoclarity.ppi.report',
          schemaVersion: 1,
          inspector: 'Test Inspector',
          overall: {
            score: 8.4,
            verdict: 'proceed',
            verdictLabel: 'Proceed',
            executiveSummary: `Snapshot ${selected.versionId}`,
          },
        },
      });
      expect(loaded?.payload.sections[0]?.items[0]?.photos).toEqual([{ caption: 'Brake-fluid reservoir' }]);
      expect(JSON.stringify(loaded?.payload)).not.toMatch(/internalInspectorNotes|inspectorNotes|objectKey|pdfObjectKey|secret\.jpg/iu);

      const portal = await loadPortalView(
        { DB: db, PPI_ENV: 'preview', PPI_MODE: 'request' } as Env,
        DEFAULT_CONFIG,
        'req_report_a',
      );
      expect(portal?.report).toMatchObject({
        reportId: selected.reportId,
        versionId: selected.versionId,
        version: 1,
        amended: false,
      });
      expect(JSON.stringify(portal?.report?.payload)).not.toMatch(/internalInspectorNotes|inspectorNotes|objectKey|pdfObjectKey|secret\.jpg/iu);
      expect(JSON.stringify(portal?.report)).not.toContain('Loose newer decoy');

      const otherPortal = await loadPortalView(
        { DB: db, PPI_ENV: 'preview', PPI_MODE: 'request' } as Env,
        DEFAULT_CONFIG,
        'req_report_b',
      );
      expect(otherPortal?.report).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('fails closed for draft, superseded, cross-request, and digest-mismatched pointers', async () => {
    const cases: Array<{
      name: string;
      prepare: (db: D1Database) => Promise<void>;
    }> = [
      {
        name: 'draft report',
        prepare: async (db) => { await insertReportFixture(db, { state: 'in_progress' }); },
      },
      {
        name: 'superseded version',
        prepare: async (db) => { await insertReportFixture(db, { versionStatus: 'superseded' }); },
      },
      {
        name: 'digest mismatch',
        prepare: async (db) => { await insertReportFixture(db, { digest: '0'.repeat(64) }); },
      },
      {
        name: 'cross-request pointer',
        prepare: async (db) => {
          const a = await insertReportFixture(db);
          const b = await insertReportFixture(db, { requestId: 'req_report_b' });
          await db.prepare(`UPDATE inspection_reports SET published_version_id = ? WHERE id = ?`).bind(b.versionId, a.reportId).run();
        },
      },
    ];

    for (const testCase of cases) {
      const { sqlite, db } = seedDatabase();
      try {
        await testCase.prepare(db);
        expect(await loadPublishedReportVersion(db, 'req_report_a'), testCase.name).toBeNull();
        const completion = await completeWithPublishedReport(db, 'req_report_a', 'admin:test');
        expect(completion, testCase.name).toEqual({ ok: false, code: 'report_required' });
        const request = await db.prepare(`SELECT status FROM ppi_requests WHERE id = 'req_report_a'`).first<{ status: string }>();
        expect(request?.status, testCase.name).toBe('report_in_progress');
      } finally {
        sqlite.close();
      }
    }
  });

  it('fails closed for unsupported, incomplete, mistyped, over-count, and oversized report payloads', async () => {
    const valid = validReportPayload();
    const invalidPayloads: Array<[string, Record<string, unknown>]> = [
      ['unsupported schema version', { ...valid, schemaVersion: 2 }],
      ['missing required sections', { ...valid, sections: [] }],
      ['mistyped score', {
        ...valid,
        overall: { ...(valid.overall as Record<string, unknown>), score: '8.4' },
      }],
      ['too many sections', {
        ...valid,
        sections: Array.from({ length: 51 }, (_, index) => ({
          title: `Section ${index}`,
          performed: 'performed',
          items: [],
        })),
      }],
      ['missing limitations', { ...valid, limitations: { standard: [] } }],
      ['oversized raw snapshot', { ...valid, internalBlob: 'x'.repeat(1_048_577) }],
    ];

    for (const [name, payload] of invalidPayloads) {
      const { sqlite, db } = seedDatabase();
      try {
        await insertReportFixture(db, { payload });
        expect(await loadPublishedReportVersion(db, 'req_report_a'), name).toBeNull();
        expect(await completeWithPublishedReport(db, 'req_report_a', 'admin:test'), name)
          .toEqual({ ok: false, code: 'report_required' });
      } finally {
        sqlite.close();
      }
    }
  });

  it('completes once and records the exact version as transition authority', async () => {
    const { sqlite, db } = seedDatabase();
    try {
      const selected = await insertReportFixture(db);
      const completed = await completeWithPublishedReport(db, 'req_report_a', 'admin:test');
      expect(completed).toMatchObject({ ok: true, report: { versionId: selected.versionId } });

      const request = await db.prepare(`SELECT status FROM ppi_requests WHERE id = 'req_report_a'`).first<{ status: string }>();
      expect(request?.status).toBe('completed');
      const history = await db
        .prepare(`SELECT from_status, to_status, actor, related_id FROM status_history WHERE request_id = 'req_report_a'`)
        .all<{ from_status: string; to_status: string; actor: string; related_id: string }>();
      expect(history.results).toEqual([
        {
          from_status: 'report_in_progress',
          to_status: 'completed',
          actor: 'admin:test',
          related_id: selected.versionId,
        },
      ]);

      expect(await completeWithPublishedReport(db, 'req_report_a', 'admin:test')).toEqual({ ok: false, code: 'conflict' });
      const historyCount = await db
        .prepare(`SELECT COUNT(*) AS n FROM status_history WHERE request_id = 'req_report_a' AND to_status = 'completed'`)
        .first<{ n: number }>();
      expect(historyCount?.n).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

describe('published report portal rendering', () => {
  it('uses report-dependent completion copy and escapes the snapshot fields it renders', () => {
    expect(portalScript).toContain('completed: v.report');
    expect(portalScript).toContain('renderPublishedReport(v.report)');
    expect(portalScript).toContain('AutoClarityReportView.render(report)');
    expect(portalScript).toContain('AutoClarity will review the vehicle, location, access, and requested timing, then follow up by email with next steps.');
    expect(portalScript).not.toContain('typically responds within 24 hours');
    expect(portalScript).not.toContain('Your inspection is complete. Your results are in the messages below.');
    expect(portalScript).not.toContain('/api/portal/calendar?t=');
    expect(portalScript).toContain('fetch("/api/portal/calendar"');
    expect(portalScript).toContain('authorization: "Bearer " + token');
  });
});
