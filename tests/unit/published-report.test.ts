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

async function insertReportFixture(
  db: D1Database,
  options: ReportFixtureOptions = {},
): Promise<{ reportId: string; versionId: string; payload: Record<string, unknown>; payloadJson: string }> {
  const requestId = options.requestId ?? 'req_report_a';
  const suffix = requestId.endsWith('_b') ? 'b' : 'a';
  const reportId = options.reportId ?? `rpt_report_${suffix}`;
  const versionId = options.versionId ?? `rv_report_${suffix}_1`;
  const payload = options.payload ?? {
    schema: 'autoclarity.ppi.report',
    schemaVersion: 1,
    inspector: 'Test Inspector',
    overall: { score: 8.4, verdict: 'proceed', verdictLabel: 'Proceed', executiveSummary: `Snapshot ${versionId}` },
    sections: [],
  };
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
        payload: selected.payload,
      });

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
        payload: selected.payload,
      });
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
    expect(portalScript).toContain('esc(details.join(" · "))');
    expect(portalScript).toContain('AutoClarity will review the vehicle, location, access, and requested timing, then follow up by email with next steps.');
    expect(portalScript).not.toContain('typically responds within 24 hours');
    expect(portalScript).not.toContain('Your inspection is complete. Your results are in the messages below.');
  });
});
