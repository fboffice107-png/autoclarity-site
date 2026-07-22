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
  // Owner-controlled reviews. Hidden until real, verifiable reviews are added
  // AND enabled. No star ratings / AggregateRating are generated.
  reviews: {
    enabled: boolean;
    items: Array<{ name: string; text: string; vehicle?: string }>;
  };
  travel: {
    // Public service-area origin: central Las Vegas (Clark County government
    // area) — deliberately NOT a private address.
    originLat: number;
    originLng: number;
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

export const DEFAULT_CONFIG: PpiConfig = {
  pricing: {
    tiers: {
      standard: {
        key: 'standard',
        label: 'Standard Vehicle PPI',
        priceCents: 19900, // regular/target
        launchPriceCents: 14900, // introductory
        blurb: 'Common unmodified domestic, Japanese and Korean passenger vehicles and light trucks.',
      },
      euro_luxury_performance: {
        key: 'euro_luxury_performance',
        label: 'European, Luxury or Performance PPI',
        priceCents: 29900,
        launchPriceCents: 24900,
        blurb: 'Examples include Corvette, BMW, Mercedes-Benz, Audi, Land Rover, Porsche, and modified or higher-complexity vehicles.',
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
    sameDayPriorityCents: 0, // owner sets when same-day priority is offered
    liftFacilityCents: 0, // owner sets when a partner-facility lift is arranged
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
    originLat: 36.1147,
    originLng: -115.1728,
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
    minLeadHours: 18,
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
    return deepMerge(DEFAULT_CONFIG, JSON.parse(row.value_json));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function setConfig(db: D1Database, patch: unknown, actor: string): Promise<PpiConfig> {
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
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO configuration (key, value_json, updated_at, updated_by) VALUES ('ppi', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(JSON.stringify(merged), now, actor)
    .run();
  return deepMerge(DEFAULT_CONFIG, merged);
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
  if (p.endsAt) {
    const ends = new Date(p.endsAt);
    if (!Number.isNaN(ends.getTime()) && now > ends) return false;
  }
  return true;
}

/** Is the time-boxed introductory launch window currently active? */
export function launchActive(config: PpiConfig, now = new Date()): boolean {
  const l = config.pricing.launch;
  if (!l.enabled) return false;
  if (l.startsAt) {
    const starts = new Date(l.startsAt);
    if (!Number.isNaN(starts.getTime()) && now < starts) return false;
  }
  if (l.endsAt) {
    const ends = new Date(l.endsAt);
    if (!Number.isNaN(ends.getTime()) && now > ends) return false;
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
  return { priceCents: tier.priceCents, wasCents: null, startingAt };
}
