/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
// @ts-expect-error node:sqlite is intentionally outside the Worker type surface.
import { DatabaseSync } from 'node:sqlite';
import initialMigration from '../../migrations/0001_init.sql?raw';
import paymentSlotIntegrityMigration from '../../migrations/0004_payment_slot_integrity.sql?raw';
import refundLedgerMigration from '../../migrations/0005_provider_refund_ledger.sql?raw';
import disputeLedgerMigration from '../../migrations/0006_payment_disputes.sql?raw';
import {
  classifyProviderDisputeStatus,
  decideOrderedDisputeAxis,
  disputeFundsStateForEvent,
  disputeFundsStatePrecedence,
  disputePaymentDecision,
  providerDisputeStatusPrecedence,
  reconcilePaymentDisputeState,
  recordPaymentDisputeEvent,
  type PaymentDisputeEventInput,
} from '../../functions/lib/disputes.ts';

interface SqliteStatementLike {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number | bigint };
}

interface SqliteLike {
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
  return { prepare: (sql: string) => statement(sql) } as D1Database;
}

function seedDatabase(): { sqlite: InstanceType<typeof DatabaseSync>; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(initialMigration);
  sqlite.exec(paymentSlotIntegrityMigration);
  sqlite.exec(refundLedgerMigration);
  sqlite.exec(disputeLedgerMigration);
  sqlite.exec(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES ('cus_disputes', 'Dispute Test', 'disputes@example.com', '555-0100', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO vehicles (id, make, model, created_at, updated_at)
    VALUES ('veh_disputes', 'Test', 'Vehicle', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
    VALUES ('req_disputes', 'PPI-DISPUTES', 'cus_disputes', 'veh_disputes', 'disputed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
    VALUES ('quo_disputes', 'req_disputes', 1, 'accepted', 'standard', 'usd', 19900, 19900, '2031-01-01T00:00:00.000Z', 'test', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    INSERT INTO payments
      (id, request_id, quote_id, stripe_payment_intent, amount_cents, currency, status, created_at, updated_at)
    VALUES ('pay_disputes', 'req_disputes', 'quo_disputes', 'pi_disputes', 19900, 'usd', 'disputed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
  `);
  return { sqlite, db: sqliteD1(sqlite) };
}

const baseEvent: PaymentDisputeEventInput = {
  providerDisputeId: 'du_disputes',
  paymentId: 'pay_disputes',
  paymentIntent: 'pi_disputes',
  providerChargeId: 'ch_disputes',
  amountCents: 5000,
  currency: 'usd',
  providerCreated: 90,
  eventCreated: 100,
  eventId: 'evt_dispute_created',
  providerStatus: 'needs_response',
};

describe('ordered dispute axes', () => {
  it('uses separate clocks, exact retries, and fail-closed same-second precedence', async () => {
    const { sqlite, db } = seedDatabase();
    try {
      const created = await recordPaymentDisputeEvent(db, baseEvent);
      expect(created.statusDisposition).toBe('applied');
      expect(created.fundsDisposition).toBe('not_supplied');
      expect(created.authoritative).toBe(true);

      const withdrawn = await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 120,
        eventId: 'evt_dispute_withdrawn',
        providerStatus: undefined,
        fundsState: 'withdrawn',
      });
      expect(withdrawn.fundsDisposition).toBe('applied');

      const won = await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 200,
        eventId: 'evt_dispute_won',
        providerStatus: 'won',
      });
      expect(won.statusDisposition).toBe('applied');

      // This funds event is older than the status event but newer on its own
      // axis, so it must still be accepted.
      const reinstated = await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 150,
        eventId: 'evt_dispute_reinstated',
        providerStatus: undefined,
        fundsState: 'reinstated',
      });
      expect(reinstated.fundsDisposition).toBe('applied');
      expect(reinstated.row.provider_status).toBe('won');
      expect(reinstated.row.funds_state).toBe('reinstated');

      const exactRetry = await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 150,
        eventId: 'evt_dispute_reinstated',
        providerStatus: undefined,
        fundsState: 'reinstated',
      });
      expect(exactRetry.fundsDisposition).toBe('replay');
      expect(exactRetry.applied).toBe(false);
      expect(exactRetry.authoritative).toBe(true);

      const staleCreated = await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 110,
        eventId: 'evt_dispute_stale_created',
        providerStatus: 'under_review',
      });
      expect(staleCreated.statusDisposition).toBe('stale');
      expect(staleCreated.authoritative).toBe(false);
      expect(staleCreated.row.provider_status).toBe('won');

      const sameSecondLost = await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 200,
        eventId: 'evt_a_lost',
        providerStatus: 'lost',
      });
      expect(sameSecondLost.statusDisposition).toBe('applied');
      expect(sameSecondLost.row.provider_status).toBe('lost');
    } finally {
      sqlite.close();
    }
  });

  it('rejects conflicting immutable identity before a concurrent loser can mutate the winner', async () => {
    const { sqlite, db } = seedDatabase();
    try {
      const candidates = [
        {
          label: 'first',
          input: { ...baseEvent, providerDisputeId: 'du_concurrent_identity' },
        },
        {
          label: 'second',
          input: {
            ...baseEvent,
            providerDisputeId: 'du_concurrent_identity',
            providerChargeId: 'ch_conflicting_identity',
            eventCreated: 200,
            eventId: 'evt_conflicting_identity',
            providerStatus: 'lost' as const,
          },
        },
      ];
      const settled = await Promise.allSettled(candidates.map(async (candidate) => ({
        label: candidate.label,
        result: await recordPaymentDisputeEvent(db, candidate.input),
      })));
      const fulfilled = settled.filter((result) => result.status === 'fulfilled');
      const rejected = settled.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/immutable payment identity/);

      const winner = (fulfilled[0] as PromiseFulfilledResult<{ label: string }>).value.label;
      const persisted = sqlite.prepare(`
        SELECT provider_charge_id, provider_status, status_event_id
        FROM payment_disputes WHERE provider_dispute_id = 'du_concurrent_identity'
      `).get();
      expect(persisted).toEqual(winner === 'first'
        ? {
            provider_charge_id: 'ch_disputes',
            provider_status: 'needs_response',
            status_event_id: 'evt_dispute_created',
          }
        : {
            provider_charge_id: 'ch_conflicting_identity',
            provider_status: 'lost',
            status_event_id: 'evt_conflicting_identity',
          });
    } finally {
      sqlite.close();
    }
  });

  it('classifies provider values and makes conservative payment-only decisions', () => {
    expect(classifyProviderDisputeStatus('won')).toBe('won');
    expect(classifyProviderDisputeStatus('future_status')).toBe('unknown');
    expect(disputeFundsStateForEvent('charge.dispute.funds_withdrawn')).toBe('withdrawn');
    expect(disputeFundsStateForEvent('charge.dispute.closed')).toBeNull();

    expect(disputePaymentDecision([])).toBe('no_disputes');
    expect(disputePaymentDecision([{ provider_status: 'under_review', funds_state: 'withdrawn' }])).toBe('hold_disputed');
    expect(disputePaymentDecision([{ provider_status: 'lost', funds_state: 'reinstated' }])).toBe('hold_disputed');
    expect(disputePaymentDecision([{ provider_status: 'won', funds_state: 'unknown' }])).toBe('manual_reconciliation');
    expect(disputePaymentDecision([{ provider_status: 'won', funds_state: 'reinstated' }])).toBe('restore_refund_derived_status');

    expect(decideOrderedDisputeAxis(
      { value: 'won', eventCreated: 300, eventId: 'evt_same' },
      { value: 'lost', eventCreated: 300, eventId: 'evt_same' },
      providerDisputeStatusPrecedence,
    )).toBe('conflict');
    expect(decideOrderedDisputeAxis(
      { value: 'reinstated', eventCreated: 400, eventId: 'evt_z' },
      { value: 'withdrawn', eventCreated: 400, eventId: 'evt_a' },
      disputeFundsStatePrecedence,
    )).toBe('apply');
  });

  it('releases only the payment latch after a favorable close plus reinstated funds', async () => {
    const { sqlite, db } = seedDatabase();
    try {
      await recordPaymentDisputeEvent(db, baseEvent);
      const opened = await reconcilePaymentDisputeState(db, baseEvent.paymentId);
      expect(opened.status).toBe('disputed');
      expect(opened.decision).toBe('hold_disputed');

      await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 200,
        eventId: 'evt_dispute_closed_won',
        providerStatus: 'won',
      });
      const wonWithoutFunds = await reconcilePaymentDisputeState(db, baseEvent.paymentId);
      expect(wonWithoutFunds.status).toBe('disputed');
      expect(wonWithoutFunds.decision).toBe('manual_reconciliation');

      await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 210,
        eventId: 'evt_dispute_funds_reinstated',
        providerStatus: undefined,
        fundsState: 'reinstated',
      });
      const reinstated = await reconcilePaymentDisputeState(db, baseEvent.paymentId);
      expect(reinstated.status).toBe('succeeded');
      expect(reinstated.decision).toBe('restore_refund_derived_status');

      const requestAfterRestore = sqlite.prepare(`SELECT status FROM ppi_requests WHERE id = ?`).get('req_disputes');
      expect(requestAfterRestore).toEqual({ status: 'disputed' });

      await recordPaymentDisputeEvent(db, {
        ...baseEvent,
        eventCreated: 220,
        eventId: 'evt_dispute_funds_withdrawn',
        providerStatus: undefined,
        fundsState: 'withdrawn',
      });
      const withdrawn = await reconcilePaymentDisputeState(db, baseEvent.paymentId);
      expect(withdrawn.status).toBe('disputed');
      expect(withdrawn.decision).toBe('hold_disputed');
    } finally {
      sqlite.close();
    }
  });
});
