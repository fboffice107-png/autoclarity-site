/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import {
  providerRefundStatusPrecedence,
  shouldApplyProviderRefundEvent,
  validateStripeRefundIdentity,
} from '../../functions/lib/refunds.ts';

type LedgerStatus = 'pending' | 'succeeded' | 'requires_action' | 'failed' | 'canceled' | 'unknown';

describe('provider refund event ordering', () => {
  const current = (status: LedgerStatus, created: number, id: string) => ({
    status,
    last_event_created: created,
    last_event_id: id,
  });
  const incoming = (status: LedgerStatus, created: number, id: string) => ({
    status,
    eventCreated: created,
    eventId: id,
  });

  it('always accepts a newer event, including succeeded to failed', () => {
    expect(shouldApplyProviderRefundEvent(
      current('succeeded', 100, 'evt_success'),
      incoming('failed', 200, 'evt_failed'),
    )).toBe(true);
    expect(shouldApplyProviderRefundEvent(
      current('failed', 200, 'evt_failed'),
      incoming('succeeded', 100, 'evt_success'),
    )).toBe(false);
  });

  it('uses deterministic terminal precedence at the same second', () => {
    expect(providerRefundStatusPrecedence('failed')).toBeGreaterThan(providerRefundStatusPrecedence('succeeded'));
    expect(providerRefundStatusPrecedence('canceled')).toBeGreaterThan(providerRefundStatusPrecedence('succeeded'));
    expect(shouldApplyProviderRefundEvent(
      current('succeeded', 300, 'evt_z'),
      incoming('failed', 300, 'evt_a'),
    )).toBe(true);
    expect(shouldApplyProviderRefundEvent(
      current('failed', 300, 'evt_a'),
      incoming('succeeded', 300, 'evt_z'),
    )).toBe(false);
  });

  it('uses event id only as a stable tie break for equal timestamp and status', () => {
    expect(shouldApplyProviderRefundEvent(
      current('pending', 400, 'evt_a'),
      incoming('pending', 400, 'evt_b'),
    )).toBe(true);
    expect(shouldApplyProviderRefundEvent(
      current('pending', 400, 'evt_b'),
      incoming('pending', 400, 'evt_a'),
    )).toBe(false);
  });
});

describe('immediate Stripe refund identity', () => {
  const expected = {
    paymentIntent: 'pi_exact',
    amountCents: 12500,
    currency: 'usd',
    operationId: 'rfo_exact',
    attemptNo: 2,
  };
  const response = {
    id: 're_exact',
    amount: 12500,
    currency: 'usd',
    payment_intent: 'pi_exact',
    created: 1_800_000_000,
    metadata: {
      refund_operation_id: 'rfo_exact',
      refund_attempt_no: '2',
    },
  };

  it('accepts only the exact submitted payment, amount, currency, and operation', () => {
    expect(validateStripeRefundIdentity(response, expected)).toEqual({
      ok: true,
      providerRefundId: 're_exact',
      paymentIntent: 'pi_exact',
      amountCents: 12500,
      currency: 'usd',
      providerCreated: 1_800_000_000,
    });
  });

  it.each([
    ['amount_mismatch', { amount: 12499 }],
    ['currency_mismatch', { currency: 'eur' }],
    ['payment_intent_mismatch', { payment_intent: 'pi_other' }],
    ['invalid_created', { created: null }],
    ['metadata_mismatch', { metadata: { refund_operation_id: 'rfo_other', refund_attempt_no: '2' } }],
  ])('fails closed on %s', (reason, override) => {
    expect(validateStripeRefundIdentity({ ...response, ...override }, expected)).toMatchObject({ ok: false, reason });
  });
});
