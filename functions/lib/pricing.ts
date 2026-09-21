// Quote money: tier base prices, travel banding, totals, expiry and the
// cancellation policy calculator.
//
// Vehicle CLASSIFICATION lives in vehicle-class.ts and is re-exported here so
// existing importers keep working. Classification suggests; it never prices.

export type { Tier, VehicleFacts, TierSuggestion } from './vehicle-class.ts';
export { suggestTier, tierMismatch, isTier } from './vehicle-class.ts';

import type { Tier } from './vehicle-class.ts';
import type { PpiConfig } from './config.ts';
import { promoActive, launchActive } from './config.ts';
import { estimateMilesFromZip } from './zips.ts';

// ------------------------------------------------------------------ travel

export interface TravelEstimate {
  miles: number | null;
  feeCents: number | null; // null → custom review required
  bandLabel: string;
  basis: 'zip_centroid' | 'unknown';
}

export function travelFeeForMiles(miles: number, config: PpiConfig): { feeCents: number | null; bandLabel: string } {
  for (const band of config.travel.bands) {
    if (miles <= band.maxMiles) {
      return {
        feeCents: band.feeCents,
        bandLabel: band.feeCents === 0 ? `0–${band.maxMiles} miles — included` : `≤${band.maxMiles} miles`,
      };
    }
  }
  return { feeCents: null, bandLabel: `Beyond ${config.travel.customBeyondMiles} miles — custom review` };
}

export function estimateTravel(zip: string, config: PpiConfig): TravelEstimate {
  const miles = estimateMilesFromZip(zip, config.travel.originLat, config.travel.originLng);
  if (miles === null) {
    return { miles: null, feeCents: null, bandLabel: 'Outside mapped service area — custom review', basis: 'unknown' };
  }
  const { feeCents, bandLabel } = travelFeeForMiles(miles, config);
  return { miles, feeCents, bandLabel, basis: 'zip_centroid' };
}

// ------------------------------------------------------------------- quotes

export interface QuoteLineInput {
  kind: 'base' | 'travel' | 'addon' | 'discount';
  label: string;
  amountCents: number; // discounts negative
}

export interface QuoteTotals {
  subtotalCents: number;
  travelCents: number;
  addonsCents: number;
  discountCents: number; // stored positive
  totalCents: number;
}

export function computeQuoteTotals(lines: QuoteLineInput[]): QuoteTotals {
  if (lines.length === 0) throw new Error('Quote must contain line items');
  let subtotal = 0;
  let travel = 0;
  let addons = 0;
  let discount = 0;
  let baseLines = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountCents)) {
      throw new Error('Quote line amounts must be safe integer cents');
    }
    if (line.kind === 'discount') {
      if (line.amountCents >= 0) throw new Error('Discount line amounts must be negative');
    } else if (line.amountCents < 0) {
      throw new Error('Charge line amounts cannot be negative');
    }
    switch (line.kind) {
      case 'base':
        baseLines++;
        subtotal += line.amountCents;
        break;
      case 'travel':
        travel += line.amountCents;
        break;
      case 'addon':
        addons += line.amountCents;
        break;
      case 'discount':
        discount -= line.amountCents;
        break;
    }
    if (![subtotal, travel, addons, discount].every(Number.isSafeInteger)) {
      throw new Error('Quote components exceed safe integer cents');
    }
  }
  if (baseLines !== 1 || subtotal <= 0) throw new Error('Quote must contain one positive base line');
  const total = subtotal + travel + addons - discount;
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Quote total must be positive safe integer cents');
  return { subtotalCents: subtotal, travelCents: travel, addonsCents: addons, discountCents: discount, totalCents: total };
}

export function basePriceForTier(tier: Tier, config: PpiConfig, now = new Date()): { priceCents: number; promoApplied: boolean } {
  const tierCfg = config.pricing.tiers[tier];
  // Time-boxed introductory launch price applies per tier when configured.
  if (launchActive(config, now) && typeof tierCfg.launchPriceCents === 'number' && tierCfg.launchPriceCents < tierCfg.priceCents) {
    return { priceCents: tierCfg.launchPriceCents, promoApplied: true };
  }
  // Legacy standard-tier promo (retained for back-compat).
  if (tier === 'standard' && promoActive(config, now) && config.pricing.promo.priceCents < tierCfg.priceCents) {
    return { priceCents: config.pricing.promo.priceCents, promoApplied: true };
  }
  return { priceCents: tierCfg.priceCents, promoApplied: false };
}

export function quoteExpiry(config: PpiConfig, from = new Date()): string {
  return new Date(from.getTime() + config.quotes.expiryHours * 3600_000).toISOString();
}

export function quoteExpired(expiresAt: string, now = new Date()): boolean {
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && now.getTime() > t;
}

// -------------------------------------------------------------- cancellation

export type CancellationOutcome =
  | { kind: 'refund_or_reschedule'; label: string }
  | { kind: 'one_free_reschedule'; label: string }
  | { kind: 'admin_review'; label: string };

function formatHours(hours: number): string {
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * Policy calculator. Late/exceptional cases always land on admin_review —
 * the system never auto-forfeits a customer's money.
 */
export function cancellationOutcome(appointmentAtIso: string, config: PpiConfig, now = new Date()): CancellationOutcome {
  const hoursUntil = (new Date(appointmentAtIso).getTime() - now.getTime()) / 3600_000;
  if (hoursUntil >= config.cancellation.fullRefundHours) {
    return {
      kind: 'refund_or_reschedule',
      label: `${formatHours(config.cancellation.fullRefundHours)} or more before the appointment — full refund or free rescheduling.`,
    };
  }
  if (hoursUntil >= config.cancellation.rescheduleHours) {
    return {
      kind: 'one_free_reschedule',
      label: `At least ${formatHours(config.cancellation.rescheduleHours)} but less than ${formatHours(config.cancellation.fullRefundHours)} before the appointment — one free reschedule.`,
    };
  }
  return {
    kind: 'admin_review',
    label: `Less than ${formatHours(config.cancellation.rescheduleHours)} before the appointment — reviewed personally; a transferable service credit may be offered.`,
  };
}
