// VIN handling: normalization, format validation, ISO 3779 check digit
// (advisory for North American VINs), and NHTSA vPIC decoding with a D1 cache
// and graceful outage behavior. No API key involved — vPIC is public.

export function normalizeVin(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface VinValidation {
  ok: boolean;
  normalized: string;
  errors: string[];
  checkDigitValid: boolean | null; // null when not applicable/undetermined
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function vinCheckDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const value = /[0-9]/.test(ch) ? Number(ch) : (TRANSLITERATION[ch] ?? 0);
    sum += value * WEIGHTS[i]!;
  }
  const rem = sum % 11;
  return rem === 10 ? 'X' : String(rem);
}

export function validateVin(raw: string): VinValidation {
  const normalized = normalizeVin(raw);
  const errors: string[] = [];
  if (normalized.length !== 17) {
    errors.push(`A modern VIN is 17 characters (got ${normalized.length}).`);
    return { ok: false, normalized, errors, checkDigitValid: null };
  }
  if (!VIN_RE.test(normalized)) {
    errors.push('VIN contains invalid characters (I, O and Q are never used).');
    return { ok: false, normalized, errors, checkDigitValid: null };
  }
  // Check digit is definitive only for North American VINs — advisory here.
  const checkDigitValid = vinCheckDigit(normalized) === normalized[8];
  return { ok: true, normalized, errors, checkDigitValid };
}

export interface VinDecoded {
  vin: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  series: string;
  bodyClass: string;
  engineCylinders: string;
  displacement: string;
  fuelType: string;
  driveType: string;
  plantCountry: string;
  errorText: string;
  source: 'nhtsa' | 'cache';
}

const VIN_CACHE_DAYS = 30;

export async function decodeVin(db: D1Database, vin: string): Promise<VinDecoded | null> {
  const normalized = normalizeVin(vin);
  if (!VIN_RE.test(normalized)) return null;

  const cached = await db
    .prepare(`SELECT decoded_json, fetched_at FROM vin_cache WHERE vin = ?`)
    .bind(normalized)
    .first<{ decoded_json: string; fetched_at: string }>();
  if (cached) {
    const ageDays = (Date.now() - new Date(cached.fetched_at).getTime()) / 86_400_000;
    if (ageDays < VIN_CACHE_DAYS) {
      try {
        return { ...(JSON.parse(cached.decoded_json) as VinDecoded), source: 'cache' };
      } catch {
        /* fall through to refetch */
      }
    }
  }

  let data: Record<string, string>;
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(normalized)}?format=json`,
      { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { Results?: Array<Record<string, string>> };
    const first = body.Results?.[0];
    if (!first) return null;
    data = first;
  } catch {
    return null; // outage → caller degrades gracefully; manual entry still works
  }

  const decoded: VinDecoded = {
    vin: normalized,
    year: data['ModelYear'] ?? '',
    make: data['Make'] ?? '',
    model: data['Model'] ?? '',
    trim: data['Trim'] ?? '',
    series: data['Series'] ?? '',
    bodyClass: data['BodyClass'] ?? '',
    engineCylinders: data['EngineCylinders'] ?? '',
    displacement: data['DisplacementL'] ?? '',
    fuelType: data['FuelTypePrimary'] ?? '',
    driveType: data['DriveType'] ?? '',
    plantCountry: data['PlantCountry'] ?? '',
    errorText: data['ErrorText'] ?? '',
    source: 'nhtsa',
  };

  await db
    .prepare(
      `INSERT INTO vin_cache (vin, decoded_json, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(vin) DO UPDATE SET decoded_json = excluded.decoded_json, fetched_at = excluded.fetched_at`,
    )
    .bind(normalized, JSON.stringify(decoded), new Date().toISOString())
    .run();

  return decoded;
}
