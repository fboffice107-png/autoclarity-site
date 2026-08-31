import { describe, expect, it } from 'vitest';
import { inspectMagicToken, issueMagicLink, verifyMagicToken } from '../../functions/lib/magic.ts';
import type { PpiConfig } from '../../functions/lib/config.ts';

function fakeDb(failBatch = false): {
  db: D1Database;
  batches: Array<Array<{ sql: string; args: unknown[] }>>;
  standaloneRuns: string[];
} {
  const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  const standaloneRuns: string[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        sql,
        get args() { return args; },
        bind(...values: unknown[]) { args = values; return this; },
        async run() { standaloneRuns.push(sql); return { meta: { changes: 1 } }; },
        async first<T>() {
          if (!sql.includes('FROM magic_links WHERE token_hash')) return null;
          const insert = batches.flat().find((item) =>
            item.sql.includes('INSERT INTO magic_links') && item.args[2] === args[0],
          );
          if (!insert) return null;
          return {
            id: insert.args[0],
            request_id: insert.args[1],
            expires_at: insert.args[3],
            revoked_at: null,
          } as T;
        },
      };
    },
    async batch(statements: Array<{ sql: string; args: unknown[] }>) {
      batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
      if (failBatch) throw new Error('simulated transactional failure');
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, batches, standaloneRuns };
}

const config = { magicLinks: { ttlHours: 24 } } as PpiConfig;

describe('magic-link rotation', () => {
  it('revokes and inserts in one transactional D1 batch', async () => {
    const { db, batches, standaloneRuns } = fakeDb();
    const result = await issueMagicLink(db, 'req_1', config, true);
    expect(result.id).toMatch(/^ml_/);
    expect(result.token.length).toBeGreaterThan(30);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.sql).toContain('UPDATE magic_links SET revoked_at');
    expect(batches[0]?.[1]?.sql).toContain('INSERT INTO magic_links');
    expect(standaloneRuns).toEqual([]);
  });

  it('does not leave a rotation half-applied when the batch fails', async () => {
    const { db, batches, standaloneRuns } = fakeDb(true);
    await expect(issueMagicLink(db, 'req_1', config, true)).rejects.toThrow('transactional failure');
    expect(batches[0]).toHaveLength(2);
    expect(standaloneRuns).toEqual([]);
  });

  it('can add a non-rotating secure link in a single-statement batch', async () => {
    const { db, batches } = fakeDb();
    await issueMagicLink(db, 'req_1', config, false);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]?.[0]?.sql).toContain('INSERT INTO magic_links');
  });

  it('inspects without consuming a token and marks usage only during verification', async () => {
    const { db, standaloneRuns } = fakeDb();
    const issued = await issueMagicLink(db, 'req_1', config, false);
    const inspected = await inspectMagicToken(db, issued.token);
    expect(inspected).toMatchObject({ ok: true, id: issued.id, requestId: 'req_1' });
    expect(standaloneRuns).toEqual([]);

    await expect(verifyMagicToken(db, issued.token)).resolves.toEqual({ ok: true, requestId: 'req_1' });
    expect(standaloneRuns).toHaveLength(1);
    expect(standaloneRuns[0]).toContain('UPDATE magic_links SET used_at');
  });
});
