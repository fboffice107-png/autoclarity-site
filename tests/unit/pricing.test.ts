import { describe, expect, it } from 'vitest';
import {
  suggestTier,
  tierMismatch,
  travelFeeForMiles,
  estimateTravel,
  computeQuoteTotals,
  basePriceForTier,
  quoteExpired,
  quoteExpiry,
  cancellationOutcome,
  type VehicleFacts,
} from '../../functions/lib/pricing.ts';
import { DEFAULT_CONFIG, promoActive, launchActive, patchTouchesPublicFacts, tierDisplayPrice, type PpiConfig } from '../../functions/lib/config.ts';

const NOW = new Date('2026-07-21T12:00:00Z');

describe('production public-fact config gate', () => {
  it('identifies runtime patches that would drift visible and machine-readable facts', () => {
    expect(patchTouchesPublicFacts({ pricing: { launch: { enabled: true } } })).toBe(true);
    expect(patchTouchesPublicFacts({ travel: { customBeyondMiles: 50 } })).toBe(true);
    expect(patchTouchesPublicFacts({ supportEmail: 'other@example.com' })).toBe(true);
    expect(patchTouchesPublicFacts({ scheduling: { holdMinutes: 45 } })).toBe(false);
    expect(patchTouchesPublicFacts(null)).toBe(false);
  });
});

function vehicle(overrides: Partial<VehicleFacts>): VehicleFacts {
  return {
    year: 2019,
    make: 'Toyota',
    model: 'Camry',
    trim: 'SE',
    modStatus: 'stock',
    titleStatus: 'clean',
    startsDrives: 'yes',
    ...overrides,
  };
}

describe('suggestTier', () => {
  it('classifies a stock Camry as standard', () => {
    const s = suggestTier(vehicle({}), NOW);
    expect(s.tier).toBe('standard');
    expect(s.manualReview).toBe(false);
  });

  it('classifies a Corvette as performance regardless of price', () => {
    const s = suggestTier(vehicle({ make: 'Chevrolet', model: 'Corvette', trim: 'Grand Sport' }), NOW);
    expect(s.tier).toBe('euro_luxury_performance');
  });

  it('classifies BMW as euro/luxury', () => {
    expect(suggestTier(vehicle({ make: 'BMW', model: '540i' }), NOW).tier).toBe('euro_luxury_performance');
  });

  it('classifies a Lamborghini as exotic with manual review', () => {
    const s = suggestTier(vehicle({ make: 'Lamborghini', model: 'Huracán EVO' }), NOW);
    expect(s.tier).toBe('exotic_collector');
    expect(s.manualReview).toBe(true);
  });

  // Modifications and age used to jump the tier by themselves, which meant a
  // modified Civic and a 2001 Corolla both silently became $399 quotes with no
  // stated reason. They now produce a written review note and a review ceiling
  // instead; the owner decides, and the customer is told why.
  it('flags heavy modifications for review WITHOUT raising the price by itself', () => {
    const s = suggestTier(vehicle({ make: 'Honda', model: 'Civic', modStatus: 'heavy', modDetails: 'turbo kit, coilovers' }), NOW);
    expect(s.tier).toBe('standard');
    expect(s.manualReview).toBe(true);
    expect(s.reviewCeiling).toBe('exotic_collector');
    expect(s.manualReasons.join(' ')).toContain('turbo kit, coilovers');
    expect(s.customerNotes.join(' ')).toContain('before you pay');
  });

  it('shows what was actually modified for a lightly modified vehicle', () => {
    const s = suggestTier(vehicle({ modStatus: 'light', modDetails: 'aftermarket wheels' }), NOW);
    expect(s.tier).toBe('standard');
    expect(s.reasons.join(' ')).toContain('aftermarket wheels');
    expect(s.customerNotes.join(' ')).toContain('aftermarket wheels');
  });

  it('asks what was modified when the detail is missing', () => {
    const s = suggestTier(vehicle({ modStatus: 'light', modDetails: '' }), NOW);
    expect(s.manualReview).toBe(true);
    expect(s.manualReasons.join(' ')).toContain('no modification details');
  });

  it('flags an old vehicle for collector review without charging collector prices', () => {
    const s = suggestTier(vehicle({ year: 1990, make: 'Toyota', model: 'Corolla' }), NOW);
    expect(s.tier).toBe('standard');
    expect(s.manualReview).toBe(true);
    expect(s.reviewCeiling).toBe('exotic_collector');
  });

  it('flags salvage titles and non-runners for manual review without hiding tier', () => {
    const s = suggestTier(vehicle({ titleStatus: 'salvage_rebuilt', startsDrives: 'no' }), NOW);
    expect(s.tier).toBe('standard');
    expect(s.manualReview).toBe(true);
    expect(s.manualReasons.length).toBeGreaterThanOrEqual(2);
  });

  it('detects performance trims on otherwise standard makes', () => {
    const s = suggestTier(vehicle({ make: 'Cadillac', model: 'CT5', trim: 'V-Series Blackwing' }), NOW);
    expect(s.tier).toBe('euro_luxury_performance');
  });
});

describe('travel fees', () => {
  it('applies the configured bands', () => {
    expect(travelFeeForMiles(0, DEFAULT_CONFIG).feeCents).toBe(0);
    expect(travelFeeForMiles(15, DEFAULT_CONFIG).feeCents).toBe(0);
    expect(travelFeeForMiles(15.1, DEFAULT_CONFIG).feeCents).toBe(2500);
    expect(travelFeeForMiles(25, DEFAULT_CONFIG).feeCents).toBe(2500);
    expect(travelFeeForMiles(26, DEFAULT_CONFIG).feeCents).toBe(5000);
    expect(travelFeeForMiles(40, DEFAULT_CONFIG).feeCents).toBe(5000);
  });

  it('returns custom review beyond the last band', () => {
    expect(travelFeeForMiles(41, DEFAULT_CONFIG).feeCents).toBeNull();
  });

  it('estimates central Las Vegas ZIPs inside the included band', () => {
    const est = estimateTravel('89109', DEFAULT_CONFIG);
    expect(est.miles).not.toBeNull();
    expect(est.feeCents).toBe(0);
  });

  it('sends unknown ZIPs to custom review', () => {
    const est = estimateTravel('10001', DEFAULT_CONFIG);
    expect(est.miles).toBeNull();
    expect(est.feeCents).toBeNull();
    expect(est.basis).toBe('unknown');
  });

  it('sends far ZIPs (Mesquite) to custom review', () => {
    expect(estimateTravel('89027', DEFAULT_CONFIG).feeCents).toBeNull();
  });
});

describe('quote totals', () => {
  it('sums base + travel + addons - discount', () => {
    const totals = computeQuoteTotals([
      { kind: 'base', label: 'Standard', amountCents: 19900 },
      { kind: 'travel', label: 'Mobile-service charge', amountCents: 2500 },
      { kind: 'addon', label: 'Partner lift', amountCents: 5000 },
      { kind: 'discount', label: 'Launch', amountCents: -3000 },
    ]);
    expect(totals.totalCents).toBe(24400);
    expect(totals.discountCents).toBe(3000);
  });

  it('refuses negative totals', () => {
    expect(() =>
      computeQuoteTotals([
        { kind: 'base', label: 'Standard', amountCents: 1000 },
        { kind: 'discount', label: 'Bad', amountCents: -2000 },
      ]),
    ).toThrow();
  });

  it('refuses zero-dollar quotes', () => {
    expect(() =>
      computeQuoteTotals([
        { kind: 'base', label: 'Standard', amountCents: 1000 },
        { kind: 'discount', label: 'Invalid free quote', amountCents: -1000 },
      ]),
    ).toThrow(/positive/);
  });

  it('refuses unsafe cents and inverted line signs', () => {
    expect(() => computeQuoteTotals([
      { kind: 'base', label: 'Unsafe', amountCents: Number.MAX_SAFE_INTEGER + 1 },
    ])).toThrow(/safe integer/);
    expect(() => computeQuoteTotals([
      { kind: 'base', label: 'Standard', amountCents: -19900 },
    ])).toThrow(/cannot be negative/);
    expect(() => computeQuoteTotals([
      { kind: 'base', label: 'Standard', amountCents: 19900 },
      { kind: 'discount', label: 'Wrong sign', amountCents: 1000 },
    ])).toThrow(/must be negative/);
  });

  it('requires exactly one positive base line', () => {
    expect(() => computeQuoteTotals([
      { kind: 'addon', label: 'Only an add-on', amountCents: 5000 },
    ])).toThrow(/one positive base/);
    expect(() => computeQuoteTotals([
      { kind: 'base', label: 'One', amountCents: 19900 },
      { kind: 'base', label: 'Two', amountCents: 19900 },
    ])).toThrow(/one positive base/);
  });
});

describe('promo pricing', () => {
  const promoConfig: PpiConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  promoConfig.pricing.promo.enabled = true;
  promoConfig.pricing.promo.endsAt = '2026-08-01T00:00:00Z';

  it('applies the promo to standard tier only while active', () => {
    expect(basePriceForTier('standard', promoConfig, NOW)).toEqual({ priceCents: 14900, promoApplied: true });
    expect(basePriceForTier('euro_luxury_performance', promoConfig, NOW).promoApplied).toBe(false);
    expect(tierDisplayPrice(promoConfig, 'standard', NOW)).toEqual({
      priceCents: 14900,
      wasCents: 19900,
      startingAt: true,
    });
  });

  it('expires the promo after endsAt — no permanent fake discount', () => {
    const after = new Date('2026-09-01T00:00:00Z');
    expect(promoActive(promoConfig, after)).toBe(false);
    expect(basePriceForTier('standard', promoConfig, after)).toEqual({ priceCents: 19900, promoApplied: false });
  });

  it('never activates the legacy promo without a real future end date', () => {
    const noEnd: PpiConfig = JSON.parse(JSON.stringify(promoConfig));
    noEnd.pricing.promo.endsAt = null;
    expect(promoActive(noEnd, NOW)).toBe(false);
    expect(basePriceForTier('standard', noEnd, NOW)).toEqual({ priceCents: 19900, promoApplied: false });
    expect(tierDisplayPrice(noEnd, 'standard', NOW).wasCents).toBeNull();
  });
});

describe('launch pricing (introductory, time-boxed)', () => {
  function launchCfg(overrides: Partial<{ enabled: boolean; startsAt: string | null; endsAt: string | null }> = {}): PpiConfig {
    const c: PpiConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    c.pricing.launch = { enabled: true, startsAt: null, endsAt: '2026-08-31T00:00:00Z', ...overrides };
    return c;
  }

  it('is inactive by default (no permanent fake discount)', () => {
    expect(launchActive(DEFAULT_CONFIG, NOW)).toBe(false);
    const disp = tierDisplayPrice(DEFAULT_CONFIG, 'standard', NOW);
    expect(disp.priceCents).toBe(19900);
    expect(disp.wasCents).toBeNull();
  });

  it('never activates without a real end date (permanent-sale guard)', () => {
    expect(launchActive(launchCfg({ endsAt: null }), NOW)).toBe(false);
    expect(launchActive(launchCfg({ endsAt: 'not-a-date' }), NOW)).toBe(false);
    expect(tierDisplayPrice(launchCfg({ endsAt: null }), 'standard', NOW).wasCents).toBeNull();
  });

  it('applies introductory prices per tier while the window is active', () => {
    const cfg = launchCfg();
    expect(launchActive(cfg, NOW)).toBe(true);
    expect(tierDisplayPrice(cfg, 'standard', NOW)).toEqual({ priceCents: 14900, wasCents: 19900, startingAt: true });
    expect(tierDisplayPrice(cfg, 'euro_luxury_performance', NOW)).toEqual({ priceCents: 24900, wasCents: 29900, startingAt: true });
  });

  it('exotic tier has no launch price and stays "starting at"', () => {
    const disp = tierDisplayPrice(launchCfg(), 'exotic_collector', NOW);
    expect(disp.priceCents).toBe(39900);
    expect(disp.wasCents).toBeNull();
    expect(disp.startingAt).toBe(true);
  });

  it('respects the start and end of the window', () => {
    const before = new Date('2026-07-01T00:00:00Z');
    const after = new Date('2026-09-15T00:00:00Z');
    const cfg = launchCfg({ startsAt: '2026-07-15T00:00:00Z' });
    expect(launchActive(cfg, before)).toBe(false);
    expect(launchActive(cfg, after)).toBe(false);
    expect(tierDisplayPrice(cfg, 'standard', after).wasCents).toBeNull();
  });

  it('basePriceForTier uses the launch price when active', () => {
    expect(basePriceForTier('standard', launchCfg(), NOW)).toEqual({ priceCents: 14900, promoApplied: true });
    expect(basePriceForTier('euro_luxury_performance', launchCfg(), NOW).priceCents).toBe(24900);
  });
});

describe('quote expiry', () => {
  it('defaults to 48 hours out', () => {
    const iso = quoteExpiry(DEFAULT_CONFIG, NOW);
    expect(new Date(iso).getTime() - NOW.getTime()).toBe(48 * 3600_000);
  });
  it('detects expiry', () => {
    expect(quoteExpired('2026-07-21T11:59:00Z', NOW)).toBe(true);
    expect(quoteExpired('2026-07-21T12:01:00Z', NOW)).toBe(false);
  });
});

describe('cancellation policy calculator', () => {
  const appt = (hours: number) => new Date(NOW.getTime() + hours * 3600_000).toISOString();
  it('>=48h: refund or reschedule', () => {
    expect(cancellationOutcome(appt(72), DEFAULT_CONFIG, NOW).kind).toBe('refund_or_reschedule');
    expect(cancellationOutcome(appt(48), DEFAULT_CONFIG, NOW).kind).toBe('refund_or_reschedule');
  });
  it('24-48h: one free reschedule', () => {
    expect(cancellationOutcome(appt(47.9), DEFAULT_CONFIG, NOW).kind).toBe('one_free_reschedule');
    expect(cancellationOutcome(appt(24), DEFAULT_CONFIG, NOW).kind).toBe('one_free_reschedule');
  });
  it('<24h: never auto-forfeits — admin review', () => {
    expect(cancellationOutcome(appt(5), DEFAULT_CONFIG, NOW).kind).toBe('admin_review');
    expect(cancellationOutcome(appt(-1), DEFAULT_CONFIG, NOW).kind).toBe('admin_review');
  });

  it('renders thresholds from configuration instead of hard-coded hours', () => {
    const configured: PpiConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    configured.cancellation.fullRefundHours = 72;
    configured.cancellation.rescheduleHours = 36;
    expect(cancellationOutcome(appt(72), configured, NOW).label).toContain('72 hours or more');
    expect(cancellationOutcome(appt(48), configured, NOW).label).toContain('At least 36 hours');
    expect(cancellationOutcome(appt(12), configured, NOW).label).toContain('Less than 36 hours');
  });
});

// The owner's stated categories, written as tests so a future rules edit has to
// argue with them: a normal Corolla is Standard, a Corvette or a typical
// Mercedes/BMW/Audi is Luxury & Performance, a Bentley/Ferrari/Lamborghini/
// McLaren is Exotic — and manufacturer alone is never sufficient.
describe('owner business categories', () => {
  const cases: Array<[Partial<VehicleFacts>, string]> = [
    [{ make: 'Toyota', model: 'Corolla', trim: 'LE' }, 'standard'],
    [{ make: 'Chevrolet', model: 'Malibu', trim: 'RS' }, 'standard'],
    [{ make: 'Dodge', model: 'Grand Caravan', trim: 'SXT' }, 'standard'],
    [{ make: 'Kia', model: 'Sorento', trim: 'EX' }, 'standard'],
    [{ make: 'Hyundai', model: 'Elantra', trim: 'SEL' }, 'standard'],
    [{ make: 'Chevrolet', model: 'Corvette', trim: 'Stingray' }, 'euro_luxury_performance'],
    [{ make: 'Mercedes-Benz', model: 'C300', trim: '4MATIC' }, 'euro_luxury_performance'],
    [{ make: 'BMW', model: '330i', trim: 'M Sport' }, 'euro_luxury_performance'],
    [{ make: 'Audi', model: 'A4', trim: 'Premium Plus' }, 'euro_luxury_performance'],
    [{ make: 'Bentley', model: 'Continental GT', trim: 'V8' }, 'exotic_collector'],
    [{ make: 'Ferrari', model: '488', trim: 'GTB' }, 'exotic_collector'],
    [{ make: 'Lamborghini', model: 'Urus', trim: '' }, 'exotic_collector'],
    [{ make: 'McLaren', model: '720S', trim: '' }, 'exotic_collector'],
  ];
  for (const [facts, expected] of cases) {
    it(`${facts.make} ${facts.model} ${facts.trim ?? ''} → ${expected}`.trim(), () => {
      expect(suggestTier(vehicle(facts), NOW).tier).toBe(expected);
    });
  }
});

describe('model-specific exceptions (manufacturer alone is insufficient)', () => {
  it('keeps a mainstream Volkswagen in Standard but raises the GTI and R', () => {
    expect(suggestTier(vehicle({ make: 'Volkswagen', model: 'Jetta', trim: 'S' }), NOW).tier).toBe('standard');
    expect(suggestTier(vehicle({ make: 'Volkswagen', model: 'Tiguan', trim: 'SE' }), NOW).tier).toBe('standard');
    expect(suggestTier(vehicle({ make: 'Volkswagen', model: 'Golf', trim: 'GTI Autobahn' }), NOW).tier).toBe('euro_luxury_performance');
  });

  it('separates a base Camaro/Charger/Mustang from its performance trims', () => {
    expect(suggestTier(vehicle({ make: 'Chevrolet', model: 'Camaro', trim: '1LT' }), NOW).tier).toBe('standard');
    expect(suggestTier(vehicle({ make: 'Chevrolet', model: 'Camaro', trim: 'SS' }), NOW).tier).toBe('euro_luxury_performance');
    expect(suggestTier(vehicle({ make: 'Dodge', model: 'Charger', trim: 'SXT' }), NOW).tier).toBe('standard');
    expect(suggestTier(vehicle({ make: 'Dodge', model: 'Charger', trim: 'Scat Pack' }), NOW).tier).toBe('euro_luxury_performance');
    expect(suggestTier(vehicle({ make: 'Ford', model: 'Mustang', trim: 'EcoBoost' }), NOW).tier).toBe('standard');
    expect(suggestTier(vehicle({ make: 'Ford', model: 'Mustang', trim: 'GT Premium' }), NOW).tier).toBe('euro_luxury_performance');
  });

  it('does not treat an appearance package as a performance drivetrain', () => {
    // "RS" on a Trailblazer is trim styling; it used to cost the customer $100.
    expect(suggestTier(vehicle({ make: 'Chevrolet', model: 'Trailblazer', trim: 'RS' }), NOW).tier).toBe('standard');
    expect(suggestTier(vehicle({ make: 'Chevrolet', model: 'Equinox', trim: 'RS' }), NOW).tier).toBe('standard');
    // But RS on an Audi is a genuinely different car.
    expect(suggestTier(vehicle({ make: 'Audi', model: 'RS5', trim: '' }), NOW).tier).toBe('euro_luxury_performance');
  });

  it('routes the halo models of mainstream makes to exotic', () => {
    expect(suggestTier(vehicle({ make: 'Ford', model: 'GT', trim: '' }), NOW).tier).toBe('exotic_collector');
    expect(suggestTier(vehicle({ make: 'Acura', model: 'NSX', trim: '' }), NOW).tier).toBe('exotic_collector');
  });

  it('keeps entry near-luxury on a mainstream platform in Standard', () => {
    expect(suggestTier(vehicle({ make: 'Lexus', model: 'ES', trim: '350' }), NOW).tier).toBe('standard');
    expect(suggestTier(vehicle({ make: 'Lexus', model: 'ES', trim: '350 F Sport' }), NOW).tier).toBe('euro_luxury_performance');
    expect(suggestTier(vehicle({ make: 'Lexus', model: 'LX', trim: '600' }), NOW).tier).toBe('euro_luxury_performance');
  });

  it('accepts the make spellings customers actually type', () => {
    expect(suggestTier(vehicle({ make: 'chevy', model: 'Corvette' }), NOW).tier).toBe('euro_luxury_performance');
    expect(suggestTier(vehicle({ make: 'Mercedes', model: 'GLC300' }), NOW).tier).toBe('euro_luxury_performance');
    expect(suggestTier(vehicle({ make: 'VW', model: 'Jetta' }), NOW).tier).toBe('standard');
  });

  it('always gives the customer a sentence they can read', () => {
    const s = suggestTier(vehicle({ make: 'Toyota', model: 'Corolla' }), NOW);
    expect(s.customerReason.length).toBeGreaterThan(10);
    expect(s.customerReason).not.toContain('_');
  });
});

describe('customer package selection', () => {
  it('reports no mismatch when the customer keeps the suggestion', () => {
    expect(tierMismatch('standard', 'standard')).toBeNull();
  });
  it('flags a lower pick for review rather than overriding it', () => {
    const m = tierMismatch('euro_luxury_performance', 'standard');
    expect(m?.direction).toBe('lower');
    expect(m?.note).toContain('Check the vehicle');
    // Internal tier keys must never surface in owner-facing text.
    expect(m?.note).not.toContain('euro_luxury_performance');
  });
  it('flags a higher pick so nobody is overcharged by accident', () => {
    const m = tierMismatch('standard', 'exotic_collector');
    expect(m?.direction).toBe('higher');
    expect(m?.note).toContain('genuinely needed');
  });
});
