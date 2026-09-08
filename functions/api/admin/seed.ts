// POST /api/admin/seed — clearly-labeled PREVIEW fixtures (spec §27).
// Hard-refuses in production. Idempotent: existing fixture evidence is kept.

import type { Env } from '../../lib/types.ts';
import { requireAdmin, auditLog } from '../../lib/auth.ts';
import { getConfig } from '../../lib/config.ts';
import { ensureAgreements, latestAgreements } from '../../lib/agreements.ts';
import { suggestTier, estimateTravel, basePriceForTier, travelFeeForMiles, computeQuoteTotals } from '../../lib/pricing.ts';
import { errorJson, json, newId, nowIso, originAllowed } from '../../lib/util.ts';

interface Fixture {
  refSuffix: string;
  name: string;
  email: string;
  vehicle: { year: number; make: string; model: string; trim: string; vin: string | null; mileage: number; mod: 'stock' | 'light' | 'heavy'; title: 'clean' | 'salvage_rebuilt' | 'unknown' };
  zip: string;
  city: string;
  status: string;
  note: string;
}

const FIXTURES: Fixture[] = [
  { refSuffix: 'CAMRY', name: 'Test Customer (Fixture)', email: 'fixture+camry@example.com', vehicle: { year: 2019, make: 'Toyota', model: 'Camry', trim: 'SE', vin: '4T1B11HK5KU212345', mileage: 48000, mod: 'stock', title: 'clean' }, zip: '89117', city: 'Las Vegas', status: 'submitted', note: 'Standard 2019 Toyota Camry request' },
  { refSuffix: 'VETTE', name: 'Test Customer (Fixture)', email: 'fixture+corvette@example.com', vehicle: { year: 2019, make: 'Chevrolet', model: 'Corvette', trim: 'Grand Sport', vin: '1G1YY2D75K5100001', mileage: 21000, mod: 'stock', title: 'clean' }, zip: '89052', city: 'Henderson', status: 'ready_for_review', note: '2019 Chevrolet Corvette performance-tier request' },
  { refSuffix: 'EUROLX', name: 'Test Customer (Fixture)', email: 'fixture+bmw@example.com', vehicle: { year: 2021, make: 'BMW', model: '540i', trim: 'M Sport', vin: 'WBA53BJ05MWX00001', mileage: 30000, mod: 'stock', title: 'clean' }, zip: '89135', city: 'Las Vegas', status: 'quote_sent', note: 'European luxury request' },
  { refSuffix: 'LAMBO', name: 'Test Customer (Fixture)', email: 'fixture+lambo@example.com', vehicle: { year: 2020, make: 'Lamborghini', model: 'Huracán EVO', trim: '', vin: null, mileage: 8000, mod: 'stock', title: 'clean' }, zip: '89109', city: 'Las Vegas', status: 'ready_for_review', note: 'Exotic Lamborghini request' },
  { refSuffix: 'TUNER', name: 'Test Customer (Fixture)', email: 'fixture+tuner@example.com', vehicle: { year: 2015, make: 'Subaru', model: 'WRX STI', trim: 'Launch Edition', vin: 'JF1VA2M67F9800001', mileage: 88000, mod: 'heavy', title: 'clean' }, zip: '89104', city: 'Las Vegas', status: 'submitted', note: 'Modified tuner request' },
  { refSuffix: 'FARAWY', name: 'Test Customer (Fixture)', email: 'fixture+mesquite@example.com', vehicle: { year: 2018, make: 'Ford', model: 'F-150', trim: 'XLT', vin: '1FTEW1EP5JFA00001', mileage: 92000, mod: 'stock', title: 'clean' }, zip: '89027', city: 'Mesquite', status: 'submitted', note: 'Out-of-area custom-quote request' },
  { refSuffix: 'NOVIN', name: 'Test Customer (Fixture)', email: 'fixture+novin@example.com', vehicle: { year: 2016, make: 'Honda', model: 'Civic', trim: 'EX', vin: null, mileage: 70000, mod: 'stock', title: 'unknown' }, zip: '89121', city: 'Las Vegas', status: 'needs_info', note: 'Missing-VIN request' },
  { refSuffix: 'SELLER', name: 'Test Customer (Fixture)', email: 'fixture+seller@example.com', vehicle: { year: 2020, make: 'Kia', model: 'Telluride', trim: 'SX', vin: '5XYP5DHC5LG600001', mileage: 40000, mod: 'stock', title: 'clean' }, zip: '89014', city: 'Henderson', status: 'seller_access_pending', note: 'Seller-access-pending request' },
  { refSuffix: 'PAIDOK', name: 'Test Customer (Fixture)', email: 'fixture+paid@example.com', vehicle: { year: 2017, make: 'Lexus', model: 'RX 350', trim: 'F Sport', vin: '2T2BZMCA5HC100001', mileage: 61000, mod: 'stock', title: 'clean' }, zip: '89128', city: 'Las Vegas', status: 'confirmed', note: 'Paid/confirmed test appointment' },
  { refSuffix: 'CANCEL', name: 'Test Customer (Fixture)', email: 'fixture+cancel@example.com', vehicle: { year: 2014, make: 'Nissan', model: 'Altima', trim: 'S', vin: '1N4AL3AP0EC100001', mileage: 120000, mod: 'stock', title: 'clean' }, zip: '89030', city: 'North Las Vegas', status: 'refunded', note: 'Cancelled/refunded test appointment' },
];

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env } = context;
  if (!originAllowed(context.request, env.PUBLIC_BASE_URL, true)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  if (env.PPI_ENV === 'production') {
    return errorJson('forbidden', 'Fixtures are never seeded into production.', 403);
  }
  const auth = await requireAdmin(context.request, env);
  if (!auth.ok) return auth.response;
  const db = env.DB;
  const config = await getConfig(db);
  await ensureAgreements(db);
  const agreements = await latestAgreements(db);
  const now = nowIso();

  const created: string[] = [];
  for (const f of FIXTURES) {
    const customerId = newId('cus');
    const vehicleId = newId('veh');
    const requestId = newId('req');
    const ref = `PPI-FIXTURE-${f.refSuffix}`;
    const existing = await db
      .prepare(`SELECT id FROM ppi_requests WHERE ref = ? LIMIT 1`)
      .bind(ref)
      .first<{ id: string }>();
    if (existing) {
      created.push(ref);
      continue;
    }
    const tier = suggestTier({ year: f.vehicle.year, make: f.vehicle.make, model: f.vehicle.model, trim: f.vehicle.trim, modStatus: f.vehicle.mod, titleStatus: f.vehicle.title, startsDrives: 'yes' });
    const travel = estimateTravel(f.zip, config);

    await db.batch([
      db.prepare(`INSERT INTO customers (id, full_name, email, phone, preferred_contact, transactional_consent, marketing_consent, created_at, updated_at) VALUES (?, ?, ?, '7025550100', 'email', 1, 0, ?, ?)`).bind(customerId, f.name, f.email, now, now),
      db.prepare(`INSERT INTO vehicles (id, year, make, model, trim, mileage, vin, mod_status, title_status, starts_drives, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'yes', ?, ?)`).bind(vehicleId, f.vehicle.year, f.vehicle.make, f.vehicle.model, f.vehicle.trim || null, f.vehicle.mileage, f.vehicle.vin, f.vehicle.mod, f.vehicle.title, now, now),
      db.prepare(
        `INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, loc_city, loc_state, loc_zip, seller_type, lift_available, level_surface, perm_inspection, perm_scan, perm_road_test, perm_photos, perm_underbody, ack_access_dependent, time_window, travel_miles, travel_estimate_basis, suggested_tier, manual_review_reasons, internal_notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'NV', ?, 'dealership', 'unknown', 'yes', 1, 1, 'yes', 'yes', 'unknown', 1, 'flexible', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(requestId, ref, customerId, vehicleId, f.status, f.city, f.zip, travel.miles, travel.basis, tier.tier, JSON.stringify(tier.manualReasons), `PREVIEW FIXTURE — ${f.note}`, now, now),
      db.prepare(`INSERT INTO status_history (id, request_id, from_status, to_status, actor, reason, created_at) VALUES (?, ?, NULL, ?, 'system:seed', ?, ?)`).bind(newId('sh'), requestId, f.status, `Fixture: ${f.note}`, now),
    ]);

    // Rich states for selected fixtures.
    if (f.refSuffix === 'EUROLX' || f.refSuffix === 'PAIDOK' || f.refSuffix === 'CANCEL') {
      const { priceCents } = basePriceForTier(tier.tier, config);
      const fee = travel.miles !== null ? (travelFeeForMiles(travel.miles, config).feeCents ?? 0) : 0;
      const lines = [
        { kind: 'base' as const, label: config.pricing.tiers[tier.tier].label, amountCents: priceCents },
        ...(fee > 0 ? [{ kind: 'travel' as const, label: 'Mobile-service charge', amountCents: fee }] : []),
      ];
      const totals = computeQuoteTotals(lines);
      const quoteId = newId('qot');
      const quoteStatus = f.refSuffix === 'EUROLX' ? 'sent' : 'accepted';
      await db.batch([
        db.prepare(`INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, travel_cents, addons_cents, discount_cents, total_cents, expires_at, approved_by, created_at, updated_at) VALUES (?, ?, 1, 'draft', ?, 'usd', ?, ?, ?, ?, ?, ?, 'system:seed', ?, ?)`)
          .bind(quoteId, requestId, tier.tier, totals.subtotalCents, totals.travelCents, totals.addonsCents, totals.discountCents, totals.totalCents, new Date(Date.now() + 48 * 3600_000).toISOString(), now, now),
        ...lines.map((l, i) => db.prepare(`INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort) VALUES (?, ?, ?, ?, ?, ?)`).bind(newId('qli'), quoteId, l.kind, l.label, l.amountCents, i)),
        db.prepare(`UPDATE quotes SET status = ?, updated_at = ? WHERE id = ? AND status = 'draft'`).bind(quoteStatus, now, quoteId),
      ]);

      if (f.refSuffix === 'EUROLX') {
        // Offer three windows for the customer to choose from.
        const dayMs = 86_400_000;
        for (const [i, hhmm] of config.scheduling.slotTemplates.entries()) {
          const [hh, mm] = hhmm.split(':').map(Number);
          const start = new Date(Date.now() + (2 + i) * dayMs);
          start.setUTCHours((hh ?? 9) + 7, mm ?? 0, 0, 0); // approx Vegas summer offset
          const end = new Date(start.getTime() + config.scheduling.durationMin * 60_000);
          const blockedStart = new Date(start.getTime() - config.scheduling.travelBufferMin * 60_000);
          const blockedEnd = new Date(end.getTime() + config.scheduling.reportBufferMin * 60_000);
          await db.prepare(`INSERT INTO appointment_slots (id, request_id, starts_at, ends_at, blocked_starts_at, blocked_ends_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'offered', ?, ?)`)
            .bind(newId('slt'), requestId, start.toISOString(), end.toISOString(), blockedStart.toISOString(), blockedEnd.toISOString(), now, now)
            .run();
        }
      }

      if (f.refSuffix === 'PAIDOK' || f.refSuffix === 'CANCEL') {
        const start = new Date(Date.now() + (f.refSuffix === 'PAIDOK' ? 6 : -2) * 86_400_000);
        start.setUTCHours(16, 0, 0, 0);
        const end = new Date(start.getTime() + config.scheduling.durationMin * 60_000);
        const blockedStart = new Date(start.getTime() - config.scheduling.travelBufferMin * 60_000);
        const blockedEnd = new Date(end.getTime() + config.scheduling.reportBufferMin * 60_000);
        const slotId = newId('slt');
        const bookingId = newId('bkg');
        const paymentId = newId('pay');
        const isPaid = f.refSuffix === 'PAIDOK';
        await db.batch([
          db.prepare(`INSERT INTO appointment_slots (id, request_id, starts_at, ends_at, blocked_starts_at, blocked_ends_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(slotId, requestId, start.toISOString(), end.toISOString(), blockedStart.toISOString(), blockedEnd.toISOString(), isPaid ? 'confirmed' : 'cancelled', now, now),
          db.prepare(`INSERT INTO bookings (id, request_id, quote_id, slot_id, status, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(bookingId, requestId, quoteId, slotId, isPaid ? 'confirmed' : 'refunded', now, now, now),
          db.prepare(`INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent, amount_cents, status, refunded_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(paymentId, requestId, quoteId, bookingId, `cs_test_fixture_${f.refSuffix}`, `pi_test_fixture_${f.refSuffix}`, totals.totalCents, isPaid ? 'succeeded' : 'refunded', isPaid ? 0 : totals.totalCents, now, now),
          ...agreements.map((doc) =>
            db.prepare(`INSERT INTO agreement_acceptances (id, request_id, quote_id, agreement_version_id, typed_name, accepted, created_at) VALUES (?, ?, ?, ?, 'Test Customer (Fixture)', 1, ?)`).bind(newId('aa'), requestId, quoteId, doc.id, now),
          ),
        ]);
      }
    }
    created.push(ref);
  }

  await auditLog(db, auth.actor, 'seed_fixtures', 'ppi_request', null, { created });
  return json({ ok: true, created });
};
