import { describe, expect, it } from 'vitest';
import { releaseExpiredHolds } from '../../functions/lib/portal.ts';

async function capture(): Promise<string[]> {
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
  return batches[0] ?? [];
}

describe('expired appointment holds', () => {
  it('repairs history, request, booking, and slot in one ordered D1 batch', async () => {
    const sql = await capture();
    // One transaction, ordered: record the change, move the request, detach
    // the pending booking, then free the slot.
    const lapsed = sql.slice(0, 4);
    expect(lapsed[0]).toContain('INSERT INTO status_history');
    expect(lapsed[1]).toContain("status = 'awaiting_time_selection'");
    expect(lapsed[2]).toContain('slot_id = NULL');
    expect(lapsed[3]).toContain("status = 'offered'");
    for (const statement of lapsed) expect(statement).toContain("status = 'held'");
  });

  it('also repairs a request left at the agreement or payment step with no held slot', async () => {
    // The statements above only fire while an expired hold still exists. A
    // request whose slot was released by some other path stayed in
    // awaiting_agreement forever, leaving the customer on a page with nothing
    // to press — observed in production. These two statements are the repair.
    const sql = await capture();
    expect(sql).toHaveLength(6);

    const [history, move] = sql.slice(4);
    expect(history).toContain('INSERT INTO status_history');
    expect(history).toContain('system:hold-repair');
    expect(move).toContain("status = 'awaiting_time_selection'");

    for (const statement of [history, move]) {
      // Scoped to the two stuck statuses...
      expect(statement).toContain("'awaiting_agreement','awaiting_payment'");
      // ...only when no held slot remains...
      expect(statement).toMatch(/NOT EXISTS[\s\S]*appointment_slots[\s\S]*status = 'held'/u);
      // ...and never where money has already settled.
      expect(statement).toMatch(/NOT EXISTS[\s\S]*payments[\s\S]*'succeeded','partially_refunded','refunded','disputed'/u);
      expect(statement).toContain('deleted_at IS NULL');
    }
  });

  it('runs the whole repair as a single transactional batch', async () => {
    // Splitting this across calls could strand a request between the history
    // row and the status move.
    const sql = await capture();
    expect(sql.every((statement) => typeof statement === 'string' && statement.length > 0)).toBe(true);
  });
});
