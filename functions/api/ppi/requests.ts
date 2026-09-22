// POST /api/ppi/requests — public intake submission.
// Order of defenses: origin check → rate limit → Turnstile (server-side,
// mandatory) → validation → duplicate damper → create records → magic link →
// emails. Uploads attach afterwards via the returned portal token.

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { getConfig } from '../../lib/config.ts';
import { parseIntake, normalizeUrl } from '../../lib/validate.ts';
import { validateVin } from '../../lib/vin.ts';
import { suggestTier, estimateTravel } from '../../lib/pricing.ts';
import { isTier, tierMismatch, type Tier } from '../../lib/vehicle-class.ts';
import { initialRecordKind } from '../../lib/record-kind.ts';
import { verifyTurnstile } from '../../lib/turnstile.ts';
import { rateLimit } from '../../lib/ratelimit.ts';
import { issueMagicLink, portalUrl } from '../../lib/magic.ts';
import { queueTemplate, type EmailResult } from '../../lib/email.ts';
import { persistNotificationIssue } from '../../lib/notification-issues.ts';
import { queueTransactionalSms } from '../../lib/sms.ts';
import { clientIp, errorJson, json, newId, newRef, nowIso, originAllowed, sha256Hex, toCents } from '../../lib/util.ts';
import { readJsonBody, requestBodyErrorResponse } from '../../lib/request-body.ts';

const SUBMISSION_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

function duplicateAcknowledgement(): Response {
  return json({
    ok: true,
    duplicate: true,
    emailStatus: 'not_sent',
    message: 'This request is already in our system. Please use the secure link in your original confirmation email or contact AutoClarity for help.',
  });
}

async function surfaceIntakeNotificationFailure(
  db: D1Database,
  requestId: string,
  result: EmailResult,
  sourceAction: 'request_received' | 'owner_new_request',
  dedupeKey: string,
): Promise<void> {
  if (result.status !== 'failed') return;
  console.error(JSON.stringify({
    event: 'intake_notification_failed',
    requestId,
    sourceAction,
    failure: result.failure ?? null,
  }));
  await persistNotificationIssue(db, {
    actor: 'system:intake',
    requestId,
    issueKey: result.issueKey ?? `outbox:${dedupeKey}`,
    kind: 'record_failed',
    sourceAction,
    template: sourceAction,
    dedupeKey,
    error: result.failure,
  });
}

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
    raw = await readJsonBody<Record<string, unknown>>(request);
  } catch (error) {
    return requestBodyErrorResponse(error);
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

  const config = await getConfig(env.DB);
  const { payload, errors } = parseIntake(raw);
  const smsAvailable = env.SMS_ENABLED === 'true'
    && Boolean(env.SMS_QUEUE)
    && config.contact.smsEnabled === true;
  if (payload.preferredContact === 'text' && !smsAvailable) {
    errors['preferredContact'] = 'Text updates are not currently available. Choose email or phone; transaction records are also sent by email.';
  }
  const rawSubmissionKey = typeof raw['submissionKey'] === 'string' ? raw['submissionKey'].trim() : '';
  const submissionKey = rawSubmissionKey || null;
  if (submissionKey && !SUBMISSION_KEY_RE.test(submissionKey)) {
    errors['submissionKey'] = 'Refresh the form and try again. Your saved answers will remain available.';
  }

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

  // A stable client key handles exact retries. The email + vehicle fingerprint
  // is a 24-hour server-side fallback for cached clients and simultaneous tabs
  // that generated different keys. Only hashes are stored in the claim table.
  const vehicleIdentity = vinNormalized
    ? `vin:${vinNormalized}`
    : `vehicle:${payload.year ?? ''}|${payload.make.trim().toLowerCase()}|${payload.model.trim().toLowerCase()}`;
  const intakeFingerprint = await sha256Hex(`ppi-intake-v1|${payload.email}|${vehicleIdentity}`);
  const claimCutoff = nowIso();
  await env.DB.prepare(`DELETE FROM intake_submission_claims WHERE expires_at <= ?`).bind(claimCutoff).run();

  // Duplicate damper: same email + same VIN (or same vehicle) with an open
  // request in the last 24h returns a generic acknowledgement instead of a
  // copy. Never rotate or expose the existing request's portal credentials.
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

  if (existing) {
    return duplicateAcknowledgement();
  }

  const now = nowIso();
  const customerId = newId('cus');
  const vehicleId = newId('veh');
  const requestId = newId('req');
  const ref = newRef();
  const claimId = newId('ic');
  const claimExpiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();

  const tierSuggestion = suggestTier({
    year: payload.year,
    make: payload.make,
    model: payload.model,
    trim: payload.trim,
    modStatus: payload.modStatus,
    modDetails: payload.modDetails,
    titleStatus: payload.titleStatus,
    startsDrives: payload.startsDrives,
  });
  const travel = estimateTravel(payload.locZip, config);

  // The customer's own choice is recorded as-is. It is never used to price
  // anything by itself — the owner reviews it — but disagreeing with the
  // engine is a fact worth keeping, and a mismatch is surfaced for review.
  const selectedTier: Tier | null = isTier(payload.selectedTier) ? payload.selectedTier : null;
  const selectionMismatch = selectedTier ? tierMismatch(tierSuggestion.tier, selectedTier) : null;
  const reviewReasons = [
    ...tierSuggestion.reasons.map((r) => `tier: ${r}`),
    ...tierSuggestion.manualReasons,
    ...(selectionMismatch ? [selectionMismatch.note] : []),
  ];

  try {
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
                               mod_status, mod_details, warning_lights, known_issues, title_status, starts_drives, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        payload.listingUrl ? normalizeUrl(payload.listingUrl) : null,
        payload.modStatus,
        payload.modDetails || null,
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
           id, ref, customer_id, vehicle_id, submission_key, status,
           loc_street, loc_unit, loc_city, loc_state, loc_zip, seller_type, seller_name, seller_phone,
           loc_notes, access_notes, lift_available, level_surface,
           perm_inspection, perm_scan, perm_road_test, perm_photos, perm_underbody, ack_access_dependent,
           decision_timeline, preferred_dates, time_window, same_day_priority, customer_notes,
           travel_miles, travel_estimate_basis, suggested_tier, manual_review_reasons,
           customer_selected_tier, tier_selection_source, tier_review_needed,
           record_kind,
           attribution_source,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        requestId,
        ref,
        customerId,
        vehicleId,
        submissionKey,
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
        JSON.stringify(reviewReasons),
        selectedTier,
        selectedTier ? (selectionMismatch ? 'customer' : 'suggested') : null,
        selectionMismatch || tierSuggestion.manualReview ? 1 : 0,
        // Real unless positively identified as a test. A genuine intake must
        // never be hidden from the dashboard by accident.
        initialRecordKind({ ref, email: payload.email, fullName: payload.fullName }),
        payload.attributionSource,
        now,
        now,
      ),
      env.DB
      .prepare(
        `INSERT INTO status_history (id, request_id, from_status, to_status, actor, reason, created_at)
         VALUES (?, ?, NULL, 'submitted', 'customer', 'Intake form submitted', ?)`,
      )
      .bind(newId('sh'), requestId, now),
      env.DB
        .prepare(
          `INSERT INTO intake_submission_claims (id, request_id, fingerprint, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(claimId, requestId, intakeFingerprint, claimExpiresAt, now),
    ]);
  } catch (e) {
    // Both uniqueness claims live in the same D1 transaction as the workflow.
    // A concurrent loser therefore creates no orphan customer/vehicle rows and
    // receives the same non-enumerating acknowledgement as a normal duplicate.
    const claimed = await env.DB
      .prepare(
        `SELECT request_id FROM intake_submission_claims
         WHERE fingerprint = ? AND expires_at > ?
         UNION ALL
         SELECT id AS request_id FROM ppi_requests
         WHERE submission_key = ? AND submission_key IS NOT NULL
         LIMIT 1`,
      )
      .bind(intakeFingerprint, nowIso(), submissionKey)
      .first<{ request_id: string }>();
    if (claimed) return duplicateAcknowledgement();
    throw e;
  }

  const base = (env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, '');
  let token: string | undefined;
  let link: string | undefined;
  try {
    const magic = await issueMagicLink(env.DB, requestId, config);
    token = magic.token;
    link = portalUrl(base, magic.token);
  } catch (e) {
    // The lead is already durably stored. A link/notification outage must not
    // invite a duplicate form submission by turning this response into a 500.
    console.error('intake_magic_link_failed', requestId, String(e).slice(0, 240));
  }

  const vehicle = `${payload.year ?? ''} ${payload.make} ${payload.model}${payload.trim ? ` ${payload.trim}` : ''}`.trim();
  const location = [payload.locStreet, payload.locUnit, payload.locCity, payload.locState || 'NV', payload.locZip].filter(Boolean).join(', ');
  const seller = [payload.sellerType, payload.sellerName, payload.sellerPhone].filter(Boolean).join(' · ');
  const timing = [payload.preferredDates, payload.decisionTimeline, payload.timeWindow, payload.sameDayPriority ? 'same-day priority requested' : ''].filter(Boolean).join(' · ');
  const concerns = [payload.knownIssues, payload.warningLights, payload.customerNotes].filter(Boolean).join(' · ');
  const access = [
    payload.locNotes,
    payload.accessNotes,
    `road test ${payload.permRoadTest}`,
    `photos ${payload.permPhotos}`,
    `underbody ${payload.permUnderbody}`,
    `lift ${payload.liftAvailable}`,
    `level surface ${payload.levelSurface}`,
  ].filter(Boolean).join(' · ');
  const waitUntil = (promise: Promise<unknown>) => context.waitUntil(promise);

  // Recording is awaited; provider delivery runs after the response. The
  // returned status is therefore honest (`recorded`, never prematurely sent).
  const customerEmailDedupeKey = `request_received:${requestId}`;
  const customerEmail = await queueTemplate(env, env.DB, requestId, 'request_received', payload.email, {
    ref,
    portalUrl: link,
    supportEmail: config.supportEmail,
    extra: {
      name: payload.fullName,
      vehicle,
      vin: vinNormalized || 'Not provided',
      email: payload.email,
      phone: payload.phone,
      preferredContact: payload.preferredContact,
      location,
      seller: seller || 'Not provided',
      timing: timing || 'Flexible',
      concerns: concerns || 'None provided',
      access,
    },
  }, waitUntil, undefined, customerEmailDedupeKey);
  await surfaceIntakeNotificationFailure(env.DB, requestId, customerEmail, 'request_received', customerEmailDedupeKey);
  if (env.ADMIN_NOTIFY_EMAIL) {
    const ownerEmailDedupeKey = `owner_new_request:${requestId}`;
    const ownerEmail = await queueTemplate(
      env,
      env.DB,
      requestId,
      'owner_new_request',
      env.ADMIN_NOTIFY_EMAIL,
      {
        ref,
        supportEmail: config.supportEmail,
        extra: {
          name: payload.fullName,
          email: payload.email,
          phone: payload.phone,
          preferredContact: payload.preferredContact,
          vehicle,
          vin: vinNormalized || 'Not provided',
          location,
          seller: seller || 'Not provided',
          timing: timing || 'Flexible',
          concerns: concerns || 'None provided',
          access,
          tier: `${tierSuggestion.tier}${tierSuggestion.manualReview ? ' — MANUAL REVIEW' : ''}`,
          adminUrl: `${base}/ppi/admin/?request=${encodeURIComponent(requestId)}`,
        },
      },
      waitUntil,
      payload.email,
      ownerEmailDedupeKey,
    );
    await surfaceIntakeNotificationFailure(env.DB, requestId, ownerEmail, 'owner_new_request', ownerEmailDedupeKey);
  }

  const smsStatus = await queueTransactionalSms(env, {
    requestId,
    template: 'request_received',
    to: payload.phone,
    body: `AutoClarity inspection update: we received request ${ref}. ${link ? `Track it securely: ${link}` : 'We will follow up by email.'}`,
    transactionalConsent: payload.transactionalConsent,
    requestedByCustomer: payload.preferredContact === 'text',
  });

  return json({
    ok: true,
    ref,
    requestRef: ref,
    ...(token ? { portalToken: token } : {}),
    emailStatus: customerEmail.status,
    smsStatus,
    reviewWindow: 'AutoClarity will review the vehicle, location, access, and requested timing, then follow up by email with next steps.',
  });
};
