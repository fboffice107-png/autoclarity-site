// The $25 same-day priority fee.
//
// It was a configurable number that no code path ever added to a price, so
// ticking the box on the intake form did nothing and the owner was never paid
// for going out the same day. These tests pin both halves of the promise made
// on the intake page: the fee is charged when the appointment really is today,
// and is NOT charged when it is not.

import { describe, expect, it } from 'vitest';
import { buildPriceBreakdown } from '../../functions/lib/quote-math.ts';
import { hasSameDaySlot } from '../../functions/lib/booking-proposal.ts';
import { DEFAULT_CONFIG, type PpiConfig } from '../../functions/lib/config.ts';
import { computeQuoteTotals } from '../../functions/lib/pricing.ts';

const config: PpiConfig = DEFAULT_CONFIG;
const TZ = 'America/Los_Angeles';

describe('the same-day fee reaches the total', () => {
  it('is $25 and is itemised, not folded into the package price', () => {
    expect(config.fees.sameDayPriorityCents).toBe(2500);
    const b = buildPriceBreakdown({ tier: 'standard', config, sameDayPriority: true, travelMiles: 5 });
    expect(b.baseCents).toBe(19900);
    expect(b.totalCents).toBe(19900 + 2500);
    const line = b.lines.find((l) => l.label === 'Same-day priority');
    expect(line?.display).toBe('$25.00');
  });

  it('is persisted on the quote, so the Stripe charge matches the proposal', () => {
    const b = buildPriceBreakdown({ tier: 'standard', config, sameDayPriority: true, travelMiles: 5 });
    expect(computeQuoteTotals(b.quoteLines).totalCents).toBe(b.totalCents);
    expect(b.quoteLines.some((l) => l.label === 'Same-day priority')).toBe(true);
  });

  it('adds to every package and stacks with travel', () => {
    expect(buildPriceBreakdown({ tier: 'euro_luxury_performance', config, sameDayPriority: true, travelMiles: 20 }).totalCents)
      .toBe(29900 + 2500 + 2500);
    expect(buildPriceBreakdown({ tier: 'exotic_collector', config, sameDayPriority: true, travelMiles: 5 }).totalCents)
      .toBe(39900 + 2500);
  });

  it('changes nothing when it is not asked for', () => {
    expect(buildPriceBreakdown({ tier: 'standard', config, travelMiles: 5 }).totalCents).toBe(19900);
    expect(buildPriceBreakdown({ tier: 'standard', config, sameDayPriority: false, travelMiles: 5 }).totalCents).toBe(19900);
  });

  it('is skipped entirely when the owner has configured it to $0', () => {
    const free: PpiConfig = { ...config, fees: { ...config.fees, sameDayPriorityCents: 0 } };
    const b = buildPriceBreakdown({ tier: 'standard', config: free, sameDayPriority: true, travelMiles: 5 });
    expect(b.totalCents).toBe(19900);
    expect(b.lines.some((l) => l.label === 'Same-day priority')).toBe(false);
  });
});

describe('"charged only if we actually come out today"', () => {
  // The intake page states this in writing, so it has to be structural rather
  // than something the owner has to remember when composing a proposal.
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-07:00`).toISOString();

  it('recognises a slot on today’s local date', () => {
    const now = new Date('2026-09-22T19:00:00Z'); // noon in Las Vegas
    expect(hasSameDaySlot([at('2026-09-22', '15:00')], TZ, now)).toBe(true);
  });

  it('rejects tomorrow, and rejects an empty slate', () => {
    const now = new Date('2026-09-22T19:00:00Z');
    expect(hasSameDaySlot([at('2026-09-23', '09:00')], TZ, now)).toBe(false);
    expect(hasSameDaySlot([], TZ, now)).toBe(false);
  });

  it('finds a same-day slot among later days', () => {
    const now = new Date('2026-09-22T19:00:00Z');
    const slots = [at('2026-09-22', '16:00'), at('2026-09-23', '09:00'), at('2026-09-25', '11:00')];
    expect(hasSameDaySlot(slots, TZ, now)).toBe(true);
  });

  it('uses the Las Vegas date, not UTC', () => {
    // 2026-09-23T02:00Z is still 7pm on the 22nd in Las Vegas. Judged in UTC
    // this evening appointment would look like tomorrow and lose the fee.
    const now = new Date('2026-09-23T02:00:00Z');
    expect(now.toISOString().slice(0, 10)).toBe('2026-09-23');
    expect(hasSameDaySlot([at('2026-09-22', '19:30')], TZ, now)).toBe(true);
  });

  it('ignores an unparseable time rather than treating it as today', () => {
    const now = new Date('2026-09-22T19:00:00Z');
    expect(hasSameDaySlot(['not-a-date'], TZ, now)).toBe(false);
  });
});
