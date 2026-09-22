// The shared price calculation. Every surface that shows money imports this,
// so these tests are the guarantee that a Standard Corolla with included
// travel reads $199 on the intake estimate, the admin card, the customer's
// proposal and the Stripe charge.

import { describe, expect, it } from 'vitest';
import { buildPriceBreakdown, describeTravel, BOUNDARY_MILES } from '../../functions/lib/quote-math.ts';
import { DEFAULT_CONFIG, type PpiConfig } from '../../functions/lib/config.ts';
import { computeQuoteTotals } from '../../functions/lib/pricing.ts';

const config: PpiConfig = DEFAULT_CONFIG;

describe('one shared price calculation', () => {
  it('a Standard vehicle with included travel and no extras is exactly $199', () => {
    const b = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 8.2, travelBasis: 'zip_centroid' });
    expect(b.baseCents).toBe(19900);
    expect(b.travel.feeCents).toBe(0);
    expect(b.travel.included).toBe(true);
    expect(b.totalCents).toBe(19900);
    // The quote lines that get persisted must produce the identical total.
    expect(computeQuoteTotals(b.quoteLines).totalCents).toBe(19900);
  });

  it('shows "Included" rather than a blank cell for zero travel', () => {
    const b = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 3, travelBasis: 'zip_centroid' });
    const travelLine = b.lines.find((l) => l.kind === 'travel');
    expect(travelLine?.display).toBe('Included');
    expect(travelLine?.amountCents).toBe(0);
    // A zero-amount line is never persisted as a $0 charge row.
    expect(b.quoteLines.some((l) => l.kind === 'travel')).toBe(false);
  });

  it('applies each configured travel band to the total', () => {
    expect(buildPriceBreakdown({ tier: 'standard', config, travelMiles: 15 }).totalCents).toBe(19900);
    expect(buildPriceBreakdown({ tier: 'standard', config, travelMiles: 15.1 }).totalCents).toBe(19900 + 2500);
    expect(buildPriceBreakdown({ tier: 'standard', config, travelMiles: 25 }).totalCents).toBe(19900 + 2500);
    expect(buildPriceBreakdown({ tier: 'standard', config, travelMiles: 25.1 }).totalCents).toBe(19900 + 5000);
    expect(buildPriceBreakdown({ tier: 'standard', config, travelMiles: 40 }).totalCents).toBe(19900 + 5000);
  });

  it('prices each package at the owner’s stated numbers', () => {
    expect(buildPriceBreakdown({ tier: 'standard', config, travelMiles: 5 }).totalCents).toBe(19900);
    expect(buildPriceBreakdown({ tier: 'euro_luxury_performance', config, travelMiles: 5 }).totalCents).toBe(29900);
    expect(buildPriceBreakdown({ tier: 'exotic_collector', config, travelMiles: 5 }).totalCents).toBe(39900);
  });

  it('refuses a total beyond the last band instead of guessing one', () => {
    const b = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 55 });
    expect(b.totalCents).toBeNull();
    expect(b.quoteLines).toHaveLength(0);
    expect(b.lines.find((l) => l.kind === 'travel')?.display).toBe('Custom review required');
    expect(b.reviewNotes.join(' ')).toContain('custom travel amount');
  });

  it('refuses a total for an unmapped ZIP and says why', () => {
    const b = buildPriceBreakdown({ tier: 'standard', config, travelMiles: null, travelBasis: 'unknown' });
    expect(b.totalCents).toBeNull();
    expect(b.travel.customReviewRequired).toBe(true);
    expect(b.travel.basisLabel).toContain('outside the mapped service area');
  });

  it('never calls a ZIP approximation exact driving distance', () => {
    const t = describeTravel({ tier: 'standard', config, travelMiles: 18.4, travelBasis: 'zip_centroid' });
    expect(t.basisLabel).toContain('not exact driving distance');
    expect(t.basisLabel).toContain('about 18.4 miles');
  });

  it('flags a distance sitting on a fee boundary for review', () => {
    const near = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 15 - BOUNDARY_MILES + 0.1 });
    expect(near.travel.nearBoundary).toBe(true);
    expect(near.reviewNotes.join(' ')).toContain('travel-fee boundary');

    const clear = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 8 });
    expect(clear.travel.nearBoundary).toBe(false);
    expect(clear.reviewNotes).toHaveLength(0);
  });

  it('lets the owner set travel explicitly, including an intentional $0', () => {
    const free = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 60, travelCentsOverride: 0 });
    expect(free.totalCents).toBe(19900);
    expect(free.travel.basis).toBe('manual');
    expect(free.travel.bandLabel).toContain('included by AutoClarity');
    expect(free.travel.basisLabel).toContain('set by AutoClarity');

    const custom = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 60, travelCentsOverride: 7500 });
    expect(custom.totalCents).toBe(19900 + 7500);
  });

  it('carries add-ons and discounts into both the display and the stored lines', () => {
    const b = buildPriceBreakdown({
      tier: 'euro_luxury_performance',
      config,
      travelMiles: 20,
      addons: [{ label: 'Partner lift', amountCents: 5000 }],
      discountCents: 3000,
      discountLabel: 'Repeat customer',
    });
    expect(b.totalCents).toBe(29900 + 2500 + 5000 - 3000);
    expect(computeQuoteTotals(b.quoteLines).totalCents).toBe(b.totalCents);
    expect(b.lines.find((l) => l.kind === 'discount')?.display).toBe('−$30.00');
  });

  it('ignores malformed add-ons rather than corrupting a total', () => {
    const b = buildPriceBreakdown({
      tier: 'standard',
      config,
      travelMiles: 5,
      addons: [
        { label: '', amountCents: 5000 },
        { label: 'Negative', amountCents: -100 },
        { label: 'Too big', amountCents: 900_000 },
        { label: 'Fractional', amountCents: 12.5 },
      ],
    });
    expect(b.totalCents).toBe(19900);
    expect(b.lines.filter((l) => l.kind === 'addon')).toHaveLength(0);
  });

  it('honours an explicit base override without claiming a launch price', () => {
    const b = buildPriceBreakdown({ tier: 'standard', config, travelMiles: 5, baseCentsOverride: 17500 });
    expect(b.baseCents).toBe(17500);
    expect(b.promoApplied).toBe(false);
    expect(b.totalCents).toBe(17500);
  });
});

describe('travel origin', () => {
  it('measures from the AutoClarity service base, not a downtown placeholder', () => {
    // ZIP 89147 centroid. Kept server-side: the derived mileage is public,
    // the coordinates never appear in a customer-facing payload.
    expect(config.travel.originLat).toBeCloseTo(36.113, 3);
    expect(config.travel.originLng).toBeCloseTo(-115.28, 3);
    expect(config.travel.originLabel).toContain('89147');
  });
});

describe('what the customer is told about travel', () => {
  it('says travel is included without disclosing how far away they are', async () => {
    const { travelSentence } = await import('../../functions/lib/booking-proposal.ts');
    expect(travelSentence(0, 3.6)).toBe('Travel to the vehicle is included.');
    expect(travelSentence(0, null)).toBe('Travel to the vehicle is included.');
    // The distance would tell them roughly where the business is based.
    expect(travelSentence(0, 3.6)).not.toContain('3.6');
    expect(travelSentence(2500, 18.4)).not.toContain('18.4');
    expect(travelSentence(2500, 18.4)).toContain('$25.00');
    expect(travelSentence(null, null)).toContain('quoted individually');
  });
});
