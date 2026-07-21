// POST /api/ppi/requests — public intake submission.
// Order of defenses: origin check → rate limit → Turnstile (server-side,
// mandatory) → validation → duplicate damper → create records → magic link →
// emails. Uploads attach afterwards via the returned portal token.

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { getConfig } from '../../lib/config.ts';
import { parseIntake } from '../../lib/validate.ts';
import { validateVin } from '../../lib/vin.ts';
import { suggestTier, estimateTravel } from '../../lib/pricing.ts';
import { verifyTurnstile } from '../../lib/turnstile.ts';
import { rateLimit } from '../../lib/ratelimit.ts';
import { issueMagicLink, portalUrl } from '../../lib/magic.ts';
import { sendTemplate } from '../../lib/email.ts';
import { clientIp, errorJson, json, newId, newRef, nowIso, originAllowed, toCents } from '../../lib/util.ts';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const flags = modeFlags(env);

  if (flags.mode === 'waitlist') {
    return errorJson('waitlist_mode', 'Inspection requests are not open yet — join the launch list instead.', 409);
  }
  if (!originAllowed(request, env.PUBLIC_BASE_URL)) {
    return errorJson('bad_origin', 'Cross-origin submissions are not accepted.', 403);
  }

  const ip = clientIp(request);
  const limited = await rateLimit(env.DB, ip, 'ppi_submit', 5, 3600);
  if (!limited.allowed) {
    return errorJson('rate_limited', 'Too many submissions from this connection. Please try again later.', 429);
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorJson('bad_json', 'Request body must be JSON.', 400);
  }

  const turnstile = await verifyTurnstile(
    env.TURNSTILE_SECRET_KEY,
    flags.env === 'production',
    String(raw['turnstileToken'] ?? ''),
    ip,
  );
  if (!turnstile.ok) {
    return errorJson('turnstile_failed', 'Human verification failed. Please retry the check and submit again.', 403);
  }

  const { payload, errors } = parseIntake(raw);

  // VIN: optional at submission, but must be plausible when provided.
  let vinNormalized: string | null = null;
  if (payload.vin) {
    const vin = validateVin(payload.vin);
    if (!vin.ok) {
      errors['vin'] = vin.errors.join(' ') + ' You can also submit without a VIN and add it later.';
    } else {
      vinNormalized = vin.normalized;
    }
  }

  if (Object.keys(errors).length > 0) {
    return json({ error: { code: 'validation', message: 'Please correct the highlighted fields.' }, fields: errors }, 422);
  }

  // Duplicate damper: same email + same VIN (or same vehicle) with an open
  // request in the last 24h returns the existing reference instead of a copy.
  const existing = await env.DB
    .prepare(
      `SELECT r.id, r.ref FROM ppi_requests r
       JOIN customers c ON c.id = r.customer_id
       JOIN vehicles v ON v.id = r.vehicle_id
       WHERE c.email = ?
         AND (v.vin = ? OR (v.make = ? AND v.model = ? AND v.year IS ?))
         AND r.status NOT IN ('completed','customer_cancelled','admin_cancelled','expired','refunded')
         AND r.created_at > ?
         AND r.deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(
      payload.email,
      vinNormalized,
      payload.make,
      payload.model,
      payload.year,
      new Date(Date.now() - 24 * 3600_000).toISOString(),
    )
    .first<{ id: string; ref: string }>();

  const config = await getConfig(env.DB);

  if (existing) {
    const { token } = await issueMagicLink(env.DB, existing.id, config);
    return json({
      duplicate: true,
      ref: existing.ref,
      portalToken: token,
      message: 'We already have an open request for this vehicle — here is your existing reference.',
    });
  }

  const now = nowIso();
  const customerId = newId('cus');
  const vehicleId = newId('veh');
  const requestId = newId('req');
  const ref = newRef();

  const tierSuggestion = suggestTier({
    year: payload.year,
    make: payload.make,
    model: payload.model,
    trim: payload.trim,
    modStatus: payload.modStatus,
    titleStatus: payload.titleStatus,
    startsDrives: payload.startsDrives,
  });
  const travel = estimateTravel(payload.locZip, config);

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO customers (id, full_name, email, phone, preferred_contact, transactional_consent, marketing_consent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        customerId,
        payload.fullName,
        payload.email,
        payload.phone,
        payload.preferredContact,
        payload.transactionalConsent ? 1 : 0,
        payload.marketingConsent ? 1 : 0,
        now,
        now,
      ),
    env.DB
      .prepare(
        `INSERT INTO vehicles (id, year, make, model, trim, mileage, vin, asking_price_cents, expected_price_cents, listing_url,
                               mod_status, warning_lights, known_issues, title_status, starts_drives, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        vehicleId,
        payload.year,
        payload.make,
        payload.model,
        payload.trim || null,
        payload.mileage,
        vinNormalized,
        toCents(payload.askingPrice),
        toCents(payload.expectedPrice),
        payload.listingUrl || null,
        payload.modStatus,
        payload.warningLights || null,
        payload.knownIssues || null,
        payload.titleStatus,
        payload.startsDrives,
        now,
        now,
      ),
    env.DB
      .prepare(
        `INSERT INTO ppi_requests (
           id, ref, customer_id, vehicle_id, status,
           loc_street, loc_unit, loc_city, loc_state, loc_zip, seller_type, seller_name, seller_phone,
           loc_notes, access_notes, lift_available, level_surface,
           perm_inspection, perm_scan, perm_road_test, perm_photos, perm_underbody, ack_access_dependent,
           decision_timeline, preferred_dates, time_window, same_day_priority, customer_notes,
           travel_miles, travel_estimate_basis, suggested_tier, manual_review_reasons,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        requestId,
        ref,
        customerId,
        vehicleId,
        payload.locStreet || null,
        payload.locUnit || null,
        payload.locCity,
        payload.locState || 'NV',
        payload.locZip,
        payload.sellerType,
        payload.sellerName || null,
        payload.sellerPhone || null,
        payload.locNotes || null,
        payload.accessNotes || null,
        payload.liftAvailable,
        payload.levelSurface,
        payload.permInspection ? 1 : 0,
        payload.permScan ? 1 : 0,
        payload.permRoadTest,
        payload.permPhotos,
        payload.permUnderbody,
        payload.ackAccessDependent ? 1 : 0,
        payload.decisionTimeline || null,
        payload.preferredDates || null,
        payload.timeWindow,
        payload.sameDayPriority ? 1 : 0,
        payload.customerNotes || null,
        travel.miles,
        travel.basis,
        tierSuggestion.tier,
        JSON.stringify([...tierSuggestion.reasons.map((r) => `tier: ${r}`), ...tierSuggestion.manualReasons]),
        now,
        now,
      ),
    env.DB
      .prepare(
        `INSERT INTO status_history (id, request_id, from_status, to_status, actor, reason, created_at)
         VALUES (?, ?, NULL, 'submitted', 'customer', 'Intake form submitted', ?)`,
      )
      .bind(newId('sh'), requestId, now),
  ]);

  const { token } = await issueMagicLink(env.DB, requestId, config);
  const link = portalUrl(env.PUBLIC_BASE_URL ?? new URL(request.url).origin, token);

  // Emails are best-effort; the stored request is the source of truth.
  await sendTemplate(env, env.DB, requestId, 'request_received', payload.email, {
    ref,
    portalUrl: link,
    supportEmail: config.supportEmail,
  });
  if (env.ADMIN_NOTIFY_EMAIL) {
    await sendTemplate(
      env,
      env.DB,
      requestId,
      'owner_notify',
      env.ADMIN_NOTIFY_EMAIL,
      {
        ref,
        supportEmail: config.supportEmail,
        extra: {
          kind: 'new request',
          detail: `${payload.year ?? '?'} ${payload.make} ${payload.model} — ${payload.locCity} ${payload.locZip} — suggested tier ${tierSuggestion.tier}${tierSuggestion.manualReview ? ' (MANUAL REVIEW)' : ''}`,
          adminUrl: `${(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/ppi/admin/`,
        },
      },
      payload.email,
    );
  }

  return json({
    ok: true,
    ref,
    portalToken: token,
    reviewWindow: 'You will normally receive a response the same day and no later than 24 hours.',
  });
};
