// Central, owner-editable configuration. Code ships safe defaults; the
// `configuration` D1 table stores admin overrides (deep-merged over defaults).
// All pricing, travel, scheduling and policy numbers live HERE, not scattered.

export interface TierConfig {
  key: string;
  label: string;
  priceCents: number;
  blurb: string;
}

export interface PpiConfig {
  pricing: {
    tiers: {
      standard: TierConfig;
      euro_luxury_performance: TierConfig;
      exotic_collector: TierConfig;
    };
    promo: {
      enabled: boolean;
      priceCents: number;
      label: string;
      endsAt: string | null; // ISO date; promo hidden after this
    };
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
        priceCents: 19900,
        blurb: 'Common unmodified domestic, Japanese and Korean passenger vehicles and light trucks.',
      },
      euro_luxury_performance: {
        key: 'euro_luxury_performance',
        label: 'European, Luxury or Performance PPI',
        priceCents: 29900,
        blurb: 'Examples include Corvette, BMW, Mercedes-Benz, Audi, Land Rover, Porsche, and modified or higher-complexity vehicles.',
      },
      exotic_collector: {
        key: 'exotic_collector',
        label: 'Exotic, Collector or Heavily Modified PPI',
        priceCents: 44900,
        blurb: 'Final quote required after reviewing the exact vehicle, location and inspection scope.',
      },
    },
    promo: {
      enabled: false,
      priceCents: 14900,
      label: 'Las Vegas launch price — Standard Vehicle PPI',
      endsAt: null,
    },
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

/** Is the launch promo currently active? */
export function promoActive(config: PpiConfig, now = new Date()): boolean {
  const p = config.pricing.promo;
  if (!p.enabled) return false;
  if (p.endsAt) {
    const ends = new Date(p.endsAt);
    if (!Number.isNaN(ends.getTime()) && now > ends) return false;
  }
  return true;
}
