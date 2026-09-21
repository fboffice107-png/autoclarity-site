// ONE price calculation, shared by every surface that shows money:
// the public intake estimate, the admin booking-proposal card, the customer
// proposal page, and the server-side checkout revalidation.
//
// Anything that displays a total imports `buildPriceBreakdown` rather than
// adding up line items of its own. That is what makes "a Standard Corolla with
// included travel shows $199 everywhere" a property of the code, not a habit.

import type { PpiConfig } from './config.ts';
import { basePriceForTier, travelFeeForMiles, type QuoteLineInput } from './pricing.ts';
import type { Tier } from './vehicle-class.ts';

export interface PriceLine {
  kind: 'base' | 'travel' | 'addon' | 'discount';
  label: string;
  /** null means "needs a custom amount before this can be quoted". */
  amountCents: number | null;
  /** What to print in the amount column when amountCents is 0. */
  display: string;
}

export interface TravelView {
  miles: number | null;
  feeCents: number | null;
  bandLabel: string;
  basis: 'zip_centroid' | 'manual' | 'unknown';
  /** Plain sentence about how exact this distance is. Never claims precision. */
  basisLabel: string;
  included: boolean;
  customReviewRequired: boolean;
  /** Within `BOUNDARY_MILES` of a band edge — worth an owner glance. */
  nearBoundary: boolean;
}

export interface PriceBreakdown {
  tier: Tier;
  tierLabel: string;
  baseCents: number;
  promoApplied: boolean;
  travel: TravelView;
  lines: PriceLine[];
  /** null when a custom travel amount is still required. */
  totalCents: number | null;
  /** Quote line inputs for persistence. Empty when the total is unresolved. */
  quoteLines: QuoteLineInput[];
  /** Review prompts for the owner (never auto-applied to price). */
  reviewNotes: string[];
}

export interface AddonInput {
  label: string;
  amountCents: number;
}

export interface PriceInput {
  tier: Tier;
  config: PpiConfig;
  /** Explicit base override in cents; falls back to the configured tier price. */
  baseCentsOverride?: number | null;
  travelMiles?: number | null;
  travelBasis?: 'zip_centroid' | 'manual' | 'unknown';
  /** Explicit travel amount in cents, overriding the banded suggestion. */
  travelCentsOverride?: number | null;
  addons?: AddonInput[];
  discountCents?: number;
  discountLabel?: string;
  now?: Date;
}

/** Distance from a band edge that earns an owner glance before sending. */
export const BOUNDARY_MILES = 2;

const TRAVEL_LABEL = 'Mobile-service charge';

function basisSentence(basis: TravelView['basis'], miles: number | null): string {
  if (basis === 'manual') return 'Distance set by AutoClarity for this address.';
  if (basis === 'zip_centroid') {
    if (miles === null) return 'Distance could not be estimated from this ZIP code.';
    // "about 0 miles" is the literal truth for the service-base ZIP and reads
    // like a bug, so say the useful thing instead.
    if (miles < 1) return 'This is inside AutoClarity\u2019s own service area.';
    return `Estimated from the ZIP code \u2014 about ${miles} miles, not exact driving distance.`;
  }
  return 'This address is outside the mapped service area, so AutoClarity reviews the travel charge.';
}

export function describeTravel(input: PriceInput): TravelView {
  const { config } = input;
  const basis = input.travelBasis ?? (input.travelMiles === null || input.travelMiles === undefined ? 'unknown' : 'zip_centroid');
  const miles = typeof input.travelMiles === 'number' && Number.isFinite(input.travelMiles) ? input.travelMiles : null;

  // An explicit amount from the owner always wins and is never "estimated".
  if (typeof input.travelCentsOverride === 'number' && Number.isSafeInteger(input.travelCentsOverride) && input.travelCentsOverride >= 0) {
    const fee = input.travelCentsOverride;
    return {
      miles,
      feeCents: fee,
      bandLabel: fee === 0 ? 'Travel included by AutoClarity' : 'Travel set by AutoClarity',
      basis: 'manual',
      basisLabel: basisSentence('manual', miles),
      included: fee === 0,
      customReviewRequired: false,
      nearBoundary: false,
    };
  }

  if (miles === null) {
    return {
      miles: null,
      feeCents: null,
      bandLabel: 'Outside mapped service area — custom review',
      basis: 'unknown',
      basisLabel: basisSentence('unknown', null),
      included: false,
      customReviewRequired: true,
      nearBoundary: false,
    };
  }

  const band = travelFeeForMiles(miles, config);
  const edges = config.travel.bands.map((b) => b.maxMiles);
  const nearBoundary = edges.some((edge) => Math.abs(miles - edge) <= BOUNDARY_MILES);

  return {
    miles,
    feeCents: band.feeCents,
    bandLabel: band.bandLabel,
    basis,
    basisLabel: basisSentence(basis, miles),
    included: band.feeCents === 0,
    customReviewRequired: band.feeCents === null,
    nearBoundary,
  };
}

export function buildPriceBreakdown(input: PriceInput): PriceBreakdown {
  const { config, tier } = input;
  const now = input.now ?? new Date();
  const tierCfg = config.pricing.tiers[tier];
  const tierBase = basePriceForTier(tier, config, now);

  const baseCents = typeof input.baseCentsOverride === 'number'
    && Number.isSafeInteger(input.baseCentsOverride)
    && input.baseCentsOverride > 0
    ? input.baseCentsOverride
    : tierBase.priceCents;
  const promoApplied = tierBase.promoApplied && baseCents === tierBase.priceCents;

  const travel = describeTravel(input);
  const reviewNotes: string[] = [];

  const baseLabel = `${tierCfg.label}${promoApplied ? ' (launch price)' : ''}`;
  const lines: PriceLine[] = [
    { kind: 'base', label: baseLabel, amountCents: baseCents, display: formatMoney(baseCents) },
  ];

  // Travel is ALWAYS a visible line. "Included" is information; a blank row is
  // a placeholder that hides the price, which is what we are removing.
  lines.push({
    kind: 'travel',
    label: TRAVEL_LABEL,
    amountCents: travel.feeCents,
    display: travel.feeCents === null
      ? 'Custom review required'
      : travel.feeCents === 0
        ? 'Included'
        : formatMoney(travel.feeCents),
  });

  if (travel.customReviewRequired) {
    reviewNotes.push('This location needs a custom travel amount before a total can be offered.');
  } else if (travel.nearBoundary) {
    reviewNotes.push(
      `Estimated ${travel.miles} miles is within ${BOUNDARY_MILES} miles of a travel-fee boundary — confirm the distance before sending.`,
    );
  }

  const addons = (input.addons ?? []).filter(
    (a) => a.label.trim() && Number.isSafeInteger(a.amountCents) && a.amountCents > 0 && a.amountCents <= 500_000,
  );
  for (const addon of addons) {
    lines.push({ kind: 'addon', label: addon.label.trim(), amountCents: addon.amountCents, display: formatMoney(addon.amountCents) });
  }

  const discountCents = Number.isSafeInteger(input.discountCents) && (input.discountCents ?? 0) > 0 ? (input.discountCents as number) : 0;
  if (discountCents > 0) {
    const label = (input.discountLabel ?? '').trim() || 'Discount';
    lines.push({ kind: 'discount', label, amountCents: -discountCents, display: `−${formatMoney(discountCents)}` });
  }

  if (travel.feeCents === null) {
    return {
      tier, tierLabel: tierCfg.label, baseCents, promoApplied, travel, lines,
      totalCents: null, quoteLines: [], reviewNotes,
    };
  }

  const quoteLines: QuoteLineInput[] = [{ kind: 'base', label: baseLabel, amountCents: baseCents }];
  if (travel.feeCents > 0) quoteLines.push({ kind: 'travel', label: TRAVEL_LABEL, amountCents: travel.feeCents });
  for (const addon of addons) quoteLines.push({ kind: 'addon', label: addon.label.trim(), amountCents: addon.amountCents });
  if (discountCents > 0) {
    quoteLines.push({ kind: 'discount', label: (input.discountLabel ?? '').trim() || 'Discount', amountCents: -discountCents });
  }

  const totalCents = baseCents + travel.feeCents + addons.reduce((sum, a) => sum + a.amountCents, 0) - discountCents;

  return {
    tier,
    tierLabel: tierCfg.label,
    baseCents,
    promoApplied,
    travel,
    lines,
    totalCents: Number.isSafeInteger(totalCents) && totalCents > 0 ? totalCents : null,
    quoteLines,
    reviewNotes,
  };
}

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
