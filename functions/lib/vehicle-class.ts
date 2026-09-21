// Vehicle package classification.
//
// The package is chosen by INSPECTION COMPLEXITY, not by sticker price, and
// three properties are deliberate:
//
//  1. Manufacturer alone is never sufficient. A Volkswagen Jetta and a Golf R
//     share a badge and nothing else, so an explicit model/trim table is
//     consulted BEFORE any make-level default.
//  2. Nothing silently raises the price. Age, modifications, salvage titles and
//     non-runners produce a written review note, never an automatic bump into a
//     more expensive package. The owner approves any increase, and the customer
//     sees the reason before it is charged.
//  3. Every suggestion carries a short plain-language sentence the customer can
//     read, plus a longer admin-facing reason list.
//
// Matching is token-aware: `rs` matches the whole word "RS" but not "Cross",
// and a multi-word needle such as `scat pack` matches as a phrase. This is what
// keeps a Chevrolet Trailblazer RS (an appearance package) out of the
// performance tier, while an Audi RS 5 stays in it.

export type Tier = 'standard' | 'euro_luxury_performance' | 'exotic_collector';

export interface VehicleFacts {
  year: number | null;
  make: string;
  model: string;
  trim: string;
  modStatus: 'stock' | 'light' | 'heavy';
  modDetails?: string;
  titleStatus: 'clean' | 'salvage_rebuilt' | 'unknown';
  startsDrives: 'yes' | 'no' | 'unknown';
}

export interface TierSuggestion {
  tier: Tier;
  /** Admin-facing explanation of how the tier was reached. Never shown raw. */
  reasons: string[];
  /** One short sentence written for the customer. Always populated. */
  customerReason: string;
  /** True when the owner should look before the price is treated as settled. */
  manualReview: boolean;
  manualReasons: string[];
  /** Customer-safe notes about what still needs confirming (no price threats). */
  customerNotes: string[];
  /** Highest tier this vehicle could be moved to on review, if higher. */
  reviewCeiling: Tier | null;
}

const TIER_ORDER: Record<Tier, number> = {
  standard: 0,
  euro_luxury_performance: 1,
  exotic_collector: 2,
};

function higher(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

/** Lowercase, strip punctuation to spaces, collapse runs. "RS 5" → " rs 5 ". */
function norm(value: string): string {
  return ` ${String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim().replace(/\s+/gu, ' ')} `;
}

/**
 * Whole-word/phrase match. Single-word needles must match a complete token so
 * "rs" never fires inside "crosstrek"; multi-word needles match as a phrase.
 */
function hit(haystack: string, needles: readonly string[]): string | null {
  for (const needle of needles) {
    const n = norm(needle);
    if (n.trim() && haystack.includes(n)) return n.trim();
  }
  return null;
}

// --------------------------------------------------------------- make tables

/** Every vehicle from these makes is an exotic/collector inspection. */
const EXOTIC_MAKES = [
  'ferrari', 'lamborghini', 'mclaren', 'bentley', 'rolls royce', 'bugatti', 'koenigsegg',
  'pagani', 'aston martin', 'maserati', 'lotus', 'rimac', 'de tomaso', 'spyker', 'noble',
];

/**
 * Makes whose ordinary models carry luxury/performance inspection complexity —
 * air suspension, adaptive dampers, complex electrical architectures, or
 * dedicated service procedures. Individual mainstream models are exempted in
 * MODEL_RULES below; the badge alone never decides.
 */
const LUXURY_MAKES = [
  'bmw', 'mercedes benz', 'mercedes', 'audi', 'porsche', 'land rover', 'range rover', 'jaguar',
  'volvo', 'lexus', 'genesis', 'infiniti', 'acura', 'cadillac', 'lincoln', 'alfa romeo',
  'tesla', 'rivian', 'lucid', 'polestar',
];

/** Plain-English make spellings the public uses, mapped to the tables above. */
const MAKE_ALIASES: Record<string, string> = {
  'mercedes': 'mercedes benz',
  'merc': 'mercedes benz',
  'benz': 'mercedes benz',
  'vw': 'volkswagen',
  'chevy': 'chevrolet',
  'rolls': 'rolls royce',
  'landrover': 'land rover',
  'range rover': 'land rover',
  'gm': 'chevrolet',
};

function canonicalMake(raw: string): string {
  const n = norm(raw).trim();
  if (!n) return '';
  return MAKE_ALIASES[n] ?? n;
}

// -------------------------------------------------------------- model rules
//
// Highest-precedence table: an explicit (make, model) entry decides the tier
// outright, optionally refined by trim. This is where "a Corvette is
// performance but a base Camaro is not" and "a Jetta is standard even though
// Volkswagen is European" are expressed. Add a row here rather than editing the
// make lists — that is what keeps the make lists honest.

interface ModelRule {
  /** Canonical make this rule belongs to; '*' applies to every make. */
  make: string;
  /** Whole-word model needles. */
  models: readonly string[];
  /** Tier when no trim override matches. */
  tier: Tier;
  reason: string;
  /** Trim needles that raise the tier for this model (e.g. Camaro SS). */
  upgradeTrims?: readonly string[];
  upgradeTier?: Tier;
  upgradeReason?: string;
}

const MODEL_RULES: readonly ModelRule[] = [
  // ---- mainstream models wearing a European or near-luxury badge -----------
  {
    make: 'volkswagen',
    models: ['jetta', 'passat', 'tiguan', 'atlas', 'taos', 'beetle', 'rabbit', 'cc', 'id 4'],
    tier: 'standard',
    reason: 'Mainstream Volkswagen passenger model — standard inspection scope',
  },
  {
    make: 'volkswagen',
    models: ['golf', 'gti', 'golf r'],
    tier: 'standard',
    reason: 'Base Volkswagen Golf — standard inspection scope',
    upgradeTrims: ['gti', 'r', 'r line'],
    upgradeTier: 'euro_luxury_performance',
    upgradeReason: 'Performance Golf variant (GTI/R)',
  },
  {
    make: 'mini',
    models: ['cooper', 'clubman', 'countryman', 'hardtop'],
    tier: 'standard',
    reason: 'Base MINI — standard inspection scope',
    upgradeTrims: ['john cooper works', 'jcw', 's'],
    upgradeTier: 'euro_luxury_performance',
    upgradeReason: 'MINI Cooper S / John Cooper Works performance variant',
  },
  {
    make: 'buick',
    models: ['encore', 'envision', 'enclave', 'regal', 'lacrosse'],
    tier: 'standard',
    reason: 'Mainstream Buick model — standard inspection scope',
  },

  // ---- performance models wearing a mainstream badge -----------------------
  {
    make: 'chevrolet',
    models: ['corvette'],
    tier: 'euro_luxury_performance',
    reason: 'Chevrolet Corvette — performance inspection scope',
  },
  {
    make: 'chevrolet',
    models: ['camaro'],
    tier: 'standard',
    reason: 'Base Chevrolet Camaro — standard inspection scope',
    upgradeTrims: ['ss', 'zl1', '1le', 'z28'],
    upgradeTier: 'euro_luxury_performance',
    upgradeReason: 'Camaro SS/ZL1/1LE performance variant',
  },
  {
    // "RS" on these is an appearance package, not a performance drivetrain.
    make: 'chevrolet',
    models: ['trailblazer', 'blazer', 'equinox', 'trax', 'malibu', 'traverse', 'tahoe', 'silverado', 'colorado', 'suburban', 'bolt'],
    tier: 'standard',
    reason: 'Mainstream Chevrolet model — standard inspection scope (RS here is an appearance package)',
  },
  {
    make: 'dodge',
    models: ['charger', 'challenger'],
    tier: 'standard',
    reason: 'Base V6 Charger/Challenger — standard inspection scope',
    upgradeTrims: ['r t', 'rt', 'scat pack', 'srt', 'hellcat', 'demon', 'redeye', '392', 'super bee'],
    upgradeTier: 'euro_luxury_performance',
    upgradeReason: 'V8 / SRT Charger-Challenger performance variant',
  },
  {
    make: 'ford',
    models: ['mustang'],
    tier: 'standard',
    reason: 'Base EcoBoost Mustang — standard inspection scope',
    upgradeTrims: ['gt', 'mach 1', 'bullitt', 'shelby', 'gt350', 'gt500', 'dark horse', 'boss'],
    upgradeTier: 'euro_luxury_performance',
    upgradeReason: 'Mustang GT / Shelby performance variant',
  },
  { make: 'ford', models: ['gt'], tier: 'exotic_collector', reason: 'Ford GT — exotic inspection scope' },
  { make: 'acura', models: ['nsx'], tier: 'exotic_collector', reason: 'Acura NSX — exotic inspection scope' },
  { make: 'honda', models: ['nsx'], tier: 'exotic_collector', reason: 'Honda NSX — exotic inspection scope' },
  { make: 'lexus', models: ['lfa'], tier: 'exotic_collector', reason: 'Lexus LFA — exotic inspection scope' },
  { make: 'mercedes benz', models: ['slr', 'sls'], tier: 'exotic_collector', reason: 'Mercedes-Benz SLR/SLS — exotic inspection scope' },
  { make: 'porsche', models: ['918', 'carrera gt'], tier: 'exotic_collector', reason: 'Porsche hypercar — exotic inspection scope' },
  { make: 'bmw', models: ['i8'], tier: 'exotic_collector', reason: 'BMW i8 — exotic inspection scope' },
  { make: 'nissan', models: ['gt r'], tier: 'euro_luxury_performance', reason: 'Nissan GT-R — performance inspection scope' },

  // ---- near-luxury badges on ordinary family vehicles ---------------------
  {
    make: 'lexus',
    models: ['es', 'ux', 'nx'],
    tier: 'standard',
    reason: 'Entry Lexus built on a mainstream Toyota platform — standard inspection scope',
    upgradeTrims: ['f sport'],
    upgradeTier: 'euro_luxury_performance',
    upgradeReason: 'Lexus F Sport variant',
  },
  {
    make: 'acura',
    models: ['ilx', 'rdx', 'tlx', 'mdx', 'integra'],
    tier: 'standard',
    reason: 'Acura built on a mainstream Honda platform — standard inspection scope',
    upgradeTrims: ['type s', 'a spec'],
    upgradeTier: 'euro_luxury_performance',
    upgradeReason: 'Acura Type S performance variant',
  },
];

// ------------------------------------------------- make-independent signals

/** Model names that are performance vehicles on any badge. */
const PERFORMANCE_MODELS = [
  'viper', 'supra', 'stingray', 'z06', 'zr1', 'gt350', 'gt500', 'hellcat', 'demon', 'trackhawk',
  'raptor', 'trx', 'type r', 'civic si', 'wrx', 'sti', 'evolution', 'lancer evolution',
  'focus rs', 'focus st', 'fiesta st', 'veloster n', 'elantra n', 'kona n', '370z', '350z', '400z',
  'cayman', 'boxster', '911', 'm2', 'm3', 'm4', 'm5', 'm8', 'rs3', 'rs5', 'rs6', 'rs7', 'r8',
  's2000', 'miata', 'mx 5', 'rx 7', 'rx 8', 'gr86', 'brz', 'gr corolla', 'gr supra', 'gr yaris',
  'corvette', 'challenger srt', 'charger srt',
];

/**
 * Trim markers that mean a performance drivetrain regardless of badge.
 * Deliberately excludes appearance packages — "RS" (Chevrolet), "S-Line"
 * (Audi), "M Sport" (BMW) and "N Line" (Hyundai) are trim-level styling, not
 * different vehicles to inspect, and used to cause unexplained price jumps.
 */
const PERFORMANCE_TRIMS = [
  'amg', 'srt', 'scat pack', 'hellcat', 'trackhawk', 'shelby', 'nismo', 'type r', 'type s',
  'blackwing', 'v series', 'quadrifoglio', 'john cooper works', 'jcw', 'black series',
  'competition', 'plaid', 'trd pro', 'gt3', 'gt4', 'turbo s', 'z06', 'zr1', 'zl1', 'redeye',
  'raptor', 'gt350', 'gt500', 'f sport performance',
];

/**
 * Performance trims that only mean performance on specific makes. Deliberately
 * short: BMW "M Sport" and Hyundai "N Line" are styling packages, and both
 * makes already reach the right tier by other rules, so listing a bare "m" or
 * "n" here would only produce a misleading reason.
 */
const MAKE_SCOPED_PERFORMANCE_TRIMS: Record<string, readonly string[]> = {
  audi: ['rs', 's3', 's4', 's5', 's6', 's7', 's8'],
  ford: ['st', 'rs'],
  chevrolet: ['ss'],
};

const CLASSIC_REVIEW_AGE = 30;

// ------------------------------------------------------------------- public

export function suggestTier(v: VehicleFacts, now = new Date()): TierSuggestion {
  const make = canonicalMake(v.make);
  const makeToken = norm(make);
  const model = norm(v.model);
  const trim = norm(v.trim);
  const modelAndTrim = `${model}${trim}`;

  const reasons: string[] = [];
  const manualReasons: string[] = [];
  const customerNotes: string[] = [];
  let tier: Tier = 'standard';
  let customerReason = '';
  let decided = false;

  // 1. Explicit model rules win outright — manufacturer alone is insufficient.
  for (const rule of MODEL_RULES) {
    if (rule.make !== '*' && norm(rule.make) !== makeToken) continue;
    if (!hit(model, rule.models)) continue;
    tier = rule.tier;
    reasons.push(rule.reason);
    customerReason = rule.reason;
    decided = true;
    if (rule.upgradeTrims && rule.upgradeTier && hit(trim, rule.upgradeTrims)) {
      tier = higher(tier, rule.upgradeTier);
      reasons.push(rule.upgradeReason ?? 'Performance trim');
      customerReason = rule.upgradeReason ?? customerReason;
    }
    break;
  }

  // 2. Exotic makes.
  if (!decided) {
    const exoticHit = hit(makeToken, EXOTIC_MAKES);
    if (exoticHit) {
      tier = 'exotic_collector';
      reasons.push(`Exotic make: ${exoticHit}`);
      customerReason = `${v.make.trim()} is an exotic marque, which needs the exotic/collector inspection scope.`;
      manualReasons.push('Exotic vehicle — confirm scope, access and equipment before quoting.');
      customerNotes.push('AutoClarity confirms the exact scope for exotic vehicles before your quote is final.');
      decided = true;
    }
  }

  // 3. Make-independent performance signals.
  if (tier !== 'exotic_collector') {
    const perfModel = hit(model, PERFORMANCE_MODELS);
    const perfTrim = hit(trim, PERFORMANCE_TRIMS)
      ?? hit(trim, MAKE_SCOPED_PERFORMANCE_TRIMS[make] ?? []);
    if (perfModel || perfTrim) {
      const before = tier;
      tier = higher(tier, 'euro_luxury_performance');
      reasons.push(`Performance ${perfModel ? `model: ${perfModel}` : `trim: ${perfTrim}`}`);
      // Only speak for the customer when this signal actually moved the tier —
      // an explicit model rule already wrote a better sentence.
      if (tier !== before || !customerReason) {
        customerReason = `This is a performance variant (${(perfModel ?? perfTrim ?? '').toUpperCase()}), which takes the Luxury & Performance scope.`;
      }
      decided = true;
    }
  }

  // 4. Luxury makes, only if nothing more specific already decided.
  if (!decided) {
    const luxHit = hit(makeToken, LUXURY_MAKES);
    if (luxHit) {
      tier = higher(tier, 'euro_luxury_performance');
      reasons.push(`Luxury/European make: ${luxHit}`);
      customerReason = `${v.make.trim()} vehicles take the Luxury & Performance scope.`;
      decided = true;
    }
  }

  if (!customerReason) {
    customerReason = `${[v.year, v.make, v.model].filter(Boolean).join(' ').trim() || 'This vehicle'} matches the Standard Vehicle inspection.`;
  }

  // ------------------------------------------------ review flags (never price)
  //
  // Each of these used to raise the tier automatically. They now record a
  // reason instead: the owner decides, and the customer sees a plain note.

  const reviewCeilings: Tier[] = [];

  if (v.modStatus === 'heavy') {
    manualReasons.push(
      `Heavily modified${v.modDetails ? `: ${v.modDetails}` : ' — modification list not provided'}. Confirm scope before quoting; do not raise the package without a stated reason.`,
    );
    customerNotes.push('You marked this vehicle as heavily modified, so AutoClarity reviews the modifications before confirming the package. Any change to the price is shown to you before you pay.');
    reviewCeilings.push('exotic_collector');
  } else if (v.modStatus === 'light') {
    reasons.push(`Lightly modified: ${v.modDetails?.trim() || 'details not provided'}`);
    if (!v.modDetails?.trim()) {
      manualReasons.push('Lightly modified but no modification details were given — ask what was changed.');
      customerNotes.push('Tell AutoClarity what was modified so the package can be confirmed accurately.');
    } else {
      customerNotes.push(`Noted modifications: ${v.modDetails.trim()}. These do not change your package on their own.`);
    }
  }

  const age = v.year ? now.getFullYear() - v.year : null;
  if (age !== null && age >= CLASSIC_REVIEW_AGE) {
    manualReasons.push(
      `Vehicle is ${age} years old — parts availability and collector scope need review. Confirm whether the collector package applies before quoting.`,
    );
    customerNotes.push(`This is a ${age}-year-old vehicle. AutoClarity confirms whether the collector scope applies — you will see any change before you pay.`);
    reviewCeilings.push('exotic_collector');
  }

  if (v.titleStatus === 'salvage_rebuilt') {
    manualReasons.push('Salvage/rebuilt title disclosed — inspection scope and expectations need manual review.');
    customerNotes.push('A salvage or rebuilt title is reviewed individually before your quote is confirmed.');
  }
  if (v.startsDrives === 'no') {
    manualReasons.push('Vehicle reported as not starting/driving — road test not possible; confirm scope.');
    customerNotes.push('Because the vehicle does not start or drive, a road test is not possible; AutoClarity confirms what can be inspected.');
  }
  if (!v.make.trim() || !v.model.trim()) {
    manualReasons.push('Make/model incomplete — cannot classify automatically.');
    customerNotes.push('Add the make and model so AutoClarity can confirm the right package.');
  }

  const reviewCeiling = reviewCeilings.reduce<Tier | null>(
    (acc, candidate) => (TIER_ORDER[candidate] > TIER_ORDER[tier] ? (acc ? higher(acc, candidate) : candidate) : acc),
    null,
  );

  return {
    tier,
    reasons,
    customerReason,
    manualReview: manualReasons.length > 0,
    manualReasons,
    customerNotes,
    reviewCeiling,
  };
}

/** Short, readable package names. Internal keys never reach a human. */
export const TIER_NAMES: Record<Tier, string> = {
  standard: 'Standard',
  euro_luxury_performance: 'Luxury & Performance',
  exotic_collector: 'Exotic / Collector',
};

/** Is a customer's chosen package different from what the rules suggest? */
export function tierMismatch(suggested: Tier, chosen: Tier): null | { direction: 'lower' | 'higher'; note: string } {
  if (suggested === chosen) return null;
  const direction = TIER_ORDER[chosen] < TIER_ORDER[suggested] ? 'lower' : 'higher';
  return {
    direction,
    note: direction === 'lower'
      ? `The customer chose ${TIER_NAMES[chosen]} but this vehicle suggests ${TIER_NAMES[suggested]}. Check the vehicle before you send a proposal.`
      : `The customer chose ${TIER_NAMES[chosen]}, above the suggested ${TIER_NAMES[suggested]}. Confirm it is genuinely needed before charging more.`,
  };
}

export function isTier(value: unknown): value is Tier {
  return value === 'standard' || value === 'euro_luxury_performance' || value === 'exotic_collector';
}
