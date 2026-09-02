/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import initialMigration from '../../migrations/0001_init.sql?raw';
import {
  AGREEMENT_DOCS,
  AgreementIntegrityError,
  ensureAgreements,
  latestAgreements,
} from '../../functions/lib/agreements.ts';
import { sha256Hex } from '../../functions/lib/util.ts';

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
      if (columnName) return (value as Record<string, unknown>)[columnName] as T ?? null;
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

  return {
    prepare: (sql: string) => statement(sql),
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results: D1Result<T>[] = [];
        for (const prepared of statements) results.push(await prepared.run<T>());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as D1Database;
}

function agreementDatabase(): { sqlite: InstanceType<typeof DatabaseSync>; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(initialMigration);
  return { sqlite, db: sqliteD1(sqlite) };
}

describe('agreement source seeding', () => {
  it('fills every missing explicit source version when the table is partially populated', async () => {
    const { sqlite, db } = agreementDatabase();
    try {
      const first = AGREEMENT_DOCS[0]!;
      const hash = await sha256Hex(first.bodyMd);
      sqlite.prepare(
        `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `ag_${first.docKey}_v${first.version}`,
        first.docKey,
        first.version,
        first.title,
        first.bodyMd,
        hash,
        '2030-01-01T00:00:00.000Z',
      );

      await ensureAgreements(db);

      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM agreement_versions`).get()).toEqual({
        n: AGREEMENT_DOCS.length,
      });
      for (const doc of AGREEMENT_DOCS) {
        expect(Number.isSafeInteger(doc.version) && doc.version > 0).toBe(true);
        expect(sqlite.prepare(
          `SELECT id FROM agreement_versions WHERE doc_key = ? AND version = ?`,
        ).get(doc.docKey, doc.version)).toEqual({ id: `ag_${doc.docKey}_v${doc.version}` });
      }
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ['id', 'ag_foreign_identity'],
    ['title', 'Tampered title'],
    ['body_md', 'Tampered body'],
    ['sha256', 'tampered-hash'],
  ] as const)('fails closed when an existing source version has a mismatched %s', async (field, value) => {
    const { sqlite, db } = agreementDatabase();
    try {
      await ensureAgreements(db);
      const first = AGREEMENT_DOCS[0]!;
      sqlite.prepare(
        `UPDATE agreement_versions SET ${field} = ? WHERE doc_key = ? AND version = ?`,
      ).run(value, first.docKey, first.version);

      await expect(ensureAgreements(db)).rejects.toBeInstanceOf(AgreementIntegrityError);
      await expect(ensureAgreements(db)).rejects.toThrow(
        `Agreement ${first.docKey} v${first.version} differs from its immutable source definition.`,
      );
    } finally {
      sqlite.close();
    }
  });

  it.each(['higher_known_version', 'unknown_doc_key'] as const)(
    'rejects an operative latest row without an exact source definition: %s',
    async (scenario) => {
      const { sqlite, db } = agreementDatabase();
      try {
        await ensureAgreements(db);
        const first = AGREEMENT_DOCS[0]!;
        const docKey = scenario === 'higher_known_version' ? first.docKey : 'unknown_terms';
        const version = scenario === 'higher_known_version' ? first.version + 1 : 1;
        sqlite.prepare(
          `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
           VALUES (?, ?, ?, 'Unknown terms', 'Unknown terms', 'unknown-sha', '2030-01-02T00:00:00.000Z')`,
        ).run(`ag_unknown_${scenario}`, docKey, version);

        await expect(latestAgreements(db)).rejects.toBeInstanceOf(AgreementIntegrityError);
        await expect(latestAgreements(db)).rejects.toThrow(/source definition|source requires/);
      } finally {
        sqlite.close();
      }
    },
  );

  it('allows an unknown historical row below the explicit operative source version', async () => {
    const { sqlite, db } = agreementDatabase();
    try {
      await ensureAgreements(db);
      const first = AGREEMENT_DOCS[0]!;
      sqlite.prepare(
        `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
         VALUES ('ag_historical_unknown', ?, ?, 'Historical', 'Historical', 'historical-sha', '2029-01-01T00:00:00.000Z')`,
      ).run(first.docKey, first.version - 1);

      const latest = await latestAgreements(db);
      expect(latest).toHaveLength(AGREEMENT_DOCS.length);
      expect(latest.find((row) => row.doc_key === first.docKey)?.id).toBe(
        `ag_${first.docKey}_v${first.version}`,
      );
    } finally {
      sqlite.close();
    }
  });
});
