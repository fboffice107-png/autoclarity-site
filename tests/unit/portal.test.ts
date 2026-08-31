import { describe, expect, it } from 'vitest';
import { releaseExpiredHolds } from '../../functions/lib/portal.ts';

describe('expired appointment holds', () => {
  it('repairs history, request, booking, and slot in one ordered D1 batch', async () => {
    const batches: string[][] = [];
    const db = {
      prepare(sql: string) {
        return { sql, bind() { return this; } };
      },
      async batch(statements: Array<{ sql: string }>) {
        batches.push(statements.map((statement) => statement.sql));
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await releaseExpiredHolds(db);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
    expect(batches[0]?.[0]).toContain('INSERT INTO status_history');
    expect(batches[0]?.[1]).toContain("status = 'awaiting_time_selection'");
    expect(batches[0]?.[2]).toContain('slot_id = NULL');
    expect(batches[0]?.[3]).toContain("status = 'offered'");
    for (const sql of batches[0] ?? []) expect(sql).toContain("status = 'held'");
  });
});
