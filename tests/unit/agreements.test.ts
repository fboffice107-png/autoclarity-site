/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import initialMigration from '../../migrations/0001_init.sql?raw';
import agreementImmutabilityMigration from '../../migrations/0007_agreement_version_immutability.sql?raw';
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

// Exact operative bodies from the verified 2026-09-11 production inventory.
// These literal hashes are independent of AGREEMENT_DOCS and catch text drift.
const LIVE_AGREEMENT_HASHES = {
  ag_cancellation_policy_v3: 'd98c88cc50d28fd4fab04a05774173cd5adfd9484abd3675f21ca998916e6e1c',
  ag_e_comms_v2: 'fa44187c8747940d69c4306dffb6d81f6cbef76ff71c68e53b309a1c0254377d',
  ag_photos_consent_v2: 'de9a5154c638c0a5e9cdb68c8e9763b955612d83948546649b66cfabf94c0203',
  ag_privacy_notice_v2: '254214b10c97b27d143fd31be6944798f720734dda41cdca69c8f5d40a06ad4c',
  ag_road_test_v2: '0f9db3bb7efb67e9cd282a79e5dbf05d8be05e2d4abdfd4c5f2faa13b751bbba',
  ag_scope_limitations_v2: '467b9d62ae81d8881bd452fc0831203dad8986994eb1e567103a189fc698090b',
  ag_seller_access_v2: '84e75bcc70ffe33601757705d674c016dd3ee4be32cd093348846a0ceb5d7f4c',
  ag_service_agreement_v2: '42a422783320f000a134a760507100899c8432be6b54711fb7a7cac54fd57033',
  ag_underbody_limitations_v2: '6c3df4cd338927579e230762f19f7eca0bbe159d7f825bf681840490cd90807b',
};

describe('agreement source seeding', () => {
  it('publishes explicit current versions while preserving immutable historical evidence', async () => {
    const policy = AGREEMENT_DOCS.find((doc) => doc.docKey === 'cancellation_policy');
    expect(policy).toBeDefined();
    expect(policy?.version).toBe(3);
    expect(policy?.bodyMd).toContain('one replacement vehicle with no transfer fee');
    expect(policy?.bodyMd).toContain('review the replacement vehicle, location, requested scope and seller access');
    expect(policy?.bodyMd).toContain('pay the difference before the replacement booking is confirmed');
    expect(policy?.bodyMd).toContain('AutoClarity refunds the difference');
    expect(policy?.bodyMd).toContain('existing payment transfers with no additional charge');
    expect(Object.fromEntries(AGREEMENT_DOCS.map((doc) => [doc.docKey, doc.version]))).toEqual({
      service_agreement: 2,
      scope_limitations: 2,
      cancellation_policy: 3,
      seller_access: 2,
      road_test: 2,
      photos_consent: 2,
      underbody_limitations: 2,
      privacy_notice: 2,
      e_comms: 2,
    });

    const { sqlite, db } = agreementDatabase();
    try {
      const historicalDocs = [
        ['scope_limitations', 'Scope and Limitations', 1],
        ['cancellation_policy', 'Cancellation and Refund Policy', 2],
        ['underbody_limitations', 'Underbody, Jacking and Lift Limitations', 1],
      ] as const;
      for (const [docKey, title, version] of historicalDocs) {
        sqlite.prepare(
          `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, 'historical-sha', '2029-01-01T00:00:00.000Z')`,
        ).run(`ag_${docKey}_v${version}`, docKey, version, title, `Historical ${docKey} version ${version}`);
      }
      sqlite.exec(agreementImmutabilityMigration);

      await ensureAgreements(db);

      for (const [docKey, , version] of historicalDocs) {
        expect(sqlite.prepare(
          `SELECT body_md FROM agreement_versions WHERE doc_key = ? AND version = ?`,
        ).get(docKey, version)).toEqual({ body_md: `Historical ${docKey} version ${version}` });
        const current = AGREEMENT_DOCS.find((doc) => doc.docKey === docKey);
        expect(sqlite.prepare(
          `SELECT id, version, body_md FROM agreement_versions WHERE doc_key = ? AND version = ?`,
        ).get(docKey, current?.version)).toEqual({
          id: `ag_${docKey}_v${current?.version}`,
          version: current?.version,
          body_md: current?.bodyMd,
        });
        expect(() => sqlite.prepare(
          `UPDATE agreement_versions SET body_md = 'changed' WHERE doc_key = ? AND version = ?`,
        ).run(docKey, version)).toThrow(/agreement versions are immutable/u);
      }
    } finally {
      sqlite.close();
    }
  });

  it('first agreement load seeds only the exact nine live bodies, never proposed scope/underbody v3', async () => {
    const { sqlite, db } = agreementDatabase();
    try {
      sqlite.exec(agreementImmutabilityMigration);
      const current = await latestAgreements(db);
      expect(Object.fromEntries(current.map((row) => [row.id, row.sha256]))).toEqual(LIVE_AGREEMENT_HASHES);
      for (const row of current) expect(await sha256Hex(row.body_md)).toBe(row.sha256);
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM agreement_versions`).get()).toEqual({ n: 9 });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS n FROM agreement_versions
         WHERE doc_key IN ('scope_limitations', 'underbody_limitations') AND version >= 3`,
      ).get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('first load over existing live versions performs no writes and preserves all historical rows', async () => {
    const { sqlite, db } = agreementDatabase();
    try {
      for (const doc of AGREEMENT_DOCS) {
        const id = `ag_${doc.docKey}_v${doc.version}`;
        const hash = LIVE_AGREEMENT_HASHES[id as keyof typeof LIVE_AGREEMENT_HASHES];
        expect(hash).toBeDefined();
        sqlite.prepare(
          `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '2026-09-03T20:58:53.426Z')`,
        ).run(id, doc.docKey, doc.version, doc.title, doc.bodyMd, hash);
        sqlite.prepare(
          `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
           VALUES (?, ?, 1, ?, 'Retained historical body', 'retained-historical-hash', '2026-07-22T22:33:39.890Z')`,
        ).run(`ag_${doc.docKey}_v1`, doc.docKey, doc.title);
      }
      sqlite.exec(agreementImmutabilityMigration);
      const before = sqlite.prepare(`SELECT * FROM agreement_versions ORDER BY id`).all();
      const changesBefore = sqlite.prepare(`SELECT total_changes() AS n`).get();

      const current = await latestAgreements(db);
      await ensureAgreements(db);

      expect(Object.fromEntries(current.map((row) => [row.id, row.sha256]))).toEqual(LIVE_AGREEMENT_HASHES);
      expect(sqlite.prepare(`SELECT * FROM agreement_versions ORDER BY id`).all()).toEqual(before);
      expect(sqlite.prepare(`SELECT total_changes() AS n`).get()).toEqual(changesBefore);
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS n FROM agreement_versions
         WHERE doc_key IN ('scope_limitations', 'underbody_limitations') AND version >= 3`,
      ).get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

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
