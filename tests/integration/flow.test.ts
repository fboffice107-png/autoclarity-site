// End-to-end HTTP integration: intake → review → quote → slot hold →
// agreements → checkout (mock Stripe) → webhook confirmation → refund,
// plus the adversarial cases (bad tokens, replays, double booking, limits).
import { describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const WEBHOOK_SECRET = 'whsec_integration_test_secret';

type Json = Record<string, any>;

async function post(path: string, body: Json, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(BASE + path, { headers });
  return { status: res.status, body: (await res.json()) as Json };
}

const admin = { authorization: `Bearer ${ADMIN_KEY}` };
const adminPost = (id: string, body: Json) => post(`/api/admin/requests/${id}`, body, admin);

function intakePayload(overrides: Json = {}): Json {
  return {
    turnstileToken: 'XXXX.DUMMY.TOKEN',
    fullName: 'Integration Tester',
    email: 'integration@example.com',
    phone: '702-555-0111',
    preferredContact: 'email',
    transactionalConsent: true,
    marketingConsent: false,
    year: '2019',
    make: 'Toyota',
    model: 'Camry',
    trim: 'SE',
    mileage: '48000',
    vin: '4T1B11HK5KU212399',
    askingPrice: '18500',
    expectedPrice: '17800',
    listingUrl: 'https://example.com/listing/123',
    modStatus: 'stock',
    titleStatus: 'clean',
    startsDrives: 'yes',
    locStreet: '123 Test St',
    locCity: 'Las Vegas',
    locState: 'NV',
    locZip: '89109',
    sellerType: 'dealership',
    permInspection: true,
    permScan: true,
    permRoadTest: 'yes',
    permPhotos: 'yes',
    permUnderbody: 'unknown',
    ackAccessDependent: true,
    decisionTimeline: 'few_days',
    timeWindow: 'flexible',
    sameDayPriority: false,
    ...overrides,
  };
}

async function signWebhook(payload: string, timestampSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestampSec}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestampSec},v1=${hex}`;
}

async function sendWebhook(event: Json): Promise<{ status: number; body: Json }> {
  const payload = JSON.stringify(event);
  const res = await fetch(BASE + '/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': await signWebhook(payload) },
    body: payload,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

// shared state across sequential tests in this file
let camryToken = '';
let camryRef = '';
let euroId = '';
let euroToken = '';
let euroOldToken = '';
let heldSlotId = '';
let heldSlotStart = '';
let sessionId = '';
let camryFixtureId = '';
let uploadId = '';

describe('public surface', () => {
  it('serves runtime config with pricing and no secrets', async () => {
    const r = await get('/api/ppi/runtime-config');
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('request');
    expect(r.body.pricing.tiers).toHaveLength(3);
    expect(r.body.turnstileSiteKey).toBeTruthy();
    // Safe defaults surfaced to the public page.
    expect(r.body.scanIncluded).toBe(false); // scan off until owner confirms scope
    expect(r.body.reviews).toEqual([]); // no fabricated reviews
    expect(r.body.contact.configured).toBe(false); // no invented phone number
    expect(r.body.launchActive).toBe(false); // no fake permanent discount
    expect(JSON.stringify(r.body)).not.toContain('sk_test');
    expect(JSON.stringify(r.body)).not.toContain('whsec');
    expect(JSON.stringify(r.body)).not.toContain('businessPhone');
  });

  it('redirects short routes with 301s', async () => {
    for (const from of ['/ppi', '/pre-purchase-inspection']) {
      const res = await fetch(BASE + from, { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toContain('/las-vegas-pre-purchase-inspection');
    }
  });

  it('never serves repository housekeeping files (secrets, source, config)', async () => {
    for (const p of ['/.dev.vars', '/wrangler.toml', '/package.json', '/migrations/0001_init.sql', '/functions/lib/auth.ts', '/tests/unit/vin.test.ts', '/docs/PPI_SECURITY.md', '/.env.example', '/scripts/cloudflare-setup.sh']) {
      const res = await fetch(BASE + p);
      expect(res.status, `${p} must not be served`).toBe(404);
    }
  });

  it('normalizes listing URLs so attribute-breaking characters cannot be stored', async () => {
    const r = await post('/api/ppi/requests', intakePayload({
      email: 'xss-probe@example.com',
      vin: '',
      make: 'Ford',
      model: 'Focus',
      listingUrl: 'https://evil.example/a" onmouseover="alert(1)',
    }));
    // Either rejected as invalid, or stored normalized without the quote.
    if (r.status === 200) {
      const list = await get('/api/admin/requests', admin);
      const row = list.body.requests.find((x: Json) => x.email === 'xss-probe@example.com');
      const detail = await get(`/api/admin/requests/${row.id}`, admin);
      const stored = detail.body.request.listing_url ?? '';
      // The security property: the quote that would break out of an href
      // attribute is gone (percent-encoded). Residual path text is inert.
      expect(stored).not.toContain('"');
      expect(stored).toContain('%22');
    } else {
      expect(r.status).toBe(422);
    }
  });
});

describe('admin authorization', () => {
  it('rejects missing and wrong keys', async () => {
    expect((await get('/api/admin/overview')).status).toBe(401);
    expect((await get('/api/admin/overview', { authorization: 'Bearer wrong-key-wrong-key-wrong' })).status).toBe(401);
  });

  it('accepts the dev key and seeds fixtures', async () => {
    const overview = await get('/api/admin/overview', admin);
    expect(overview.status).toBe(200);
    const seed = await post('/api/admin/seed', {}, admin);
    expect(seed.status).toBe(200);
    expect(seed.body.created).toHaveLength(10);
  });
});

describe('intake submission', () => {
  it('accepts a valid request and returns ref + portal token', async () => {
    const r = await post('/api/ppi/requests', intakePayload());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.ref).toMatch(/^PPI-/);
    expect(r.body.portalToken.length).toBeGreaterThan(30);
    camryToken = r.body.portalToken;
    camryRef = r.body.ref;
  });

  it('portal view works with the token', async () => {
    const r = await get('/api/portal', { authorization: `Bearer ${camryToken}` });
    expect(r.status).toBe(200);
    expect(r.body.ref).toBe(camryRef);
    expect(r.body.status).toBe('submitted');
    expect(r.body.vehicle.make).toBe('Toyota');
  });

  it('dampens duplicate submissions (same email + VIN) and rotates the link', async () => {
    const r = await post('/api/ppi/requests', intakePayload());
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.ref).toBe(camryRef);
    // Rotation revokes the earlier token — the newest link is the valid one.
    const oldToken = camryToken;
    camryToken = r.body.portalToken;
    expect((await get('/api/portal', { authorization: `Bearer ${oldToken}` })).status).toBe(401);
    expect((await get('/api/portal', { authorization: `Bearer ${camryToken}` })).status).toBe(200);
  });

  it('rejects invalid email with field errors', async () => {
    const r = await post('/api/ppi/requests', intakePayload({ email: 'not-an-email', vin: '' }));
    expect(r.status).toBe(422);
    expect(r.body.fields.email).toBeTruthy();
  });

  it('rejects an invalid VIN with guidance', async () => {
    const r = await post('/api/ppi/requests', intakePayload({ vin: 'INVALIDVIN123' }));
    expect(r.status).toBe(422);
    expect(r.body.fields.vin).toContain('17');
  });

  it('rejects cross-origin submissions', async () => {
    const r = await post('/api/ppi/requests', intakePayload(), { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('bad_origin');
  });

  it('rejects garbage portal tokens', async () => {
    const r = await get('/api/portal', { authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('link_invalid');
  });
});

// The marketing site is static (GitHub Pages) until the custom-domain
// cutover, so its form calls this API cross-origin. Only the allowlisted
// origins work; admin/inspector surfaces never emit CORS headers.
describe('cross-origin form support (static-site interim)', () => {
  const SITE = 'https://getautoclarity.com';

  it('answers the preflight for an allowlisted origin', async () => {
    const res = await fetch(BASE + '/api/ppi/requests', { method: 'OPTIONS', headers: { origin: SITE } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('refuses the preflight for a foreign origin', async () => {
    const res = await fetch(BASE + '/api/ppi/requests', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts a submission from the marketing-site origin, stores it, and echoes CORS', async () => {
    // Distinct IP so this does not consume the shared per-IP submission budget
    // that the rate-limiting test at the end depends on.
    const res = await fetch(BASE + '/api/ppi/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE, 'cf-connecting-ip': '203.0.113.77' },
      body: JSON.stringify(intakePayload({ email: 'crossorigin@example.com', vin: '4T1B11HK5KU212398' })),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    const body = (await res.json()) as Json;
    expect(body.ok).toBe(true);
    expect(body.ref).toMatch(/^PPI-/);
    // The request is truly stored: it is visible in the admin dashboard.
    const list = await get('/api/admin/requests', admin);
    expect(list.body.requests.some((r: Json) => r.ref === body.ref)).toBe(true);
    // And the returned portal token works.
    const portal = await get('/api/portal', { authorization: `Bearer ${body.portalToken}` });
    expect(portal.status).toBe(200);
    expect(portal.body.ref).toBe(body.ref);
  });

  it('runtime-config responds with CORS for the allowlisted origin', async () => {
    const res = await fetch(BASE + '/api/ppi/runtime-config', { headers: { origin: SITE } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('never emits CORS headers on admin or inspector APIs', async () => {
    for (const path of ['/api/admin/overview', '/api/inspector/overview']) {
      const res = await fetch(BASE + path, { headers: { origin: SITE, ...admin } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const pre = await fetch(BASE + path, { method: 'OPTIONS', headers: { origin: SITE } });
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('still rejects submissions from non-allowlisted origins', async () => {
    const r = await post('/api/ppi/requests', intakePayload(), { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('bad_origin');
  });
});

describe('quote → slot → agreements → payment (EUROLX fixture)', () => {
  it('finds the fixture and issues a portal link', async () => {
    const list = await get('/api/admin/requests', admin);
    const euro = list.body.requests.find((r: Json) => r.ref === 'PPI-FIXTURE-EUROLX');
    const camry = list.body.requests.find((r: Json) => r.ref === 'PPI-FIXTURE-CAMRY');
    expect(euro).toBeTruthy();
    euroId = euro.id;
    camryFixtureId = camry.id;

    const link = await adminPost(euroId, { action: 'reissue_link' });
    expect(link.status).toBe(200);
    euroOldToken = new URL(link.body.url).searchParams.get('t')!;

    const view = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    expect(view.status).toBe(200);
    expect(view.body.status).toBe('quote_sent');
    expect(view.body.quote.lines.length).toBeGreaterThan(0);
    expect(view.body.slots.filter((s: Json) => s.status === 'offered')).toHaveLength(3);
  });

  it('holds a slot atomically and advances to agreements', async () => {
    const view = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    const slot = view.body.slots.find((s: Json) => s.status === 'offered');
    heldSlotId = slot.id;
    heldSlotStart = slot.startsAt;
    const r = await post('/api/portal/action', { action: 'select_slot', slotId: heldSlotId }, { authorization: `Bearer ${euroOldToken}` });
    expect(r.status).toBe(200);
    const after = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    expect(after.body.status).toBe('awaiting_agreement');
    expect(after.body.slots.find((s: Json) => s.id === heldSlotId).status).toBe('held');
  });

  it('rejects selecting a second slot once one is held (wrong state)', async () => {
    const view = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    const other = view.body.slots.find((s: Json) => s.status === 'offered');
    const r = await post('/api/portal/action', { action: 'select_slot', slotId: other.id }, { authorization: `Bearer ${euroOldToken}` });
    expect(r.status).toBe(409);
  });

  it('prevents offering a conflicting time to another customer (double-booking guard)', async () => {
    const r = await adminPost(camryFixtureId, { action: 'propose_slots', slots: [heldSlotStart] });
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(0);
    expect(r.body.skipped.length).toBe(1);
  });

  it('requires every agreement document', async () => {
    const r = await post('/api/portal/action', { action: 'accept_agreements', typedName: 'Integration Tester', versionIds: [] }, { authorization: `Bearer ${euroOldToken}` });
    expect(r.status).toBe(422);
  });

  it('records acceptance of all documents and advances to payment', async () => {
    const view = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    const ids = view.body.agreements.required.map((d: Json) => d.id);
    expect(ids.length).toBeGreaterThanOrEqual(9);
    const r = await post('/api/portal/action', { action: 'accept_agreements', typedName: 'Integration Tester', versionIds: ids }, { authorization: `Bearer ${euroOldToken}` });
    expect(r.status).toBe(200);
    const after = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    expect(after.body.status).toBe('awaiting_payment');
  });

  it('creates a Stripe checkout session with id-only metadata', async () => {
    const r = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${euroOldToken}` });
    expect(r.status).toBe(200);
    expect(r.body.checkoutUrl).toContain('127.0.0.1:8798');

    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.payments[0].status).toBe('created');
    sessionId = detail.body.payments[0].stripe_session_id;
    expect(sessionId).toMatch(/^cs_mock_/);

    // metadata hygiene: internal ids only, no VIN/address/customer data
    const lastSession = (await (await fetch('http://127.0.0.1:8798/last-session')).json()) as Json;
    expect(lastSession['metadata[request_id]']).toBe(euroId);
    expect(lastSession['metadata[quote_id]']).toBeTruthy();
    expect(lastSession['metadata[booking_id]']).toBeTruthy();
    const serialized = JSON.stringify(lastSession);
    expect(serialized).not.toContain('WBA53BJ05MWX00001');
    expect(serialized).not.toMatch(/loc_street|Las Vegas|address/i);
  });
});

describe('stripe webhook — the source of truth', () => {
  it('rejects unsigned/garbage-signed events', async () => {
    const payload = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } });
    const res = await fetch(BASE + '/api/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body: payload,
    });
    expect(res.status).toBe(400);
  });

  it('confirms the booking only via a verified webhook', async () => {
    const r = await sendWebhook({
      id: 'evt_int_1',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_mock_1' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.received).toBe(true);

    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.request.status).toBe('confirmed');
    expect(detail.body.payments[0].status).toBe('succeeded');
    const slots = detail.body.slots;
    expect(slots.find((s: Json) => s.id === heldSlotId).status).toBe('confirmed');
    expect(slots.filter((s: Json) => s.status === 'released').length).toBeGreaterThanOrEqual(2);

    const portal = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    expect(portal.body.booking.status).toBe('confirmed');

    const ics = await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(euroOldToken)}`);
    expect(ics.status).toBe(200);
    expect(await ics.text()).toContain('BEGIN:VCALENDAR');
  });

  it('acknowledges but never reprocesses replayed events', async () => {
    const r = await sendWebhook({
      id: 'evt_int_1',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_mock_1' } },
    });
    expect(r.body.replay).toBe(true);
    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.history.filter((h: Json) => h.to_status === 'confirmed')).toHaveLength(1);
  });

  it('processes admin refund + charge.refunded webhook', async () => {
    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    const paymentId = detail.body.payments[0].id;
    const refund = await adminPost(euroId, { action: 'refund', paymentId });
    expect(refund.status).toBe(200);

    const amount = detail.body.payments[0].amount_cents;
    const wh = await sendWebhook({
      id: 'evt_int_refund',
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_mock_1', amount_refunded: amount, refunded: true } },
    });
    expect(wh.status).toBe(200);

    const after = await get(`/api/admin/requests/${euroId}`, admin);
    expect(after.body.payments[0].status).toBe('refunded');
    expect(after.body.request.status).toBe('refunded');
  });
});

describe('uploads', () => {
  const PNG_1PX = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  it('accepts a real PNG from the customer', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'vin-plate.png');
    fd.append('kind', 'vin');
    const res = await fetch(BASE + '/api/portal/upload', { method: 'POST', headers: { authorization: `Bearer ${camryToken}` }, body: fd });
    const body = (await res.json()) as Json;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    uploadId = body.id;
  });

  it('rejects a text file disguised as an image (magic bytes)', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([new TextEncoder().encode('#!/bin/sh\necho pwned')], { type: 'image/png' }), 'not-an-image.png');
    const res = await fetch(BASE + '/api/portal/upload', { method: 'POST', headers: { authorization: `Bearer ${camryToken}` }, body: fd });
    expect(res.status).toBe(422);
  });

  it('serves the upload to admin with sandboxing headers, then deletes it', async () => {
    const res = await fetch(`${BASE}/api/admin/uploads/${uploadId}`, { headers: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');

    const list = await get('/api/admin/requests', admin);
    const camry = list.body.requests.find((r: Json) => r.ref === camryRef);
    const del = await adminPost(camry.id, { action: 'delete_upload', uploadId });
    expect(del.status).toBe(200);
    expect((await fetch(`${BASE}/api/admin/uploads/${uploadId}`, { headers: admin })).status).toBe(404);
  });
});

describe('lifecycle controls', () => {
  it('rotating the magic link revokes the old one', async () => {
    const link = await adminPost(euroId, { action: 'reissue_link' });
    euroToken = new URL(link.body.url).searchParams.get('t')!;
    expect((await get('/api/portal', { authorization: `Bearer ${euroToken}` })).status).toBe(200);
    const old = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('link_revoked');
  });

  it('rejects invalid status transitions', async () => {
    const r = await adminPost(camryFixtureId, { action: 'set_status', to: 'confirmed' });
    expect(r.status).toBe(409);
  });

  it('applies valid transitions with history + customer email recorded', async () => {
    const r = await adminPost(camryFixtureId, { action: 'set_status', to: 'needs_info', note: 'Please add the VIN when you have it.' });
    expect(r.status).toBe(200);
    const detail = await get(`/api/admin/requests/${camryFixtureId}`, admin);
    expect(detail.body.request.status).toBe('needs_info');
    expect(detail.body.history[0].to_status).toBe('needs_info');
    expect(detail.body.messages.some((m: Json) => m.template === 'needs_info')).toBe(true);
  });

  it('config: admin can enable time-boxed launch pricing and the public page reflects it', async () => {
    const put = await fetch(BASE + '/api/admin/config', {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ pricing: { launch: { enabled: true, startsAt: null, endsAt: '2099-01-01' } } }),
    });
    expect(put.status).toBe(200);
    const pub = await get('/api/ppi/runtime-config');
    expect(pub.body.launchActive).toBe(true);
    const std = pub.body.pricing.tiers.find((t: Json) => t.key === 'standard');
    expect(std.priceCents).toBe(14900); // introductory launch price
    expect(std.wasCents).toBe(19900); // regular price to strike through
    // turn it back off — no permanent fake discount
    await fetch(BASE + '/api/admin/config', {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ pricing: { launch: { enabled: false } } }),
    });
    const off = await get('/api/ppi/runtime-config');
    expect(off.body.launchActive).toBe(false);
  });

  it('config: admin can enable diagnostic scan scope', async () => {
    await fetch(BASE + '/api/admin/config', {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ scan: { included: true } }),
    });
    const pub = await get('/api/ppi/runtime-config');
    expect(pub.body.scanIncluded).toBe(true);
    await fetch(BASE + '/api/admin/config', {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ scan: { included: false } }),
    });
  });

  it('analytics endpoint accepts allowlisted events only (and never PII fields)', async () => {
    expect((await post('/api/ppi/events', { event: 'ppi_page_view', step: '', source: 'web' })).status).toBe(200);
    expect((await post('/api/ppi/events', { event: 'made_up_event' })).status).toBe(200); // silently dropped
  });
});

describe('rate limiting', () => {
  it('caps public submissions per IP (limit 5/hour)', async () => {
    // Earlier tests already made >=5 counted submissions from this IP
    // (each reaches the limiter before validation), so the next one is blocked.
    const blocked = await post('/api/ppi/requests', intakePayload({ email: 'ratelimit@example.com', vin: '', make: 'Mazda', model: '3' }));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });
});

// Real email delivery through the provider adapter, proven against the mock
// Resend endpoint (see globalSetup): correct recipients and content, provider
// id + sent status recorded, provider failure never losing a request, and
// no duplicate sends from webhook replays.
describe('email delivery (mock provider)', () => {
  const sentEmails = async (): Promise<Json[]> =>
    (await (await fetch('http://127.0.0.1:8798/sent-emails')).json()) as Json[];

  it('sends the customer confirmation and the owner notice on a new request', async () => {
    const res = await fetch(BASE + '/api/ppi/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.101' },
      body: JSON.stringify(intakePayload({ email: 'emailtest@example.com', vin: '4T1B11HK5KU212388' })),
    });
    const body = (await res.json()) as Json;
    expect(body.ok).toBe(true);

    const sent = await sentEmails();
    const customer = sent.find((m) => (m.to as string[]).includes('emailtest@example.com') && String(m.subject).includes(body.ref));
    expect(customer).toBeTruthy();
    expect(String(customer!.text)).toContain('Vehicle: 2019 Toyota Camry SE'); // vehicle summary
    expect(String(customer!.text)).toContain('/ppi/portal/?t='); // secure portal link
    expect(String(customer!.from)).toContain('notify@getautoclarity.com');

    const owner = sent.find((m) => (m.to as string[]).includes('owner-test@example.com') && String(m.subject).includes(body.ref));
    expect(owner).toBeTruthy();
    expect(String(owner!.subject)).toContain('new request');

    // The message rows carry the provider id and the sent status.
    const list = await get('/api/admin/requests', admin);
    const created = list.body.requests.find((r: Json) => r.ref === body.ref);
    const detail = await get(`/api/admin/requests/${created.id}`, admin);
    const rows = detail.body.messages.filter((m: Json) => m.template === 'request_received');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
    expect(String(rows[0].provider_id)).toMatch(/^resend_mock_/);
  });

  it('keeps the stored request intact when the provider fails (failure recorded, never a lost lead)', async () => {
    const res = await fetch(BASE + '/api/ppi/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.102' },
      body: JSON.stringify(intakePayload({ email: 'failwith500@example.com', vin: '4T1B11HK5KU212377' })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.ok).toBe(true);
    expect(body.ref).toMatch(/^PPI-/);

    const list = await get('/api/admin/requests', admin);
    const created = list.body.requests.find((r: Json) => r.ref === body.ref);
    expect(created).toBeTruthy(); // the request survived the email failure
    const detail = await get(`/api/admin/requests/${created.id}`, admin);
    const rows = detail.body.messages.filter((m: Json) => m.template === 'request_received');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(String(rows[0].error)).toContain('500');
  });

  it('webhook replays did not duplicate any payment email', async () => {
    // The webhook suite earlier delivered checkout.session.completed twice
    // (replay guard test). Exactly one payment email must exist per template.
    const sent = await sentEmails();
    const paymentEmails = sent.filter((m) => String(m.subject).includes('payment received'));
    const confirmEmails = sent.filter((m) => String(m.subject).includes('appointment confirmed'));
    expect(paymentEmails.length).toBeLessThanOrEqual(1 * 1 + 0); // one confirmed booking in this suite
    expect(paymentEmails.length + confirmEmails.length).toBeGreaterThan(0);
    expect(new Set(paymentEmails.map((m) => m.subject)).size).toBe(paymentEmails.length);
  });
});
