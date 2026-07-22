// Approximate ZIP-code centroids for the Las Vegas metro area, used only to
// SUGGEST a travel band. Every suggestion is reviewed by the admin before a
// quote is sent, and unknown/far ZIPs fall back to custom review. This keeps
// travel estimation free of external geocoding services (no keys, no PII sent
// to third parties).

const ZIP_CENTROIDS: Record<string, [number, number]> = {
  // Las Vegas core
  '89101': [36.172, -115.122],
  '89102': [36.145, -115.187],
  '89103': [36.111, -115.21],
  '89104': [36.151, -115.109],
  '89106': [36.182, -115.163],
  '89107': [36.171, -115.21],
  '89108': [36.205, -115.224],
  '89109': [36.126, -115.163],
  '89110': [36.172, -115.055],
  '89113': [36.032, -115.262],
  '89115': [36.235, -115.043],
  '89117': [36.14, -115.28],
  '89118': [36.077, -115.213],
  '89119': [36.084, -115.13],
  '89120': [36.081, -115.093],
  '89121': [36.121, -115.091],
  '89122': [36.104, -115.042],
  '89123': [36.03, -115.148],
  '89128': [36.197, -115.264],
  '89129': [36.233, -115.288],
  '89130': [36.253, -115.229],
  '89131': [36.305, -115.244],
  '89134': [36.202, -115.306],
  '89135': [36.13, -115.327],
  '89138': [36.166, -115.355],
  '89139': [36.033, -115.21],
  '89141': [35.989, -115.208],
  '89142': [36.148, -115.04],
  '89143': [36.32, -115.288],
  '89144': [36.177, -115.317],
  '89145': [36.167, -115.278],
  '89146': [36.143, -115.226],
  '89147': [36.113, -115.28],
  '89148': [36.063, -115.297],
  '89149': [36.272, -115.288],
  '89156': [36.212, -115.031],
  '89158': [36.107, -115.176],
  '89166': [36.32, -115.32],
  '89169': [36.124, -115.14],
  '89178': [36.011, -115.288],
  '89179': [35.99, -115.24],
  '89183': [36.003, -115.155],
  // North Las Vegas
  '89030': [36.212, -115.124],
  '89031': [36.263, -115.171],
  '89032': [36.222, -115.17],
  '89081': [36.256, -115.104],
  '89084': [36.298, -115.185],
  '89085': [36.31, -115.19],
  '89086': [36.28, -115.1],
  // Henderson
  '89002': [36.005, -114.965],
  '89011': [36.083, -114.96],
  '89012': [36.012, -115.043],
  '89014': [36.061, -115.058],
  '89015': [36.037, -114.925],
  '89044': [35.955, -115.07],
  '89052': [35.995, -115.115],
  '89074': [36.038, -115.085],
  // Outlying Clark County (most land in the 16-40 mile bands or custom)
  '89005': [35.972, -114.846], // Boulder City
  '89004': [36.05, -115.4], // Blue Diamond
  '89124': [36.26, -115.64], // Mt. Charleston area
  '89027': [36.805, -114.077], // Mesquite — custom review distance
  '89040': [36.54, -114.44], // Overton
  '89025': [36.68, -114.63], // Moapa
  '89029': [35.15, -114.62], // Laughlin — custom review distance
  '89046': [35.47, -114.92], // Searchlight
  '89048': [36.21, -115.98], // Pahrump (Nye) — custom review distance
  '89060': [36.27, -116.0], // Pahrump north
};

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

/**
 * Straight-line miles from the configured service origin to the ZIP centroid,
 * padded 25% toward road distance. Returns null for unknown ZIPs (→ custom
 * review by the admin).
 */
export function estimateMilesFromZip(zip: string, originLat: number, originLng: number): number | null {
  const centroid = ZIP_CENTROIDS[zip.trim()];
  if (!centroid) return null;
  const straight = haversineMiles(originLat, originLng, centroid[0], centroid[1]);
  return Math.round(straight * 1.25 * 10) / 10;
}

export function knownZip(zip: string): boolean {
  return zip.trim() in ZIP_CENTROIDS;
}
