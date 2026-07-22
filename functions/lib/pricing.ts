// Rule-assisted quoting. The engine SUGGESTS a tier and travel band from
// vehicle complexity (never purchase price alone); the admin always reviews
// and can override before a quote is sent.

import type { PpiConfig } from './config.ts';
import { promoActive, launchActive } from './config.ts';
import { estimateMilesFromZip } from './zips.ts';

export type Tier = 'standard' | 'euro_luxury_performance' | 'exotic_collector';

export interface VehicleFacts {
  year: number | null;
  make: string;
  model: string;
  trim: string;
  modStatus: 'stock' | 'light' | 'heavy';
  titleStatus: 'clean' | 'salvage_rebuilt' | 'unknown';
  startsDrives: 'yes' | 'no' | 'unknown';
}

export interface TierSuggestion {
  tier: Tier;
  reasons: string[]; // admin-facing explanation; never shown to the customer
  manualReview: boolean;
  manualReasons: string[];
}

const EXOTIC_MAKES = [
  'ferrari', 'lamborghini', 'mclaren', 'aston martin', 'bentley', 'rolls-royce', 'rolls royce',
  'maserati', 'lotus', 'bugatti', 'koenigsegg', 'pagani', 'alfa romeo', 'fisker', 'rimac', 'de tomaso',
];

const EURO_LUX_MAKES = [
  'bmw', 'mercedes-benz', 'mercedes', 'audi', 'porsche', 'land rover', 'range rover', 'jaguar',
  'volvo', 'volkswagen', 'mini', 'smart', 'saab', 'genesis', 'lexus', 'infiniti', 'acura',
  'cadillac', 'lincoln', 'tesla', 'rivian', 'lucid', 'polestar',
];

// Model names that are performance vehicles regardless of price.
const PERFORMANCE_MODELS = [
  'corvette', 'viper', 'gt-r', 'gtr', 'supra', 'nsx', 'stingray', 'z06', 'zr1', 'shelby',
  'gt350', 'gt500', 'hellcat', 'demon', 'trackhawk', 'raptor', 'trx', 'type r', 'civic si',
  'wrx', 'sti', 'evolution', 'evo', 'golf r', 'gti', 'focus rs', 'focus st', 'veloster n',
  'elantra n', 'camaro ss', 'zl1', '370z', '350z', 'z nismo', 'mustang gt', 'challenger',
  'charger', 'cayman', 'boxster', '911', 'm2', 'm3', 'm4', 'm5', 'm8', 'rs3', 'rs5', 'rs6', 'rs7',
  's2000', 'miata', 'mx-5', 'rx-7', 'rx-8', 'gr86', 'brz', 'gr corolla',
];

// Trim markers that indicate performance/complexity variants.
const PERFORMANCE_TRIM_MARKERS = [
  'amg', ' m sport', 'm performance', 'rs', 's-line', 'quadrifoglio', 'srt', 'ss ', 'gt3', 'gt4',
  'turbo s', 'gts', 'nismo', 'type s', 'red sport', 'blackwing', 'v-series', 'trd pro', 'plaid',
  'performance', 'track', 'competition', 'black series', 'john cooper works', 'jcw', 'n line',
];

function containsAny(haystack: string, needles: string[]): string | null {
  for (const n of needles) if (haystack.includes(n)) return n.trim();
  return null;
}

export function suggestTier(v: VehicleFacts, now = new Date()): TierSuggestion {
  const make = v.make.toLowerCase().trim();
  const model = v.model.toLowerCase().trim();
  const trim = v.trim.toLowerCase().trim();
  const reasons: string[] = [];
  const manualReasons: string[] = [];
  let tier: Tier = 'standard';

  const exoticHit = containsAny(make, EXOTIC_MAKES);
  const euroLuxHit = containsAny(make, EURO_LUX_MAKES);
  const perfModelHit = containsAny(` ${model} `, PERFORMANCE_MODELS);
  const perfTrimHit = containsAny(` ${trim} `, PERFORMANCE_TRIM_MARKERS);

  if (exoticHit) {
    tier = 'exotic_collector';
    reasons.push(`Exotic make: ${exoticHit}`);
    manualReasons.push('Exotic vehicle — confirm scope, access and equipment before quoting.');
  } else if (euroLuxHit) {
    tier = 'euro_luxury_performance';
    reasons.push(`European/luxury make: ${euroLuxHit}`);
  }

  if (tier === 'standard' && (perfModelHit || perfTrimHit)) {
    tier = 'euro_luxury_performance';
    reasons.push(`Performance ${perfModelHit ? `model: ${perfModelHit}` : `trim: ${perfTrimHit}`}`);
  } else if (tier === 'euro_luxury_performance' && (perfModelHit || perfTrimHit)) {
    reasons.push(`Performance ${perfModelHit ? `model: ${perfModelHit}` : `trim: ${perfTrimHit}`}`);
  }

  if (v.modStatus === 'heavy') {
    if (tier === 'standard') tier = 'euro_luxury_performance';
    reasons.push('Heavily modified — additional inspection complexity');
    manualReasons.push('Heavily modified vehicle — review the modification list before quoting.');
  } else if (v.modStatus === 'light') {
    reasons.push('Lightly modified');
  }

  const age = v.year ? now.getFullYear() - v.year : null;
  if (age !== null && age >= 25) {
    tier = 'exotic_collector';
    reasons.push(`Vehicle is ${age} years old — collector/classic handling`);
    manualReasons.push('Classic/collector age — parts availability and inspection scope need review.');
  }

  if (v.titleStatus === 'salvage_rebuilt') {
    manualReasons.push('Salvage/rebuilt title disclosed — inspection scope and expectations need manual review.');
  }
  if (v.startsDrives === 'no') {
    manualReasons.push('Vehicle reported as not starting/driving — road test not possible; confirm scope.');
  }
  if (!v.make || !v.model) {
    manualReasons.push('Make/model incomplete — cannot classify automatically.');
  }

  return { tier, reasons, manualReview: manualReasons.length > 0, manualReasons };
}

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
  let subtotal = 0;
  let travel = 0;
  let addons = 0;
  let discount = 0;
  for (const line of lines) {
    switch (line.kind) {
      case 'base':
        subtotal += line.amountCents;
        break;
      case 'travel':
        travel += line.amountCents;
        break;
      case 'addon':
        addons += line.amountCents;
        break;
      case 'discount':
        discount += Math.abs(line.amountCents);
        break;
    }
  }
  const total = subtotal + travel + addons - discount;
  if (total < 0) throw new Error('Quote total cannot be negative');
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

/**
 * Draft policy calculator. Late/exceptional cases always land on admin_review —
 * the system never auto-forfeits a customer's money.
 */
export function cancellationOutcome(appointmentAtIso: string, config: PpiConfig, now = new Date()): CancellationOutcome {
  const hoursUntil = (new Date(appointmentAtIso).getTime() - now.getTime()) / 3600_000;
  if (hoursUntil >= config.cancellation.fullRefundHours) {
    return { kind: 'refund_or_reschedule', label: 'More than 48 hours out — full refund or free rescheduling.' };
  }
  if (hoursUntil >= config.cancellation.rescheduleHours) {
    return { kind: 'one_free_reschedule', label: 'Between 24 and 48 hours out — one free reschedule.' };
  }
  return {
    kind: 'admin_review',
    label: 'Less than 24 hours out — reviewed personally; a transferable service credit may be offered.',
  };
}
