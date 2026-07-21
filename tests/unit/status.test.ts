import { describe, expect, it } from 'vitest';
import { STATUSES, canTransition, isStatus } from '../../functions/lib/status.ts';

describe('status state machine', () => {
  it('allows the happy booking path', () => {
    const path = [
      'submitted', 'ready_for_review', 'quote_prepared', 'quote_sent',
      'awaiting_time_selection', 'awaiting_agreement', 'awaiting_payment',
      'confirmed', 'inspection_in_progress', 'report_in_progress', 'completed',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('blocks skipping payment', () => {
    expect(canTransition('quote_sent', 'confirmed')).toBe(false);
    expect(canTransition('awaiting_agreement', 'confirmed')).toBe(false);
    expect(canTransition('submitted', 'confirmed')).toBe(false);
  });

  it('blocks resurrecting terminal states arbitrarily', () => {
    expect(canTransition('completed', 'submitted')).toBe(false);
    expect(canTransition('customer_cancelled', 'confirmed')).toBe(false);
    expect(canTransition('refunded', 'confirmed')).toBe(false);
  });

  it('allows refunds and disputes where money moved', () => {
    expect(canTransition('confirmed', 'refunded')).toBe(true);
    expect(canTransition('completed', 'disputed')).toBe(true);
    expect(canTransition('customer_cancelled', 'refunded')).toBe(true);
  });

  it('allows admin to reopen expired requests', () => {
    expect(canTransition('expired', 'ready_for_review')).toBe(true);
  });

  it('every status has an entry in the transition table (no dead keys)', () => {
    for (const s of STATUSES) {
      expect(isStatus(s)).toBe(true);
      // canTransition must not throw for any pair
      for (const t of STATUSES) canTransition(s, t);
    }
  });
});
