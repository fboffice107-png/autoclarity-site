import { describe, expect, it } from 'vitest';
import {
  suggestTier,
  travelFeeForMiles,
  estimateTravel,
  computeQuoteTotals,
  basePriceForTier,
  quoteExpired,
  quoteExpiry,
  cancellationOutcome,
  type VehicleFacts,
} from '../../functions/lib/pricing.ts';
import { DEFAULT_CONFIG, promoActive, launchActive, tierDisplayPrice, type PpiConfig } from '../../functions/lib/config.ts';

const NOW = new Date('2026-07-21T12:00:00Z');

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

  it('bumps heavily modified standard vehicles up a tier with manual review', () => {
    const s = suggestTier(vehicle({ make: 'Honda', model: 'Civic', modStatus: 'heavy' }), NOW);
    expect(s.tier).toBe('exotic_collector');
    expect(s.manualReview).toBe(true);
  });

  it('treats 25+ year old vehicles as collector', () => {
    const s = suggestTier(vehicle({ year: 1999, make: 'Mazda', model: 'Miata' }), NOW);
    expect(s.tier).toBe('exotic_collector');
    expect(s.manualReview).toBe(true);
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
