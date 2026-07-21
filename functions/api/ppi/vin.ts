// POST /api/ppi/vin — VIN validation + NHTSA vPIC decode (cached, no secrets).
// Decoded data is a convenience, never authoritative; customers and admin can
// correct it. Degrades gracefully when vPIC is unreachable.

import type { Env } from '../../lib/types.ts';
import { validateVin, decodeVin } from '../../lib/vin.ts';
import { rateLimit } from '../../lib/ratelimit.ts';
import { clientIp, errorJson, json } from '../../lib/util.ts';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const limited = await rateLimit(env.DB, clientIp(request), 'vin_decode', 30, 3600);
  if (!limited.allowed) return errorJson('rate_limited', 'Too many VIN lookups. Please try again later.', 429);

  let body: { vin?: string };
  try {
    body = (await request.json()) as { vin?: string };
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }

  const validation = validateVin(String(body.vin ?? ''));
  if (!validation.ok) {
    return json({ valid: false, errors: validation.errors, normalized: validation.normalized });
  }

  const decoded = await decodeVin(env.DB, validation.normalized);
  return json({
    valid: true,
    normalized: validation.normalized,
    checkDigitValid: validation.checkDigitValid,
    decoded: decoded
      ? {
          year: decoded.year,
          make: decoded.make,
          model: decoded.model,
          trim: decoded.trim,
          series: decoded.series,
          bodyClass: decoded.bodyClass,
          fuelType: decoded.fuelType,
          driveType: decoded.driveType,
        }
      : null,
    decodeUnavailable: decoded === null,
  });
};
