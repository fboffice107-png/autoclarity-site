// Central, owner-editable configuration. Code ships safe defaults; the
// `configuration` D1 table stores admin overrides (deep-merged over defaults).
// All pricing, travel, scheduling and policy numbers live HERE, not scattered.

export interface TierConfig {
  key: string;
  label: string;
  priceCents: number; // configured regular/target price
  launchPriceCents?: number; // introductory price while the launch window is active
  startingAt?: boolean; // show "Starting at" (final amount can change)
  blurb: string;
}

export interface PpiConfig {
  pricing: {
    tiers: {
      standard: TierConfig;
      euro_luxury_performance: TierConfig;
      exotic_collector: TierConfig;
    };
    // Time-boxed introductory launch pricing. Only shows a crossed-out regular
    // price when enabled AND a real endsAt is set — never a permanent fake sale.
    launch: {
      enabled: boolean;
      startsAt: string | null; // ISO date; launch not active before this
      endsAt: string | null; // ISO date; launch ends after this
    };
    // Legacy single-tier promo (retained for back-compat; `launch` is primary).
    promo: {
      enabled: boolean;
      priceCents: number;
      label: string;
      endsAt: string | null;
    };
  };
  // Optional configurable add-on fees (cents). Shown only where relevant.
  fees: {
    sameDayPriorityCents: number;
    liftFacilityCents: number;
  };
  // Diagnostic-scan scope. Default false until the owner confirms scan-tool
  // usage is within the approved operating scope (see docs/PPI_SCAN_SCOPE_REVIEW.md).
  scan: {
    included: boolean;
  };
  // Urgent call/text path. Buttons stay HIDDEN until a real, verified business
  // phone number is configured — never invent one.
  contact: {
    businessPhone: string | null; // E.164, e.g. "+17025551234"; null = hide call/text
    smsEnabled: boolean;
    callEnabled: boolean;
    urgentCtaEnabled: boolean;
  };
  // Reviews stay release-gated until each item has documented source,
  // publication permission, and approved presentation. No star ratings /
  // AggregateRating are generated.
  reviews: {
    enabled: boolean;
    items: Array<{ name: string; text: string; vehicle?: string }>;
  };
  travel: {
    // Server-side service origin. Distances are measured from AutoClarity's
    // actual operating base (ZIP 89147 centroid) so the mobile-service charge
    // reflects the real drive, rather than a downtown placeholder that
    // over-charged the west valley and under-charged the east.
    //
    // PRIVACY: this repository is public, so the default here is a ZIP
    // centroid and never a street address. The owner can store exact
    // coordinates through the admin Configuration tab instead, where they
    // live in the private database. Either way the origin is never included
    // in /api/ppi/runtime-config, the generated public facts, or any
    // customer-facing payload — only the derived mileage and band are shown.
    originLat: number;
    originLng: number;
    /** Admin-facing label for where distances are measured from. */
    originLabel: string;
    bands: Array<{ maxMiles: number; feeCents: number }>;
    customBeyondMiles: number;
  };
  scheduling: {
    timezone: string;
    slotTemplates: string[]; // local times "HH:MM"
    durationMin: number;
    travelBufferMin: number;
    reportBufferMin: number;
    daysOfOperation: number[]; // 0=Sun..6=Sat
    blackoutDates: string[]; // "YYYY-MM-DD" local
    minLeadHours: number;
    maxAdvanceDays: number;
    holdMinutes: number;
  };
  quotes: { expiryHours: number };
  cancellation: {
    fullRefundHours: number; // >= this many hours out: refund or free reschedule
    rescheduleHours: number; // between rescheduleHours and fullRefundHours: one free reschedule
  };
  magicLinks: { ttlHours: number };
  uploads: { maxFiles: number; maxBytes: number; allowedTypes: string[] };
  supportEmail: string;
}

// This is intentionally a code release gate, not an owner-editable switch.
// Enabling scan scope requires a separately reviewed implementation change.
export const SCAN_CAPABILITY_RELEASED = false;

// This is intentionally a code release gate, not an owner-editable switch.
// The current compact config shape cannot prove source/consent for a quote.
export const REVIEW_CAPABILITY_RELEASED = false;

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_configuration' | 'configuration_not_released' = 'invalid_configuration',
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const PUBLIC_FACT_CONFIG_KEYS = new Set(['pricing', 'fees', 'travel', 'supportEmail']);

/** Fields of `travel` that never appear in visible HTML, generated public
 * facts, or any customer-facing payload. The service origin is one of them:
 * customers only ever see the derived mileage and the band it falls in, so
 * changing it cannot make published copy stale — and keeping it editable at
 * runtime is what lets the owner set a precise operating address without
 * committing it to a public repository. */
const PRIVATE_TRAVEL_KEYS = new Set(['originLat', 'originLng', 'originLabel']);

/** These values are repeated in visible HTML and generated public facts.
 * Production changes therefore require a coordinated source change/build, not
 * a runtime-only admin override that would make JSON-LD/catalog copy stale. */
export function patchTouchesPublicFacts(patch: unknown): boolean {
  if (!isPlainObject(patch)) return false;
  return Object.entries(patch).some(([key, value]) => {
    if (!PUBLIC_FACT_CONFIG_KEYS.has(key)) return false;
    // `travel` holds both published bands and the private origin. Gate it only
    // when the patch actually reaches a published field.
    if (key === 'travel' && isPlainObject(value)) {
      return Object.keys(value).some((child) => !PRIVATE_TRAVEL_KEYS.has(child));
    }
    return true;
  });
}

export const DEFAULT_CONFIG: PpiConfig = {
  pricing: {
    tiers: {
      standard: {
        key: 'standard',
        label: 'Standard Vehicle PPI',
        priceCents: 19900, // regular/target
        launchPriceCents: 14900, // introductory
        startingAt: true,
        blurb: 'Common unmodified domestic, Japanese and Korean passenger vehicles and light trucks.',
      },
      euro_luxury_performance: {
        key: 'euro_luxury_performance',
        label: 'European, Luxury or Performance PPI',
        priceCents: 29900,
        launchPriceCents: 24900,
        startingAt: true,
        blurb: 'Examples include Corvette, BMW, Mercedes-Benz, Audi, Land Rover, Porsche, and other luxury or higher-complexity vehicles.',
      },
      exotic_collector: {
        key: 'exotic_collector',
        label: 'Exotic, Collector or Heavily Modified PPI',
        priceCents: 39900, // "starting at"; final quote after review
        startingAt: true,
        blurb: 'Final quote required after reviewing the exact vehicle, location and inspection scope.',
      },
    },
    // Launch pricing is OFF by default. The owner turns it on with a real end
    // date via the admin config; only then do the crossed-out prices appear.
    launch: {
      enabled: false,
      startsAt: null,
      endsAt: null,
    },
    promo: {
      enabled: false,
      priceCents: 14900,
      label: 'Las Vegas launch price — Standard Vehicle PPI',
      endsAt: null,
    },
  },
  fees: {
    // Charged only when the customer asked for same-day priority AND the
    // owner is actually quoting a same-day appointment. Disclosed on the
    // public pricing page and itemised in every quote.
    sameDayPriorityCents: 2500,
    liftFacilityCents: 0, // owner sets only when deeper-access arrangements are confirmed
  },
  scan: {
    included: false, // fail-safe default; see docs/PPI_SCAN_SCOPE_REVIEW.md
  },
  contact: {
    businessPhone: null, // no verified number yet → call/text hidden
    smsEnabled: false,
    callEnabled: false,
    urgentCtaEnabled: false,
  },
  reviews: {
    enabled: false, // hidden until real, verifiable reviews exist
    items: [], // owner adds real reviews here; none fabricated
  },
  travel: {
    // ZIP 89147 centroid — AutoClarity's operating base in west Las Vegas.
    originLat: 36.113,
    originLng: -115.28,
    originLabel: 'AutoClarity service base — Las Vegas 89147',
    bands: [
      { maxMiles: 15, feeCents: 0 },
      { maxMiles: 25, feeCents: 2500 },
      { maxMiles: 40, feeCents: 5000 },
    ],
    customBeyondMiles: 40,
  },
  scheduling: {
    timezone: 'America/Los_Angeles',
    slotTemplates: ['09:00', '12:30', '16:00'],
    durationMin: 120,
    travelBufferMin: 45,
    reportBufferMin: 60,
    daysOfOperation: [1, 2, 3, 4, 5, 6],
    blackoutDates: [],
    // No minimum notice by owner decision: any free hour inside the operating
    // window is bookable, including later today. A slot already in the past is
    // still refused everywhere (the checks use `now` as the floor).
    minLeadHours: 0,
    maxAdvanceDays: 21,
    holdMinutes: 60,
  },
  quotes: { expiryHours: 48 },
  cancellation: { fullRefundHours: 48, rescheduleHours: 24 },
  magicLinks: { ttlHours: 336 }, // 14 days
  uploads: {
    maxFiles: 6,
    maxBytes: 8 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  },
  supportEmail: 'support@getautoclarity.com',
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertConfig(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigValidationError(message);
}

function assertOverrideShape(base: unknown, value: unknown, path = 'config'): void {
  if (Array.isArray(base)) {
    assertConfig(Array.isArray(value), `${path} must be an array.`);
    return;
  }
  if (isPlainObject(base)) {
    assertConfig(isPlainObject(value), `${path} must be an object.`);
    for (const [key, child] of Object.entries(value)) {
      assertConfig(Object.hasOwn(base, key), `${path}.${key} is not a supported configuration field.`);
      assertOverrideShape(base[key], child, `${path}.${key}`);
    }
    return;
  }
  if (base === null) {
    assertConfig(value === null || typeof value === 'string', `${path} must be a string or null.`);
    return;
  }
  assertConfig(typeof value === typeof base, `${path} must be a ${typeof base}.`);
}

function validIsoInstantOrDate(value: string | null): boolean {
  return value === null || (value.trim() !== '' && !Number.isNaN(new Date(value).getTime()));
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function assertIntegerRange(value: number, min: number, max: number, path: string): void {
  assertConfig(Number.isInteger(value) && value >= min && value <= max, `${path} must be an integer from ${min} through ${max}.`);
}

function validateEffectiveConfig(config: PpiConfig): void {
  const tierKeys = ['standard', 'euro_luxury_performance', 'exotic_collector'] as const;
  for (const tierKey of tierKeys) {
    const tier = config.pricing.tiers[tierKey];
    assertConfig(tier.key === tierKey, `config.pricing.tiers.${tierKey}.key must remain ${tierKey}.`);
    assertConfig(tier.label.trim().length >= 1 && tier.label.length <= 100, `config.pricing.tiers.${tierKey}.label is invalid.`);
    assertIntegerRange(tier.priceCents, 1, 10_000_000, `config.pricing.tiers.${tierKey}.priceCents`);
    if (tier.launchPriceCents !== undefined) {
      assertIntegerRange(tier.launchPriceCents, 1, 10_000_000, `config.pricing.tiers.${tierKey}.launchPriceCents`);
    }
    assertConfig(typeof tier.startingAt === 'boolean' || tier.startingAt === undefined, `config.pricing.tiers.${tierKey}.startingAt must be a boolean.`);
    assertConfig(tier.blurb.trim().length >= 1 && tier.blurb.length <= 500, `config.pricing.tiers.${tierKey}.blurb is invalid.`);
  }

  const launch = config.pricing.launch;
  assertConfig(validIsoInstantOrDate(launch.startsAt), 'config.pricing.launch.startsAt must be a valid date or null.');
  assertConfig(validIsoInstantOrDate(launch.endsAt), 'config.pricing.launch.endsAt must be a valid date or null.');
  assertConfig(!launch.enabled || launch.endsAt !== null, 'An enabled launch price requires a real end date.');
  if (launch.startsAt && launch.endsAt) {
    assertConfig(new Date(launch.endsAt).getTime() > new Date(launch.startsAt).getTime(), 'The launch end date must be after its start date.');
  }

  const promo = config.pricing.promo;
  assertIntegerRange(promo.priceCents, 1, 10_000_000, 'config.pricing.promo.priceCents');
  assertConfig(promo.label.trim().length >= 1 && promo.label.length <= 160, 'config.pricing.promo.label is invalid.');
  assertConfig(validIsoInstantOrDate(promo.endsAt), 'config.pricing.promo.endsAt must be a valid date or null.');
  assertConfig(!promo.enabled || promo.endsAt !== null, 'An enabled promotion requires a real end date.');

  assertIntegerRange(config.fees.sameDayPriorityCents, 0, 10_000_000, 'config.fees.sameDayPriorityCents');
  assertIntegerRange(config.fees.liftFacilityCents, 0, 10_000_000, 'config.fees.liftFacilityCents');
  assertConfig(typeof config.scan.included === 'boolean', 'config.scan.included must be a boolean.');

  const phone = config.contact.businessPhone;
  assertConfig(phone === null || /^\+[1-9]\d{7,14}$/u.test(phone), 'config.contact.businessPhone must be a valid E.164 number or null.');
  for (const key of ['smsEnabled', 'callEnabled', 'urgentCtaEnabled'] as const) {
    assertConfig(typeof config.contact[key] === 'boolean', `config.contact.${key} must be a boolean.`);
  }
  assertConfig(phone !== null || (!config.contact.smsEnabled && !config.contact.callEnabled && !config.contact.urgentCtaEnabled), 'Contact actions require a verified business phone number.');

  assertConfig(typeof config.reviews.enabled === 'boolean', 'config.reviews.enabled must be a boolean.');
  assertConfig(config.reviews.items.length <= 12, 'config.reviews.items cannot contain more than 12 reviews.');
  for (const [index, review] of config.reviews.items.entries()) {
    assertConfig(isPlainObject(review), `config.reviews.items[${index}] must be an object.`);
    assertConfig(typeof review.name === 'string' && review.name.trim().length >= 1 && review.name.length <= 100, `config.reviews.items[${index}].name is invalid.`);
    assertConfig(typeof review.text === 'string' && review.text.trim().length >= 1 && review.text.length <= 1000, `config.reviews.items[${index}].text is invalid.`);
    assertConfig(review.vehicle === undefined || (typeof review.vehicle === 'string' && review.vehicle.length <= 160), `config.reviews.items[${index}].vehicle is invalid.`);
  }

  assertConfig(Number.isFinite(config.travel.originLat) && config.travel.originLat >= -90 && config.travel.originLat <= 90, 'config.travel.originLat is invalid.');
  assertConfig(Number.isFinite(config.travel.originLng) && config.travel.originLng >= -180 && config.travel.originLng <= 180, 'config.travel.originLng is invalid.');
  assertConfig(config.travel.originLabel.trim().length >= 1 && config.travel.originLabel.length <= 120, 'config.travel.originLabel is invalid.');
  assertConfig(config.travel.bands.length >= 1 && config.travel.bands.length <= 10, 'config.travel.bands must contain 1 to 10 bands.');
  let priorMiles = 0;
  for (const [index, band] of config.travel.bands.entries()) {
    assertConfig(isPlainObject(band), `config.travel.bands[${index}] must be an object.`);
    assertConfig(Number.isFinite(band.maxMiles) && band.maxMiles > priorMiles && band.maxMiles <= 1000, `config.travel.bands[${index}].maxMiles must increase and remain at most 1000.`);
    assertIntegerRange(band.feeCents, 0, 10_000_000, `config.travel.bands[${index}].feeCents`);
    priorMiles = band.maxMiles;
  }
  assertConfig(Number.isFinite(config.travel.customBeyondMiles) && config.travel.customBeyondMiles >= priorMiles && config.travel.customBeyondMiles <= 1000, 'config.travel.customBeyondMiles must be at least the final travel band and at most 1000.');

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.scheduling.timezone }).format();
  } catch {
    throw new ConfigValidationError('config.scheduling.timezone must be a valid IANA time zone.');
  }
  assertConfig(config.scheduling.slotTemplates.length >= 1 && config.scheduling.slotTemplates.length <= 24, 'config.scheduling.slotTemplates must contain 1 to 24 times.');
  assertConfig(new Set(config.scheduling.slotTemplates).size === config.scheduling.slotTemplates.length, 'config.scheduling.slotTemplates cannot contain duplicates.');
  for (const slot of config.scheduling.slotTemplates) {
    assertConfig(typeof slot === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(slot), 'Every scheduling slot must use 24-hour HH:MM format.');
  }
  assertIntegerRange(config.scheduling.durationMin, 15, 1440, 'config.scheduling.durationMin');
  assertIntegerRange(config.scheduling.travelBufferMin, 0, 1440, 'config.scheduling.travelBufferMin');
  assertIntegerRange(config.scheduling.reportBufferMin, 0, 1440, 'config.scheduling.reportBufferMin');
  assertConfig(config.scheduling.daysOfOperation.length >= 1 && config.scheduling.daysOfOperation.length <= 7, 'config.scheduling.daysOfOperation must contain 1 to 7 days.');
  assertConfig(new Set(config.scheduling.daysOfOperation).size === config.scheduling.daysOfOperation.length, 'config.scheduling.daysOfOperation cannot contain duplicates.');
  for (const day of config.scheduling.daysOfOperation) assertIntegerRange(day, 0, 6, 'config.scheduling.daysOfOperation entry');
  assertConfig(config.scheduling.blackoutDates.length <= 366, 'config.scheduling.blackoutDates is too large.');
  for (const date of config.scheduling.blackoutDates) {
    assertConfig(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date) && !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()), 'Every blackout date must use valid YYYY-MM-DD format.');
  }
  assertIntegerRange(config.scheduling.minLeadHours, 0, 8760, 'config.scheduling.minLeadHours');
  assertIntegerRange(config.scheduling.maxAdvanceDays, 1, 730, 'config.scheduling.maxAdvanceDays');
  assertIntegerRange(config.scheduling.holdMinutes, 5, 1440, 'config.scheduling.holdMinutes');
  assertIntegerRange(config.quotes.expiryHours, 1, 8760, 'config.quotes.expiryHours');
  assertIntegerRange(config.cancellation.fullRefundHours, 0, 8760, 'config.cancellation.fullRefundHours');
  assertIntegerRange(config.cancellation.rescheduleHours, 0, 8760, 'config.cancellation.rescheduleHours');
  assertConfig(config.cancellation.rescheduleHours <= config.cancellation.fullRefundHours, 'Reschedule hours cannot exceed full-refund hours.');
  assertIntegerRange(config.magicLinks.ttlHours, 1, 8760, 'config.magicLinks.ttlHours');
  assertIntegerRange(config.uploads.maxFiles, 1, 20, 'config.uploads.maxFiles');
  assertIntegerRange(config.uploads.maxBytes, 1, 25 * 1024 * 1024, 'config.uploads.maxBytes');
  assertConfig(config.uploads.allowedTypes.length >= 1 && config.uploads.allowedTypes.length <= 10, 'config.uploads.allowedTypes must contain 1 to 10 MIME types.');
  assertConfig(new Set(config.uploads.allowedTypes).size === config.uploads.allowedTypes.length, 'config.uploads.allowedTypes cannot contain duplicates.');
  for (const contentType of config.uploads.allowedTypes) {
    assertConfig(typeof contentType === 'string' && ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(contentType), `Unsupported upload type: ${String(contentType)}.`);
  }
  assertConfig(validEmail(config.supportEmail), 'config.supportEmail must be a valid email address.');
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T)) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    if (k in (base as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    }
    // unknown keys are ignored — config shape is fixed by code
  }
  return out as T;
}

export async function getConfig(db: D1Database): Promise<PpiConfig> {
  const row = await db.prepare(`SELECT value_json FROM configuration WHERE key = 'ppi'`).first<{ value_json: string }>();
  if (!row) return DEFAULT_CONFIG;
  try {
    const merged = deepMerge(DEFAULT_CONFIG, JSON.parse(row.value_json));
    assertOverrideShape(DEFAULT_CONFIG, merged);
    validateEffectiveConfig(merged);
    return {
      ...merged,
      scan: { included: SCAN_CAPABILITY_RELEASED && merged.scan.included === true },
      reviews: REVIEW_CAPABILITY_RELEASED && merged.reviews.enabled === true
        ? merged.reviews
        : { enabled: false, items: [] },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function setConfig(db: D1Database, patch: unknown, actor: string): Promise<PpiConfig> {
  assertConfig(isPlainObject(patch), 'Configuration updates must be a JSON object.');
  assertOverrideShape(DEFAULT_CONFIG, patch);
  if (
    isPlainObject(patch)
    && isPlainObject(patch['scan'])
    && patch['scan']['included'] === true
    && !SCAN_CAPABILITY_RELEASED
  ) {
    throw new ConfigValidationError(
      'Diagnostic scan cannot be enabled until the separately reviewed capability release is deployed.',
      'configuration_not_released',
    );
  }
  if (
    isPlainObject(patch)
    && isPlainObject(patch['reviews'])
    && patch['reviews']['enabled'] === true
    && !REVIEW_CAPABILITY_RELEASED
  ) {
    throw new ConfigValidationError(
      'Customer reviews cannot be enabled until source, publication permission, and presentation are represented in a separately reviewed capability release.',
      'configuration_not_released',
    );
  }
  const current = await db.prepare(`SELECT value_json FROM configuration WHERE key = 'ppi'`).first<{ value_json: string }>();
  let stored: Record<string, unknown> = {};
  if (current) {
    try {
      stored = JSON.parse(current.value_json) as Record<string, unknown>;
    } catch {
      stored = {};
    }
  }
  // Persist the raw override patch (merged with prior overrides), so defaults
  // can evolve in code without stale copies pinning them.
  const merged = deepMergeOverrides(stored, patch);
  const effective = deepMerge(DEFAULT_CONFIG, merged);
  assertOverrideShape(DEFAULT_CONFIG, effective);
  validateEffectiveConfig(effective);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO configuration (key, value_json, updated_at, updated_by) VALUES ('ppi', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(JSON.stringify(merged), now, actor)
    .run();
  return {
    ...effective,
    scan: { included: SCAN_CAPABILITY_RELEASED && effective.scan.included === true },
    reviews: REVIEW_CAPABILITY_RELEASED && effective.reviews.enabled === true
      ? effective.reviews
      : { enabled: false, items: [] },
  };
}

function deepMergeOverrides(base: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMergeOverrides(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Is the legacy single-tier promo currently active? */
export function promoActive(config: PpiConfig, now = new Date()): boolean {
  const p = config.pricing.promo;
  if (!p.enabled) return false;
  if (!p.endsAt) return false;
  const ends = new Date(p.endsAt);
  return !Number.isNaN(ends.getTime()) && now <= ends;
}

/**
 * Is the time-boxed introductory launch window currently active?
 * A real, future `endsAt` is REQUIRED — a launch with no end date never
 * activates, so a struck-through "was" price can never become a permanent
 * fake discount (enforces the guarantee documented on `pricing.launch`).
 */
export function launchActive(config: PpiConfig, now = new Date()): boolean {
  const l = config.pricing.launch;
  if (!l.enabled) return false;
  if (!l.endsAt) return false; // no end date → not a valid time-boxed launch
  const ends = new Date(l.endsAt);
  if (Number.isNaN(ends.getTime()) || now > ends) return false; // invalid or past
  if (l.startsAt) {
    const starts = new Date(l.startsAt);
    if (!Number.isNaN(starts.getTime()) && now < starts) return false; // not started
  }
  return true;
}

/**
 * Customer-facing display price for a tier: the active launch price (with the
 * regular price to strike through) when the launch window is live and a lower
 * launch price is configured for that tier; otherwise just the regular price.
 * `startingAt` marks tiers whose final amount can still change after review.
 */
export function tierDisplayPrice(
  config: PpiConfig,
  tierKey: 'standard' | 'euro_luxury_performance' | 'exotic_collector',
  now = new Date(),
): { priceCents: number; wasCents: number | null; startingAt: boolean } {
  const tier = config.pricing.tiers[tierKey];
  const startingAt = tier.startingAt === true;
  if (launchActive(config, now) && typeof tier.launchPriceCents === 'number' && tier.launchPriceCents < tier.priceCents) {
    return { priceCents: tier.launchPriceCents, wasCents: tier.priceCents, startingAt };
  }
  if (
    tierKey === 'standard'
    && promoActive(config, now)
    && config.pricing.promo.priceCents < tier.priceCents
  ) {
    return { priceCents: config.pricing.promo.priceCents, wasCents: tier.priceCents, startingAt };
  }
  return { priceCents: tier.priceCents, wasCents: null, startingAt };
}
