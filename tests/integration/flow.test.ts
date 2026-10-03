// End-to-end HTTP integration: intake → review → quote → slot hold →
// agreements → checkout (mock Stripe) → webhook confirmation → refund,
// plus the adversarial cases (bad tokens, replays, double booking, limits).
import { describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const WEBHOOK_SECRET = 'whsec_integration_test_secret';
// A fixed `created` for the event that is deliberately delivered twice.
const EVT_INT_1_CREATED = 1_800_000_000;

type Json = Record<string, any>;

async function post(path: string, body: Json, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
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

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function executeLocalD1(sql: string): Promise<void> {
  const response = await fetch('http://127.0.0.1:8798/test/d1', { method: 'POST', body: sql });
  if (!response.ok) throw new Error(`Local D1 test injection failed: ${await response.text()}`);
}

let submissionSequence = 0;
function intakePayload(overrides: Json = {}): Json {
  submissionSequence += 1;
  return {
    turnstileToken: 'XXXX.DUMMY.TOKEN',
    submissionKey: `integration_${String(submissionSequence).padStart(8, '0')}`,
    attributionSource: 'ppi_google_cpc',
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
    permScan: false,
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
  let enriched = event;
  if (
    (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded')
    && typeof event.data?.object?.id === 'string'
  ) {
    const mockSession = await fetch(`http://127.0.0.1:8798/test/session/${encodeURIComponent(event.data.object.id)}`);
    if (mockSession.ok) {
      enriched = {
        ...event,
        data: { object: { ...(await mockSession.json() as Json), ...event.data.object } },
      };
    }
  }
  const payload = JSON.stringify({ livemode: false, created: Math.floor(Date.now() / 1000), ...enriched });
  const res = await fetch(BASE + '/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': await signWebhook(payload) },
    body: payload,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function getProviderState(): Promise<Json> {
  return (await (await fetch('http://127.0.0.1:8798/test-state')).json()) as Json;
}

let agreementFixtureSequence = 0;

// Independent disposable requests keep invalid/historical evidence append-only.
// The normal owner-link and customer time-selection APIs are still exercised.
async function seedAgreementFixture(suffix: string): Promise<{
  requestId: string; quoteId: string; portalHeaders: Record<string, string>; view: Json;
}> {
  agreementFixtureSequence += 1;
  const requestId = `req_agreement_${suffix}`;
  const quoteId = `qot_agreement_${suffix}`;
  const slotId = `slt_agreement_${suffix}`;
  const customerId = `cus_agreement_${suffix}`;
  const vehicleId = `veh_agreement_${suffix}`;
  const now = new Date().toISOString();
  const start = new Date(Date.now() + (10 + agreementFixtureSequence) * 86_400_000);
  start.setUTCHours(20, 0, 0, 0);
  const startsAt = start.toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 2 * 3600_000).toISOString();
  await executeLocalD1(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES (${sqlLiteral(customerId)}, 'Agreement Fixture', ${sqlLiteral(`${suffix}@example.com`)}, '702-555-0189', ${sqlLiteral(now)}, ${sqlLiteral(now)});
    INSERT INTO vehicles (id, make, model, created_at, updated_at)
    VALUES (${sqlLiteral(vehicleId)}, 'Test', 'Agreement Vehicle', ${sqlLiteral(now)}, ${sqlLiteral(now)});
    INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, seller_type, inspection_location_type, perm_inspection, created_at, updated_at)
    VALUES (${sqlLiteral(requestId)}, ${sqlLiteral(`PPI-AGREEMENT-${suffix.toUpperCase()}`)}, ${sqlLiteral(customerId)}, ${sqlLiteral(vehicleId)}, 'quote_sent', 'private', 'private_residence', 1, ${sqlLiteral(now)}, ${sqlLiteral(now)});
    INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
    VALUES (${sqlLiteral(quoteId)}, ${sqlLiteral(requestId)}, 1, 'draft', 'standard', 'usd', 19900, 19900, '2041-01-01T00:00:00.000Z', 'test', ${sqlLiteral(now)}, ${sqlLiteral(now)});
    INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
    VALUES (${sqlLiteral(`qli_agreement_${suffix}`)}, ${sqlLiteral(quoteId)}, 'base', 'Standard Vehicle PPI', 19900, 0);
    UPDATE quotes SET status = 'sent' WHERE id = ${sqlLiteral(quoteId)};
    INSERT INTO appointment_slots (id, request_id, starts_at, ends_at, status, created_at, updated_at)
    VALUES (${sqlLiteral(slotId)}, ${sqlLiteral(requestId)}, ${sqlLiteral(startsAt)}, ${sqlLiteral(endsAt)}, 'offered', ${sqlLiteral(now)}, ${sqlLiteral(now)});
  `);
  const link = await adminPost(requestId, { action: 'reissue_link' });
  expect(link.status).toBe(200);
  const token = new URL(link.body.url).searchParams.get('t')!;
  const portalHeaders = {
    authorization: `Bearer ${token}`,
    'cf-connecting-ip': `198.51.100.${180 + agreementFixtureSequence}`,
  };
  const selection = await post('/api/portal/action', { action: 'select_slot', slotId }, portalHeaders);
  expect(selection.status, JSON.stringify(selection.body)).toBe(200);
  const view = await get('/api/portal', portalHeaders);
  expect(view.status).toBe(200);
  expect(view.body.status).toBe('awaiting_agreement');
  return { requestId, quoteId, portalHeaders, view: view.body };
}

let checkoutWebhookFixtureSequence = 0;

interface CheckoutWebhookFixtureOptions {
  paymentStatus?: 'created' | 'succeeded' | 'partially_refunded' | 'refunded' | 'disputed';
  requestStatus?: 'awaiting_payment' | 'confirmed' | 'refunded' | 'disputed';
  bookingStatus?: 'pending_payment' | 'confirmed' | 'cancelled' | 'refunded';
  slotStatus?: 'held' | 'confirmed' | 'released';
  refundedCents?: number;
  storePaymentIntent?: boolean;
}

async function seedCheckoutWebhookFixture(
  suffix: string,
  options: CheckoutWebhookFixtureOptions = {},
): Promise<{
  requestId: string;
  quoteId: string;
  bookingId: string;
  slotId: string;
  paymentId: string;
  sessionId: string;
  paymentIntent: string;
  object: (paymentStatus: 'paid' | 'unpaid') => Json;
}> {
  checkoutWebhookFixtureSequence += 1;
  const requestId = `req_checkout_${suffix}`;
  const quoteId = `qot_checkout_${suffix}`;
  const bookingId = `bkg_checkout_${suffix}`;
  const slotId = `slt_checkout_${suffix}`;
  const paymentId = `pay_checkout_${suffix}`;
  const sessionId = `cs_checkout_${suffix}`;
  const paymentIntent = `pi_checkout_${suffix}`;
  const customerId = `cus_checkout_${suffix}`;
  const vehicleId = `veh_checkout_${suffix}`;
  const createdAt = new Date().toISOString();
  const startsAt = new Date(Date.UTC(2032, 0, checkoutWebhookFixtureSequence, 20, 0, 0)).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + 2 * 3600_000).toISOString();
  const holdExpiresAt = options.slotStatus === 'held' || options.slotStatus === undefined
    ? new Date(Date.now() + 2 * 3600_000).toISOString()
    : null;
  const paymentStatus = options.paymentStatus ?? 'created';
  const requestStatus = options.requestStatus ?? 'awaiting_payment';
  const bookingStatus = options.bookingStatus ?? 'pending_payment';
  const slotStatus = options.slotStatus ?? 'held';
  const storedPaymentIntent = options.storePaymentIntent === false ? 'NULL' : sqlLiteral(paymentIntent);

  await executeLocalD1(`
    INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
    VALUES (${sqlLiteral(customerId)}, 'Checkout Webhook Fixture', ${sqlLiteral(`${suffix}@example.com`)}, '702-555-0188', ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)});
    INSERT INTO vehicles (id, make, model, created_at, updated_at)
    VALUES (${sqlLiteral(vehicleId)}, 'Test', 'Checkout Webhook', ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)});
    INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
    VALUES (${sqlLiteral(requestId)}, ${sqlLiteral(`PPI-CHECKOUT-${suffix.toUpperCase()}`)}, ${sqlLiteral(customerId)}, ${sqlLiteral(vehicleId)}, ${sqlLiteral(requestStatus)}, ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)});
    INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
    VALUES (${sqlLiteral(quoteId)}, ${sqlLiteral(requestId)}, 1, 'draft', 'standard', 'usd', 19900, 19900, '2033-01-01T00:00:00.000Z', 'test', ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)});
    INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
    VALUES (${sqlLiteral(`qli_checkout_${suffix}`)}, ${sqlLiteral(quoteId)}, 'base', 'Standard Vehicle PPI', 19900, 0);
    UPDATE quotes SET status = ${sqlLiteral(requestStatus === 'awaiting_payment' ? 'sent' : 'accepted')} WHERE id = ${sqlLiteral(quoteId)};
    INSERT INTO appointment_slots (id, request_id, starts_at, ends_at, status, hold_expires_at, created_at, updated_at)
    VALUES (${sqlLiteral(slotId)}, ${sqlLiteral(requestId)}, ${sqlLiteral(startsAt)}, ${sqlLiteral(endsAt)}, ${sqlLiteral(slotStatus)}, ${holdExpiresAt ? sqlLiteral(holdExpiresAt) : 'NULL'}, ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)});
    INSERT INTO bookings (id, request_id, quote_id, slot_id, status, created_at, updated_at)
    VALUES (${sqlLiteral(bookingId)}, ${sqlLiteral(requestId)}, ${sqlLiteral(quoteId)}, ${sqlLiteral(slotId)}, ${sqlLiteral(bookingStatus)}, ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)});
    INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent, amount_cents, currency, status, refunded_cents, created_at, updated_at)
    VALUES (${sqlLiteral(paymentId)}, ${sqlLiteral(requestId)}, ${sqlLiteral(quoteId)}, ${sqlLiteral(bookingId)}, ${sqlLiteral(sessionId)}, ${storedPaymentIntent}, 19900, 'usd', ${sqlLiteral(paymentStatus)}, ${options.refundedCents ?? 0}, ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)});
  `);

  return {
    requestId,
    quoteId,
    bookingId,
    slotId,
    paymentId,
    sessionId,
    paymentIntent,
    object: (paymentStatus) => ({
      id: sessionId,
      payment_status: paymentStatus,
      payment_intent: paymentIntent,
      amount_total: 19900,
      currency: 'usd',
      client_reference_id: bookingId,
      metadata: {
        request_id: requestId,
        quote_id: quoteId,
        booking_id: bookingId,
      },
    }),
  };
}

// shared state across sequential tests in this file
let camryToken = '';
let camryRef = '';
let euroId = '';
let euroToken = '';
let euroOldToken = '';
let heldSlotId = '';
let heldSlotStart = '';
let replacementSlotId = '';
let sessionId = '';
let camryFixtureId = '';
let uploadId = '';
let confirmedVetteId = '';
let confirmedVetteToken = '';
let confirmedVettePaymentId = '';
const camrySubmissionKey = 'integration_camry_primary_0001';

describe('public surface', () => {
  it('serves the static discovery documents with safe public content types', async () => {
    const catalog = await fetch(BASE + '/autoclarity-services.json');
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('content-type')).toContain('application/json');
    expect(((await catalog.json()) as Json).offerings).toHaveLength(2);

    const llms = await fetch(BASE + '/llms.txt');
    expect(llms.status).toBe(200);
    expect(llms.headers.get('content-type')).toContain('text/plain');
    expect(await llms.text()).toContain('two separate offerings');

    const key = await fetch(BASE + '/170f59a6dd75523c8f9318a7ae04ae2e.txt');
    expect(key.status).toBe(200);
    expect(key.headers.get('content-type')).toContain('text/plain');
    expect((await key.text()).trim()).toBe('170f59a6dd75523c8f9318a7ae04ae2e');
  });

  it('serves runtime config with pricing and no secrets', async () => {
    const r = await get('/api/ppi/runtime-config');
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('request');
    expect(r.body.pricing.tiers).toHaveLength(3);
    expect(r.body.turnstileSiteKey).toBeTruthy();
    // Safe defaults surfaced to the public page.
    expect(r.body.scanIncluded).toBe(false); // scan off until owner confirms scope
    expect(r.body.smsAvailable).toBe(false); // no queue/provider is bound
    expect(r.body.reviews).toEqual([]); // no fabricated reviews
    expect(r.body.contact.configured).toBe(false); // no invented phone number
    expect(r.body.launchActive).toBe(false); // no fake permanent discount
    expect(r.body.paymentsEnabled).toBe(true); // effective preview + test tuple
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
    for (const p of ['/.dev.vars', '/wrangler.toml', '/wrangler.local.toml', '/package.json', '/migrations/0001_init.sql', '/functions/lib/auth.ts', '/tests/unit/vin.test.ts', '/docs/PPI_SECURITY.md', '/.env.example', '/scripts/cloudflare-setup.sh']) {
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
      const list = await get('/api/admin/requests?include=test', admin);
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

  it('rejects unsafe admin origins and non-JSON media before mutation', async () => {
    const missingOrigin = await fetch(BASE + '/api/admin/seed', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missingOrigin.status).toBe(403);

    const crossOrigin = await fetch(BASE + '/api/admin/config', {
      method: 'PUT',
      headers: { ...admin, origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(crossOrigin.status).toBe(403);

    const wrongType = await fetch(BASE + '/api/admin/config', {
      method: 'PUT',
      headers: { ...admin, origin: BASE, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
  });
});

describe('intake submission', () => {
  it('accepts a valid request and returns ref + portal token', async () => {
    const r = await post('/api/ppi/requests', intakePayload({ submissionKey: camrySubmissionKey }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.ref).toMatch(/^PPI-/);
    expect(r.body.requestRef).toBe(r.body.ref);
    expect(r.body.portalToken.length).toBeGreaterThan(30);
    expect(r.body.emailStatus).toBe('recorded');
    camryToken = r.body.portalToken;
    camryRef = r.body.ref;
    const list = await get('/api/admin/requests?include=test', admin);
    expect(list.body.requests.find((row: Json) => row.ref === camryRef).attribution_source).toBe('ppi_google_cpc');
  });

  it('portal view works with the token', async () => {
    const r = await get('/api/portal', { authorization: `Bearer ${camryToken}` });
    expect(r.status).toBe(200);
    expect(r.body.ref).toBe(camryRef);
    expect(r.body.status).toBe('submitted');
    expect(r.body.vehicle.make).toBe('Toyota');
  });

  it('dampens duplicate submissions without exposing or rotating the existing link', async () => {
    const oldToken = camryToken;
    const r = await post('/api/ppi/requests', intakePayload({ submissionKey: camrySubmissionKey }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.emailStatus).toBe('not_sent');
    expect(r.body).not.toHaveProperty('ref');
    expect(r.body).not.toHaveProperty('requestRef');
    expect(r.body).not.toHaveProperty('portalToken');
    expect((await get('/api/portal', { authorization: `Bearer ${oldToken}` })).status).toBe(200);
    const list = await get('/api/admin/requests?include=test', admin);
    expect(list.body.requests.filter((row: Json) => row.ref === camryRef)).toHaveLength(1);
  });

  it('atomically collapses simultaneous tabs with different submission keys', async () => {
    const base = {
      email: 'concurrent-intake@example.com',
      vin: '',
      year: '2020',
      make: 'Honda',
      model: 'Civic',
    };
    const [a, b] = await Promise.all([
      post('/api/ppi/requests', intakePayload({ ...base, submissionKey: 'integration_concurrent_tab_a' }), { 'cf-connecting-ip': '203.0.113.77' }),
      post('/api/ppi/requests', intakePayload({ ...base, submissionKey: 'integration_concurrent_tab_b' }), { 'cf-connecting-ip': '203.0.113.77' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const fresh = [a.body, b.body].find((body) => body.duplicate !== true);
    const duplicate = [a.body, b.body].find((body) => body.duplicate === true);
    expect(fresh?.portalToken).toBeTruthy();
    expect(duplicate?.emailStatus).toBe('not_sent');
    expect(duplicate).not.toHaveProperty('ref');
    expect(duplicate).not.toHaveProperty('portalToken');

    const list = await get('/api/admin/requests?include=test', admin);
    expect(list.body.requests.filter((row: Json) => row.email === base.email)).toHaveLength(1);
  });

  it('records rich deduplicated receipts, a direct owner link, and a safe retry state', async () => {
    const list = await get('/api/admin/requests?include=test', admin);
    const row = list.body.requests.find((item: Json) => item.ref === camryRef);
    const detail = await get(`/api/admin/requests/${row.id}`, admin);
    const customer = detail.body.messages.find((message: Json) => message.template === 'request_received');
    const owner = detail.body.messages.find((message: Json) => message.template === 'owner_new_request');

    expect(customer.body_text).toContain('Integration Tester');
    expect(customer.body_text).toContain('integration@example.com');
    expect(customer.body_text).toContain('702-555-0111');
    expect(customer.body_text).toContain('2019 Toyota Camry SE');
    expect(customer.body_text).toContain('Access / restrictions');
    expect(customer.dedupe_key).toBe(`request_received:${row.id}`);
    expect(owner.body_text).toContain(`/ppi/admin/?request=${row.id}`);
    expect(owner.dedupe_key).toBe(`owner_new_request:${row.id}`);

    const overview = await get('/api/admin/overview', admin);
    expect(typeof overview.body.notificationIssues).toBe('number');

    const retry = await adminPost(row.id, { action: 'retry_email', messageId: customer.id });
    expect(retry.status).toBe(503);
    expect(retry.body.error.code).toBe('email_provider_unavailable');
    expect(retry.body.error.messageId).toBe(customer.id);
    expect(retry.body.error.emailStatus).toBe('recorded');
  });

  it('keeps durable record failures visible, deduplicated, and bounded on the admin overview', async () => {
    const list = await get('/api/admin/requests?include=test', admin);
    const affected = list.body.requests.find((item: Json) => item.ref === camryRef);
    const oldOnly = list.body.requests.find((item: Json) => item.id !== affected.id);
    const before = await get('/api/admin/overview', admin);
    const beforeHadAffected = (before.body.notificationIssueRequests || []).some((issue: Json) => issue.requestId === affected.id);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const details = JSON.stringify({
      issueKey: `outbox:owner_new_request:${affected.id}`,
      sourceAction: 'owner_new_request',
      dedupeKey: `owner_new_request:${affected.id}:missing`,
    });
    const oldDetails = JSON.stringify({
      issueKey: `outbox:expired_visibility_probe:${oldOnly.id}`,
      sourceAction: 'expired_visibility_probe',
    });
    const resolvedLinkDetails = JSON.stringify({
      issueKey: `link:${oldOnly.id}:send_message`,
      sourceAction: 'send_message',
    });
    const actionResolutionDetails = JSON.stringify({ sourceAction: 'send_message' });
    const resolvedAt = new Date(Date.now() + 1).toISOString();
    await executeLocalD1(
      `INSERT INTO admin_audit_log (id, actor, action, entity, entity_id, details_json, created_at) VALUES ` +
      `('al_int_notify_1','system:test','notification_record_failed','ppi_request',${sqlLiteral(affected.id)},${sqlLiteral(details)},${sqlLiteral(now)}),` +
      `('al_int_notify_2','system:test','notification_record_failed','ppi_request',${sqlLiteral(affected.id)},${sqlLiteral(details)},${sqlLiteral(now)}),` +
      `('al_int_notify_old','system:test','notification_record_failed','ppi_request',${sqlLiteral(oldOnly.id)},${sqlLiteral(oldDetails)},${sqlLiteral(old)}),` +
      `('al_int_notify_link','system:test','notification_link_failed','ppi_request',${sqlLiteral(oldOnly.id)},${sqlLiteral(resolvedLinkDetails)},${sqlLiteral(now)}),` +
      `('al_int_notify_resolved','system:test','notification_issue_resolved','ppi_request',${sqlLiteral(oldOnly.id)},${sqlLiteral(actionResolutionDetails)},${sqlLiteral(resolvedAt)});`,
    );

    const after = await get('/api/admin/overview', admin);
    expect(after.body.notificationIssues).toBe(before.body.notificationIssues + (beforeHadAffected ? 0 : 1));
    const visible = after.body.notificationIssueRequests.filter((issue: Json) => issue.requestId === affected.id);
    expect(visible).toHaveLength(1);
    expect(visible[0].issueCount).toBe(1);
    expect(visible[0].sourceActions).toContain('owner_new_request');
    const oldSummary = after.body.notificationIssueRequests.find((issue: Json) => issue.requestId === oldOnly.id);
    expect(oldSummary?.sourceActions ?? []).not.toContain('expired_visibility_probe');
    expect(oldSummary?.sourceActions ?? []).not.toContain('send_message');

    await executeLocalD1(
      `INSERT INTO messages (id, request_id, direction, channel, template, to_email, subject, body_text, status, created_at, dedupe_key) ` +
      `VALUES ('msg_int_notify_recovered',${sqlLiteral(affected.id)},'outbound','email','owner_new_request','owner@example.com',` +
      `'Recovered owner notification','Recovered owner notification','recorded',${sqlLiteral(now)},` +
      `${sqlLiteral(`owner_new_request:${affected.id}:missing`)});`,
    );
    const recovered = await get('/api/admin/overview', admin);
    const recoveredSummary = recovered.body.notificationIssueRequests.find((issue: Json) => issue.requestId === affected.id);
    expect(recoveredSummary?.sourceActions ?? []).not.toContain('owner_new_request');
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

  it('rejects stale or crafted diagnostic-scan permission while the capability is unreleased', async () => {
    const r = await post(
      '/api/ppi/requests',
      intakePayload({ email: 'scan-gate@example.com', vin: '', permScan: true }),
      { 'cf-connecting-ip': '203.0.113.181' },
    );
    expect(r.status).toBe(422);
    expect(r.body.fields.permScan).toContain('not part');
  });

  it('rejects a text preference when no transactional SMS consumer is available', async () => {
    const r = await post(
      '/api/ppi/requests',
      intakePayload({ email: 'sms-gate@example.com', vin: '', preferredContact: 'text' }),
      { 'cf-connecting-ip': '203.0.113.182' },
    );
    expect(r.status).toBe(422);
    expect(r.body.fields.preferredContact).toContain('not currently available');
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

describe('quote → slot → agreements → payment (EUROLX fixture)', () => {
  it('finds the fixture and issues a portal link', async () => {
    const list = await get('/api/admin/requests?include=test', admin);
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
    const created = await post('/api/ppi/requests', intakePayload({ submissionKey: 'manual_conflict_quoted_fixture', email: 'conflict@example.com' }), { 'cf-connecting-ip': '192.0.2.230' });
    expect(created.status).toBe(200);
    const list = await get('/api/admin/requests?include=test', admin);
    const id = list.body.requests.find((row: Json) => row.ref === created.body.requestRef).id;
    await adminPost(id, { action: 'set_status', to: 'ready_for_review' });
    const quote = await adminPost(id, { action: 'create_quote', tier: 'standard', basePriceCents: 19900 });
    expect((await adminPost(id, { action: 'send_quote', quoteId: quote.body.quoteId })).status).toBe(200);
    const r = await adminPost(id, { action: 'propose_slots', slots: [heldSlotStart] });
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(0);
    expect(r.body.skipped.length).toBe(1);
  });

  it('requires every agreement document', async () => {
    const r = await post('/api/portal/action', { action: 'accept_agreements', typedName: 'Integration Tester', versionIds: [] }, { authorization: `Bearer ${euroOldToken}` });
    expect(r.status).toBe(422);
  });

  it('rejects a non-current agreement id even when every current id is also supplied', async () => {
    const portalHeaders = { authorization: `Bearer ${euroOldToken}`, 'cf-connecting-ip': '198.51.100.71' };
    const view = await get('/api/portal', portalHeaders);
    const first = view.body.agreements.required[0];
    const historicalId = 'ag_int_historical_extra';
    await executeLocalD1(
      `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at) VALUES (` +
      `${sqlLiteral(historicalId)},${sqlLiteral(first.docKey)},-100,'Historical test copy','Historical test copy','test-sha',${sqlLiteral(new Date().toISOString())});`,
    );
    const ids = view.body.agreements.required.map((doc: Json) => doc.id);
    const r = await post('/api/portal/action', {
      action: 'accept_agreements',
      typedName: 'Integration Tester',
      versionIds: [...ids, historicalId],
    }, portalHeaders);
    expect(r.status).toBe(422);
    expect((await get('/api/portal', portalHeaders)).body.status).toBe('awaiting_agreement');
  });

  it('blocks checkout for retained stale same-count, wrong-quote, and unaccepted evidence; rejects new null-quote evidence', async () => {
    const view = await get('/api/portal', { authorization: `Bearer ${euroOldToken}`, 'cf-connecting-ip': '198.51.100.72' });
    const required = view.body.agreements.required as Json[];
    const now = new Date().toISOString();
    const historical = required.map((doc, index) => ({ id: `ag_int_stale_${index}`, docKey: doc.docKey }));
    await executeLocalD1(
      historical.map((doc) =>
        `INSERT INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at) VALUES (` +
        `${sqlLiteral(doc.id)},${sqlLiteral(doc.docKey)},-200,'Historical test copy','Historical test copy',` +
        `${sqlLiteral(`test-sha-${doc.id}`)},${sqlLiteral(now)})`,
      ).join(';') + ';',
    );

    const cases = [
      { name: 'stale same-count versions', suffix: 'stale', ids: historical.map((doc) => doc.id), accepted: 1 },
      { name: 'wrong quote', suffix: 'wrong', ids: required.map((doc) => doc.id), accepted: 1 },
      { name: 'null quote', suffix: 'null', ids: required.map((doc) => doc.id), accepted: 1 },
      { name: 'accepted=0', suffix: 'declined', ids: required.map((doc) => doc.id), accepted: 0 },
    ];
    for (const [caseIndex, scenario] of cases.entries()) {
      const fixture = await seedAgreementFixture(scenario.suffix);
      let quote = sqlLiteral(fixture.quoteId);
      if (scenario.suffix === 'wrong') {
        const wrongQuoteId = 'qot_int_wrong_acceptance_quote';
        await executeLocalD1(
          `INSERT INTO quotes (id, request_id, version, status, tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at) ` +
          `SELECT ${sqlLiteral(wrongQuoteId)}, request_id, 2, 'draft', tier, currency, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at FROM quotes WHERE id = ${sqlLiteral(fixture.quoteId)};` +
          `INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort) ` +
          `SELECT 'qli_wrong_acceptance_' || id, ${sqlLiteral(wrongQuoteId)}, kind, label, amount_cents, sort FROM quote_line_items WHERE quote_id = ${sqlLiteral(fixture.quoteId)};` +
          `UPDATE quotes SET status = 'superseded' WHERE id = ${sqlLiteral(wrongQuoteId)};`,
        );
        quote = sqlLiteral(wrongQuoteId);
      } else if (scenario.suffix === 'null') quote = 'NULL';
      const rows = scenario.ids.map((agreementId, index) =>
        `(${sqlLiteral(`aa_int_invalid_${caseIndex}_${index}`)},${sqlLiteral(fixture.requestId)},${quote},` +
        `${sqlLiteral(agreementId)},'Invalid fixture',${scenario.accepted},${sqlLiteral(now)})`,
      ).join(',');
      const insert = `INSERT INTO agreement_acceptances (id, request_id, quote_id, agreement_version_id, typed_name, accepted, created_at) VALUES ${rows};`;
      if (scenario.suffix === 'null') {
        await expect(executeLocalD1(insert)).rejects.toThrow(/same-request committed quote/);
      } else await executeLocalD1(insert);
      await executeLocalD1(`UPDATE ppi_requests SET status = 'awaiting_payment' WHERE id = ${sqlLiteral(fixture.requestId)};`);
      const before = await get(`/api/admin/requests/${fixture.requestId}`, admin);
      expect(before.body.acceptances).toHaveLength(scenario.suffix === 'null' ? 0 : required.length);
      const checkout = await post('/api/portal/action', { action: 'checkout' }, fixture.portalHeaders);
      expect(checkout.status, scenario.name).toBe(409);
      expect(checkout.body.error.code, scenario.name).toBe('agreements_missing');
      const after = await get(`/api/admin/requests/${fixture.requestId}`, admin);
      expect(after.body.acceptances).toEqual(before.body.acceptances);
      expect(after.body.payments).toHaveLength(0);
      // Release disposable scheduling capacity through the real unpaid-cancel
      // path, retaining its agreement/history rows for subsequent assertions.
      expect((await post('/api/portal/action', { action: 'cancel' }, fixture.portalHeaders)).status).toBe(200);
      expect((await get(`/api/admin/requests/${fixture.requestId}`, admin)).body.acceptances)
        .toEqual(before.body.acceptances);
    }
  });

  it('records one exact quote-bound acceptance set and advances with a checked CAS', async () => {
    const portalHeaders = { authorization: `Bearer ${euroOldToken}`, 'cf-connecting-ip': '198.51.100.73' };
    const view = await get('/api/portal', portalHeaders);
    const ids = view.body.agreements.required.map((d: Json) => d.id);
    expect(ids.length).toBeGreaterThanOrEqual(9);
    const [first, second] = await Promise.all([
      post('/api/portal/action', { action: 'accept_agreements', typedName: 'Integration Tester', versionIds: ids }, portalHeaders),
      post('/api/portal/action', { action: 'accept_agreements', typedName: 'Integration Tester', versionIds: ids }, portalHeaders),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const after = await get('/api/portal', portalHeaders);
    expect(after.body.status).toBe('awaiting_payment');
    expect(after.body.agreements.accepted.sort()).toEqual(ids.sort());
    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.acceptances).toHaveLength(ids.length);
    expect(detail.body.acceptances.every((acceptance: Json) => acceptance.quote_id === view.body.quote.id && acceptance.accepted === 1)).toBe(true);
    expect(detail.body.history.filter((entry: Json) => entry.to_status === 'awaiting_payment')).toHaveLength(1);
  });

  it('lets an awaiting-payment customer append current acceptance while preserving historical versions and the held time', async () => {
    const fixture = await seedAgreementFixture('reaccept');
    const { portalHeaders, requestId } = fixture;
    const now = new Date().toISOString();
    // Model prior acceptance under older terms without deleting or mutating it.
    await executeLocalD1(
      `INSERT INTO agreement_acceptances (id, request_id, quote_id, agreement_version_id, typed_name, accepted, created_at) ` +
      `SELECT 'aa_reaccept_' || id, ${sqlLiteral(requestId)}, ${sqlLiteral(fixture.quoteId)}, id, 'Original Fixture Buyer', 1, ${sqlLiteral(now)} ` +
      `FROM agreement_versions WHERE id LIKE 'ag_int_stale_%';` +
      `UPDATE ppi_requests SET status = 'awaiting_payment' WHERE id = ${sqlLiteral(requestId)};`,
    );
    const before = await get('/api/portal', portalHeaders);
    const ids = before.body.agreements.required.map((doc: Json) => doc.id);
    const heldSlot = before.body.slots.find((slot: Json) => slot.status === 'held');
    expect(before.body.status).toBe('awaiting_payment');
    expect(heldSlot).toBeTruthy();
    expect(before.body.agreements.accepted).toHaveLength(0);
    const historical = (await get(`/api/admin/requests/${requestId}`, admin)).body.acceptances;
    expect(historical).toHaveLength(ids.length);

    const accepted = await post('/api/portal/action', {
      action: 'accept_agreements',
      typedName: 'Integration Tester',
      versionIds: ids,
    }, portalHeaders);
    expect(accepted.status).toBe(200);

    const after = await get('/api/portal', portalHeaders);
    expect(after.body.status).toBe('awaiting_payment');
    expect(after.body.agreements.accepted.sort()).toEqual(ids.sort());
    expect(after.body.slots.find((slot: Json) => slot.id === heldSlot.id).status).toBe('held');
    const duplicate = await post('/api/portal/action', {
      action: 'accept_agreements',
      typedName: 'Integration Tester',
      versionIds: ids,
    }, portalHeaders);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('wrong_state');

    const detail = await get(`/api/admin/requests/${requestId}`, admin);
    expect(detail.body.acceptances).toHaveLength(ids.length * 2);
    expect(detail.body.acceptances.filter((row: Json) => row.id.startsWith('aa_reaccept_'))).toEqual(historical);
    expect(detail.body.history.some((entry: Json) =>
      entry.from_status === 'awaiting_payment'
      && entry.to_status === 'awaiting_payment'
      && entry.reason === 'Current agreement versions accepted')).toBe(true);
    expect((await post('/api/portal/action', { action: 'cancel' }, portalHeaders)).status).toBe(200);
    expect((await get(`/api/admin/requests/${requestId}`, admin)).body.acceptances).toEqual(detail.body.acceptances);
  });

  it('rejects agreement-evidence tampering during Checkout creation without changing accepted facts', async () => {
    const portalHeaders = { authorization: `Bearer ${euroOldToken}`, 'cf-connecting-ip': '198.51.100.74' };
    const view = await get('/api/portal', portalHeaders);
    const doc = view.body.agreements.required[0] as Json;
    const providerBefore = await getProviderState();

    expect((await fetch('http://127.0.0.1:8798/test/delay-next-checkout', { method: 'POST' })).status).toBe(200);
    const checkoutPromise = post('/api/portal/action', { action: 'checkout' }, portalHeaders);
    let waiting = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await getProviderState()).checkoutWaiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(true);

    const evidenceBefore = (await get(`/api/admin/requests/${euroId}`, admin)).body.acceptances;
    try {
      await expect(executeLocalD1(
        `UPDATE agreement_acceptances SET accepted = 0 ` +
        `WHERE request_id = ${sqlLiteral(euroId)} AND quote_id = ${sqlLiteral(view.body.quote.id)} ` +
        `AND agreement_version_id = ${sqlLiteral(doc.id)};`,
      )).rejects.toThrow(/agreement acceptances are immutable/);
    } finally {
      expect((await fetch('http://127.0.0.1:8798/test/release-checkout', { method: 'POST' })).status).toBe(200);
    }

    const checkout = await checkoutPromise;
    expect(checkout.status).toBe(200);

    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.acceptances).toEqual(evidenceBefore);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.payments[0].status).toBe('created');
    const providerAfter = await getProviderState();
    expect(providerAfter.sessionCount).toBe(providerBefore.sessionCount + 1);
    expect(providerAfter.expiredSessions).not.toContain(detail.body.payments[0].stripe_session_id);
    expect(detail.body.request.status).toBe('awaiting_payment');
    expect((await get('/api/portal', portalHeaders)).body.booking.status).toBe('pending_payment');
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

    const retry = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${euroOldToken}` });
    expect(retry.status).toBe(200);
    expect(retry.body.checkoutUrl).toBe(r.body.checkoutUrl);
    const afterRetry = await get(`/api/admin/requests/${euroId}`, admin);
    expect(afterRetry.body.payments).toHaveLength(1);
    expect(afterRetry.body.payments[0].stripe_session_id).toBe(sessionId);

    // A new provider attempt is allowed only after Stripe verifies expiry.
    const expired = await sendWebhook({
      id: 'evt_int_checkout_expired',
      type: 'checkout.session.expired',
      data: { object: { id: sessionId } },
    });
    expect(expired.status).toBe(200);
    const reopened = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${euroOldToken}` });
    expect(reopened.status).toBe(200);
    expect(reopened.body.checkoutUrl).not.toBe(r.body.checkoutUrl);
    sessionId = new URL(reopened.body.checkoutUrl).pathname.split('/').pop()!;
    const afterVerifiedExpiry = await get(`/api/admin/requests/${euroId}`, admin);
    expect(afterVerifiedExpiry.body.payments).toHaveLength(2);
    expect(afterVerifiedExpiry.body.payments.some((payment: Json) => payment.status === 'expired')).toBe(true);

    // metadata hygiene: internal ids only, no VIN/address/customer data
    const lastSession = (await (await fetch('http://127.0.0.1:8798/last-session')).json()) as Json;
    expect(lastSession['metadata[request_id]']).toBe(euroId);
    expect(lastSession['metadata[quote_id]']).toBeTruthy();
    expect(lastSession['metadata[booking_id]']).toBeTruthy();
    expect(lastSession._idempotencyKey).toContain(lastSession['metadata[booking_id]']);
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

  it('validates and acknowledges completed-unpaid, then confirms only on async success', async () => {
    const fixture = await seedCheckoutWebhookFixture('delayed_success', { storePaymentIntent: false });
    const unpaid = fixture.object('unpaid');

    const mismatched = await sendWebhook({
      id: 'evt_delayed_completed_unpaid_mismatch',
      type: 'checkout.session.completed',
      data: { object: { ...unpaid, metadata: { ...unpaid.metadata, booking_id: 'bkg_wrong_untrusted' } } },
    });
    expect(mismatched.status).toBe(500);
    expect(mismatched.body.error.code).toBe('processing_failed');

    const completed = await sendWebhook({
      id: 'evt_delayed_completed_unpaid_success_path',
      type: 'checkout.session.completed',
      data: { object: unpaid },
    });
    expect(completed.status).toBe(200);

    const waiting = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(waiting.body.request.status).toBe('awaiting_payment');
    expect(waiting.body.payments[0].status).toBe('created');
    expect(waiting.body.payments[0].stripe_payment_intent).toBeNull();
    expect(waiting.body.slots.find((slot: Json) => slot.id === fixture.slotId).status).toBe('held');

    const succeeded = await sendWebhook({
      id: 'evt_delayed_async_payment_succeeded',
      type: 'checkout.session.async_payment_succeeded',
      data: { object: fixture.object('paid') },
    });
    expect(succeeded.status).toBe(200);

    const confirmed = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(confirmed.body.request.status).toBe('confirmed');
    expect(confirmed.body.payments[0].status).toBe('succeeded');
    expect(confirmed.body.payments[0].stripe_payment_intent).toBe(fixture.paymentIntent);
    expect(confirmed.body.slots.find((slot: Json) => slot.id === fixture.slotId).status).toBe('confirmed');
  });

  it('validates and acknowledges completed-unpaid, then lets async failure resolve without fulfillment', async () => {
    const fixture = await seedCheckoutWebhookFixture('delayed_failure', { storePaymentIntent: false });
    const completed = await sendWebhook({
      id: 'evt_delayed_completed_unpaid_failure_path',
      type: 'checkout.session.completed',
      data: { object: fixture.object('unpaid') },
    });
    expect(completed.status).toBe(200);

    const failed = await sendWebhook({
      id: 'evt_delayed_async_payment_failed',
      type: 'checkout.session.async_payment_failed',
      data: { object: fixture.object('unpaid') },
    });
    expect(failed.status).toBe(200);

    const after = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(after.body.request.status).toBe('awaiting_payment');
    expect(after.body.payments[0].status).toBe('failed');
    expect(after.body.payments[0].stripe_payment_intent).toBeNull();
    expect(after.body.slots.find((slot: Json) => slot.id === fixture.slotId).status).toBe('held');
    expect(after.body.messages).toHaveLength(0);
  });

  it('retries a Refund delivered before Checkout maps its PaymentIntent, but acknowledges a clearly unrelated Refund', async () => {
    const unrelated = await sendWebhook({
      id: 'evt_unrelated_charge_refund',
      type: 'refund.created',
      created: 2400,
      data: {
        object: {
          id: 're_unrelated_charge_refund',
          object: 'refund',
          created: 2300,
          payment_intent: null,
          amount: 100,
          currency: 'usd',
          status: 'succeeded',
          metadata: {},
        },
      },
    });
    expect(unrelated.status).toBe(200);

    const fixture = await seedCheckoutWebhookFixture('refund_before_success', { storePaymentIntent: false });
    const earlyRefund = {
      id: 'evt_refund_before_checkout_success',
      type: 'refund.created',
      created: 2600,
      data: {
        object: {
          id: 're_refund_before_checkout_success',
          object: 'refund',
          created: 2500,
          payment_intent: fixture.paymentIntent,
          amount: 5000,
          currency: 'usd',
          status: 'succeeded',
          metadata: {},
        },
      },
    };
    const beforeMapping = await sendWebhook(earlyRefund);
    expect(beforeMapping.status).toBe(500);
    const before = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(before.body.payments[0].status).toBe('created');
    expect(before.body.payments[0].stripe_payment_intent).toBeNull();
    expect(before.body.providerRefunds).toHaveLength(0);

    expect((await sendWebhook({
      id: 'evt_checkout_success_after_early_refund',
      type: 'checkout.session.async_payment_succeeded',
      data: { object: fixture.object('paid') },
    })).status).toBe(200);
    expect((await sendWebhook(earlyRefund)).status).toBe(200);

    const reconciled = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(reconciled.body.request.status).toBe('confirmed');
    expect(reconciled.body.payments[0].stripe_payment_intent).toBe(fixture.paymentIntent);
    expect(reconciled.body.payments[0].status).toBe('partially_refunded');
    expect(reconciled.body.payments[0].refunded_cents).toBe(5000);
    expect(reconciled.body.providerRefunds).toHaveLength(1);

    const knownRefundWithoutPaymentIntent = await sendWebhook({
      id: 'evt_known_refund_missing_payment_intent',
      type: 'refund.updated',
      created: 2700,
      data: {
        object: {
          ...earlyRefund.data.object,
          payment_intent: null,
          metadata: {},
        },
      },
    });
    expect(knownRefundWithoutPaymentIntent.status).toBe(500);

    const localMetadataWithoutPaymentIntent = await sendWebhook({
      id: 'evt_local_refund_metadata_missing_payment_intent',
      type: 'refund.created',
      created: 2800,
      data: {
        object: {
          id: 're_local_metadata_missing_payment_intent',
          object: 'refund',
          created: 2750,
          payment_intent: null,
          amount: 100,
          currency: 'usd',
          status: 'pending',
          metadata: { refund_operation_id: 'rop_local_hint', refund_attempt_no: '1' },
        },
      },
    });
    expect(localMetadataWithoutPaymentIntent.status).toBe(500);
  });

  it('preserves an open dispute while recording a succeeded Refund balance', async () => {
    const fixture = await seedCheckoutWebhookFixture('refund_during_dispute', {
      paymentStatus: 'disputed',
      requestStatus: 'disputed',
      bookingStatus: 'cancelled',
      slotStatus: 'released',
    });
    const response = await sendWebhook({
      id: 'evt_refund_during_dispute',
      type: 'refund.created',
      created: 2800,
      data: {
        object: {
          id: 're_refund_during_dispute',
          object: 'refund',
          created: 2700,
          payment_intent: fixture.paymentIntent,
          amount: 19900,
          currency: 'usd',
          status: 'succeeded',
          metadata: {},
        },
      },
    });
    expect(response.status).toBe(200);

    const after = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(after.body.request.status).toBe('disputed');
    expect(after.body.payments[0].status).toBe('disputed');
    expect(after.body.payments[0].refunded_cents).toBe(19900);
    expect(after.body.slots.find((slot: Json) => slot.id === fixture.slotId).status).toBe('released');
    expect(after.body.messages.some((message: Json) => message.dedupe_key?.startsWith('refund_issued:'))).toBe(false);

    const failedRefund = {
      id: 'evt_refund_during_dispute_failed',
      type: 'refund.failed',
      created: 2900,
      data: {
        object: {
          id: 're_refund_during_dispute',
          object: 'refund',
          created: 2700,
          payment_intent: fixture.paymentIntent,
          amount: 19900,
          currency: 'usd',
          status: 'failed',
          failure_reason: 'late failure while dispute remains open',
          metadata: {},
        },
      },
    };
    await executeLocalD1(`
      CREATE TRIGGER test_disputed_refund_reconciliation_fault
      BEFORE INSERT ON messages
      WHEN NEW.request_id = ${sqlLiteral(fixture.requestId)}
        AND NEW.dedupe_key = ${sqlLiteral(`portal_refund_reconcile:${fixture.paymentId}:re_refund_during_dispute`)}
      BEGIN
        SELECT RAISE(ABORT, 'simulated disputed refund reconciliation fault');
      END;
    `);
    let interruptedFailure: { status: number; body: Json };
    try {
      interruptedFailure = await sendWebhook(failedRefund);
    } finally {
      await executeLocalD1(`DROP TRIGGER test_disputed_refund_reconciliation_fault;`);
    }
    expect(interruptedFailure!.status).toBe(500);
    const interrupted = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(interrupted.body.request.status).toBe('disputed');
    expect(interrupted.body.payments[0].status).toBe('disputed');
    expect(interrupted.body.payments[0].refunded_cents).toBe(0);
    expect(interrupted.body.messages.some(
      (message: Json) => message.dedupe_key === `portal_refund_reconcile:${fixture.paymentId}:re_refund_during_dispute`,
    )).toBe(false);

    expect((await sendWebhook(failedRefund)).status).toBe(200);
    const repaired = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(repaired.body.request.status).toBe('disputed');
    expect(repaired.body.payments[0].status).toBe('disputed');
    expect(repaired.body.payments[0].refunded_cents).toBe(0);
    expect(repaired.body.slots.find((slot: Json) => slot.id === fixture.slotId).status).toBe('released');
    expect(repaired.body.messages.some(
      (message: Json) => message.dedupe_key === `portal_refund_reconcile:${fixture.paymentId}:re_refund_during_dispute`,
    )).toBe(true);
    expect(repaired.body.messages.some(
      (message: Json) => message.dedupe_key === `refund_reconciliation_customer:${fixture.paymentId}:re_refund_during_dispute`,
    )).toBe(true);
    expect(repaired.body.messages.some(
      (message: Json) => message.dedupe_key === `owner_refund_reconciliation:${fixture.paymentId}:re_refund_during_dispute`,
    )).toBe(true);
  });

  it('keeps a concurrently fully refunded payment visibly disputed', async () => {
    const fixture = await seedCheckoutWebhookFixture('refund_dispute_race', {
      paymentStatus: 'succeeded',
      requestStatus: 'confirmed',
      bookingStatus: 'confirmed',
      slotStatus: 'confirmed',
    });
    const refundEvent = {
      id: 'evt_refund_dispute_race_refund',
      type: 'refund.created',
      created: 3200,
      data: {
        object: {
          id: 're_refund_dispute_race',
          object: 'refund',
          created: 3100,
          payment_intent: fixture.paymentIntent,
          amount: 19900,
          currency: 'usd',
          status: 'succeeded',
          metadata: {},
        },
      },
    };
    const disputeEvent = {
      id: 'evt_refund_dispute_race_dispute',
      type: 'charge.dispute.created',
      created: 3300,
      data: {
        object: {
          id: 'du_refund_dispute_race',
          object: 'dispute',
          created: 3050,
          payment_intent: fixture.paymentIntent,
          charge: 'ch_refund_dispute_race',
          amount: 19900,
          currency: 'usd',
          status: 'needs_response',
        },
      },
    };
    const initial = await Promise.all([sendWebhook(refundEvent), sendWebhook(disputeEvent)]);
    for (let index = 0; index < initial.length; index++) {
      if (initial[index]!.status !== 200) {
        const retry = await sendWebhook(index === 0 ? refundEvent : disputeEvent);
        expect(retry.status).toBe(200);
      }
    }

    const detail = await get(`/api/admin/requests/${fixture.requestId}`, admin);
    expect(detail.body.request.status).toBe('disputed');
    expect(detail.body.payments[0].status).toBe('disputed');
    expect(detail.body.payments[0].refunded_cents).toBe(19900);
    expect(detail.body.slots.find((slot: Json) => slot.id === fixture.slotId).status).toBe('released');
    expect(detail.body.providerRefunds).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_refund_id: 're_refund_dispute_race', status: 'succeeded' }),
    ]));
    expect(detail.body.paymentDisputes).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_dispute_id: 'du_refund_dispute_race', provider_status: 'needs_response' }),
    ]));
  });

  it('acknowledges late success after refund/dispute without regressing terminal commerce state', async () => {
    const cases: Array<{
      suffix: string;
      paymentStatus: 'partially_refunded' | 'refunded' | 'disputed';
      requestStatus: 'confirmed' | 'refunded' | 'disputed';
      bookingStatus: 'confirmed' | 'refunded' | 'cancelled';
      slotStatus: 'confirmed' | 'released';
      refundedCents: number;
    }> = [
      {
        suffix: 'late_success_partial',
        paymentStatus: 'partially_refunded',
        requestStatus: 'confirmed',
        bookingStatus: 'confirmed',
        slotStatus: 'confirmed',
        refundedCents: 5000,
      },
      {
        suffix: 'late_success_refunded',
        paymentStatus: 'refunded',
        requestStatus: 'refunded',
        bookingStatus: 'refunded',
        slotStatus: 'released',
        refundedCents: 19900,
      },
      {
        suffix: 'late_success_disputed',
        paymentStatus: 'disputed',
        requestStatus: 'disputed',
        bookingStatus: 'cancelled',
        slotStatus: 'released',
        refundedCents: 0,
      },
    ];

    for (const scenario of cases) {
      const fixture = await seedCheckoutWebhookFixture(scenario.suffix, scenario);
      const response = await sendWebhook({
        id: `evt_${scenario.suffix}`,
        type: 'checkout.session.async_payment_succeeded',
        data: { object: fixture.object('paid') },
      });
      expect(response.status, scenario.paymentStatus).toBe(200);

      const after = await get(`/api/admin/requests/${fixture.requestId}`, admin);
      expect(after.body.request.status, scenario.paymentStatus).toBe(scenario.requestStatus);
      expect(after.body.payments[0].status, scenario.paymentStatus).toBe(scenario.paymentStatus);
      expect(after.body.payments[0].refunded_cents, scenario.paymentStatus).toBe(scenario.refundedCents);
      expect(after.body.slots.find((slot: Json) => slot.id === fixture.slotId).status, scenario.paymentStatus).toBe(scenario.slotStatus);
      expect(after.body.history, scenario.paymentStatus).toHaveLength(0);
      expect(after.body.messages, scenario.paymentStatus).toHaveLength(0);
    }
  });

  it('fails closed before payment mutation when signed Checkout identity fields do not match', async () => {
    const providerSession = await (await fetch(`http://127.0.0.1:8798/test/session/${encodeURIComponent(sessionId)}`)).json() as Json;
    const valid = { ...providerSession, payment_intent: 'pi_guardrail_valid' };
    const cases = [
      { payment_status: 'unpaid' },
      { payment_intent: 'not_a_payment_intent' },
      { amount_total: Number(providerSession.amount_total) + 1 },
      { currency: 'eur' },
      { client_reference_id: 'bkg_wrong_reference' },
      { metadata: { ...providerSession.metadata, request_id: 'req_wrong_metadata' } },
      { metadata: { ...providerSession.metadata, quote_id: 'qot_wrong_metadata' } },
      { metadata: { ...providerSession.metadata, booking_id: 'bkg_wrong_metadata' } },
    ];
    for (const [index, mismatch] of cases.entries()) {
      const response = await sendWebhook({
        id: `evt_int_checkout_identity_mismatch_${index}`,
        type: index === 0 ? 'checkout.session.async_payment_succeeded' : 'checkout.session.completed',
        data: { object: { ...valid, ...mismatch } },
      });
      expect(response.status, JSON.stringify(mismatch)).toBe(500);
      expect(response.body.error.code, JSON.stringify(mismatch)).toBe('processing_failed');
    }

    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    const guardedPayment = detail.body.payments.find((payment: Json) => payment.stripe_session_id === sessionId);
    expect(guardedPayment.status).toBe('created');
    expect(guardedPayment.stripe_payment_intent).toBeNull();
    expect(detail.body.request.status).toBe('awaiting_payment');
    expect(detail.body.slots.find((slot: Json) => slot.id === heldSlotId).status).toBe('held');
  });

  it('records payment without claiming a lapsed slot and queues durable notices', async () => {
    const released = await adminPost(euroId, { action: 'release_slot', slotId: heldSlotId });
    expect(released.status).toBe(200);

    const r = await sendWebhook({
      id: 'evt_int_1',
      // Pinned so the replay assertion below can re-send byte-identical bytes.
      created: EVT_INT_1_CREATED,
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_mock_1' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.received).toBe(true);

    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.request.status).toBe('awaiting_time_selection');
    expect(detail.body.payments[0].status).toBe('succeeded');
    expect(detail.body.slots.find((s: Json) => s.id === heldSlotId).status).toBe('released');
    const customerNotice = detail.body.messages.find((message: Json) => message.dedupe_key === `payment_slot_lapsed:${detail.body.payments[0].id}`);
    const ownerNotice = detail.body.messages.find((message: Json) => message.dedupe_key === `owner_slot_lapsed:${detail.body.payments[0].id}`);
    expect(customerNotice.body_text).toContain('appointment time was not booked');
    expect(customerNotice.body_text).toContain('/ppi/portal/?t=');
    expect(ownerNotice).toBeTruthy();

    const portal = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    expect(portal.body.status).toBe('awaiting_time_selection');
    expect(portal.body.payment.status).toBe('succeeded');
    expect(portal.body.booking.status).not.toBe('confirmed');
    expect(portal.body.booking.startsAt).toBeNull();
    expect(portal.body.slots.some((slot: Json) => slot.status === 'offered')).toBe(true);
  });

  it('blocks re-quoting and every new checkout path after a paid hold lapses', async () => {
    const providerBefore = await getProviderState();
    const requote = await adminPost(euroId, {
      action: 'create_quote',
      tier: 'euro_luxury_performance',
      basePriceCents: 34900,
    });
    expect(requote.status).toBe(409);
    expect(requote.body.error.code).toBe('payment_already_received');

    const checkout = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${euroOldToken}` });
    expect(checkout.status).toBe(409);
    expect(checkout.body.error.code).toBe('payment_already_received');
    const providerAfter = await getProviderState();
    expect(providerAfter.sessionCount).toBe(providerBefore.sessionCount);
  });

  it('confirms a replacement time against the existing payment without another checkout', async () => {
    const before = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    replacementSlotId = before.body.slots.find((slot: Json) => slot.status === 'offered').id;
    const selected = await post(
      '/api/portal/action',
      { action: 'select_slot', slotId: replacementSlotId },
      { authorization: `Bearer ${euroOldToken}` },
    );
    expect(selected.status).toBe(200);
    expect(selected.body.confirmed).toBe(true);
    expect(selected.body.paymentStatus).toBe('succeeded');

    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.request.status).toBe('confirmed');
    expect(detail.body.payments).toHaveLength(2); // one Stripe-verified expired attempt + the succeeded attempt
    expect(detail.body.slots.find((slot: Json) => slot.id === replacementSlotId).status).toBe('confirmed');
    const portal = await get('/api/portal', { authorization: `Bearer ${euroOldToken}` });
    expect(portal.body.booking.status).toBe('confirmed');
    expect(portal.body.booking.startsAt).toBeTruthy();

    const ics = await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(euroOldToken)}`);
    expect(ics.status).toBe(200);
    expect(await ics.text()).toContain('BEGIN:VCALENDAR');
  });

  it('acknowledges but never reprocesses replayed events', async () => {
    const r = await sendWebhook({
      id: 'evt_int_1',
      created: EVT_INT_1_CREATED,
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_mock_1' } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.replay).toBe(true);
    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    expect(detail.body.payments).toHaveLength(2);
    expect(detail.body.history.filter((h: Json) => h.to_status === 'confirmed')).toHaveLength(1);
  });

  it('reconciles a distinct duplicate success event without duplicate notifications', async () => {
    const before = await get(`/api/admin/requests/${euroId}`, admin);
    const beforeKeys = before.body.messages.map((message: Json) => message.dedupe_key).filter(Boolean).sort();
    const r = await sendWebhook({
      id: 'evt_int_same_payment_new_event',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_mock_1' } },
    });
    expect(r.status).toBe(200);
    const after = await get(`/api/admin/requests/${euroId}`, admin);
    expect(after.body.history.filter((h: Json) => h.to_status === 'confirmed')).toHaveLength(1);
    expect(after.body.messages.map((message: Json) => message.dedupe_key).filter(Boolean).sort()).toEqual(beforeKeys);
  });

  it('confirms a normal active hold and emails a tokenized portal URL', async () => {
    const list = await get('/api/admin/requests?include=test', admin);
    const vette = list.body.requests.find((row: Json) => row.ref === 'PPI-FIXTURE-VETTE');
    expect(vette).toBeTruthy();

    const prepared = await adminPost(vette.id, {
      action: 'create_quote',
      tier: 'euro_luxury_performance',
      basePriceCents: 34900,
    });
    expect(prepared.status).toBe(200);
    expect((await adminPost(vette.id, { action: 'send_quote', quoteId: prepared.body.quoteId })).status).toBe(200);
    const startsAt = new Date(Date.now() + 15 * 86_400_000);
    startsAt.setUTCHours(22, 0, 0, 0);
    // This fixture is a dealership: its payment test must use a non-Sunday.
    if (startsAt.getUTCDay() === 0) { startsAt.setUTCDate(startsAt.getUTCDate() + 1); startsAt.setUTCHours(9); }
    expect((await adminPost(vette.id, { action: 'propose_slots', slots: [startsAt.toISOString()] })).body.inserted).toBe(1);
    const link = await adminPost(vette.id, { action: 'reissue_link' });
    const token = new URL(link.body.url).searchParams.get('t')!;
    confirmedVetteId = vette.id;
    confirmedVetteToken = token;

    const offered = await get('/api/portal', { authorization: `Bearer ${token}` });
    const slotId = offered.body.slots.find((slot: Json) => slot.status === 'offered').id;
    expect((await post('/api/portal/action', { action: 'select_slot', slotId }, { authorization: `Bearer ${token}` })).status).toBe(200);
    const agreementView = await get('/api/portal', { authorization: `Bearer ${token}` });
    const versionIds = agreementView.body.agreements.required.map((doc: Json) => doc.id);
    expect((await post('/api/portal/action', {
      action: 'accept_agreements',
      typedName: 'Integration Tester',
      versionIds,
    }, { authorization: `Bearer ${token}` })).status).toBe(200);

    const checkout = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${token}` });
    expect(checkout.status).toBe(200);
    const normalSessionId = new URL(checkout.body.checkoutUrl).pathname.split('/').pop();
    const webhook = await sendWebhook({
      id: 'evt_int_normal_confirmation',
      type: 'checkout.session.completed',
      data: { object: { id: normalSessionId, payment_status: 'paid', payment_intent: 'pi_mock_normal' } },
    });
    expect(webhook.status).toBe(200);

    const detail = await get(`/api/admin/requests/${vette.id}`, admin);
    expect(detail.body.request.status).toBe('confirmed');
    const paymentId = detail.body.payments[0].id;
    confirmedVettePaymentId = paymentId;
    const confirmation = detail.body.messages.find((message: Json) => message.dedupe_key === `appointment_confirmed:${paymentId}`);
    expect(confirmation.body_text).toContain('/ppi/portal/?t=');
    expect(confirmation.body_text).not.toMatch(/\/ppi\/portal\/$/m);
    expect(detail.body.messages.some((message: Json) => message.dedupe_key === `payment_received:${paymentId}`)).toBe(true);
    expect(detail.body.messages.some((message: Json) => message.dedupe_key === `owner_booking_confirmed:${paymentId}`)).toBe(true);

    const overview = await get('/api/admin/overview', admin);
    expect(overview.body.revenue30d.grossCents).toBeGreaterThanOrEqual(detail.body.payments[0].amount_cents);
    expect(overview.body.revenue30d.refundedCents).toBeGreaterThanOrEqual(0);
    expect(overview.body.revenue30d.netCents).toBeGreaterThanOrEqual(0);
    expect(overview.body.authoritativeFunnel30d).toHaveProperty('ready_for_review_requests');
    expect(overview.body.authoritativeFunnel30d).not.toHaveProperty('qualified_requests');
    expect(overview.body.authoritativeFunnel30d.payments_succeeded).toBeGreaterThanOrEqual(1);
    expect(overview.body.authoritativeFunnel30d.bookings_confirmed).toBeGreaterThanOrEqual(1);
    expect(overview.body.funnel30d.find((row: Json) => row.event === 'ppi_payment_confirmed')?.n).toBeGreaterThanOrEqual(1);
    expect(overview.body.funnel30d.find((row: Json) => row.event === 'ppi_booking_confirmed')?.n).toBeGreaterThanOrEqual(1);
  });

  it('orders dispute lifecycle/funds independently without restoring request capacity', async () => {
    const providerCreated = 1_700_000_000;
    const disputeObject = {
      id: 'du_int_confirmed_dispute',
      payment_intent: 'pi_mock_normal',
      charge: 'ch_int_confirmed_dispute',
      amount: 5000,
      currency: 'usd',
      created: providerCreated,
    };
    const opened = await sendWebhook({
      id: 'evt_int_confirmed_dispute_created',
      type: 'charge.dispute.created',
      created: providerCreated + 1,
      data: { object: { ...disputeObject, status: 'needs_response' } },
    });
    expect(opened.status).toBe(200);

    let detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    expect(detail.body.request.status).toBe('disputed');
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('disputed');
    expect(detail.body.slots.every((slot: Json) => slot.status !== 'confirmed' && slot.status !== 'held')).toBe(true);
    expect(detail.body.paymentDisputes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider_dispute_id: disputeObject.id,
        provider_status: 'needs_response',
        funds_state: 'unknown',
      }),
    ]));
    expect(detail.body.messages.some(
      (message: Json) => message.dedupe_key === `owner_dispute:${disputeObject.id}:evt_int_confirmed_dispute_created`,
    )).toBe(true);
    expect((await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(confirmedVetteToken)}`)).status).toBe(404);

    const won = await sendWebhook({
      id: 'evt_int_confirmed_dispute_won',
      type: 'charge.dispute.closed',
      created: providerCreated + 20,
      data: { object: { ...disputeObject, status: 'won' } },
    });
    expect(won.status).toBe(200);
    detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('disputed');

    // The funds event has an older timestamp than the status event but is the
    // first authority on its own axis, so it must still release the payment
    // latch after a favorable close.
    const reinstated = await sendWebhook({
      id: 'evt_int_confirmed_dispute_reinstated',
      type: 'charge.dispute.funds_reinstated',
      created: providerCreated + 10,
      data: { object: { ...disputeObject, status: 'won' } },
    });
    expect(reinstated.status).toBe(200);
    detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    expect(detail.body.request.status).toBe('disputed');
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('succeeded');
    expect(detail.body.slots.every((slot: Json) => slot.status !== 'confirmed' && slot.status !== 'held')).toBe(true);
    expect(detail.body.paymentDisputes.find((dispute: Json) => dispute.provider_dispute_id === disputeObject.id)).toEqual(
      expect.objectContaining({ provider_status: 'won', funds_state: 'reinstated' }),
    );
    const reinstatedMessage = detail.body.messages.find(
      (message: Json) => message.dedupe_key === `owner_dispute:${disputeObject.id}:evt_int_confirmed_dispute_reinstated`,
    );
    expect(reinstatedMessage.template).toBe('owner_dispute_update');
    expect(reinstatedMessage.body_text).toContain('remain closed');

    // A favorable outcome restores only the payment's economic latch. If an
    // older Checkout success snapshot arrives afterward, it must be acknowledged
    // without creating a fresh portal link/message or touching closed capacity.
    const restoredPayment = detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId);
    const messagesBeforeLateSuccess = detail.body.messages.map((message: Json) => message.id).sort();
    const slotsBeforeLateSuccess = detail.body.slots.map((slot: Json) => ({
      id: slot.id,
      status: slot.status,
      hold_expires_at: slot.hold_expires_at,
    }));
    const portalBeforeLateSuccess = await get(`/api/portal/?t=${encodeURIComponent(confirmedVetteToken)}`);
    expect(portalBeforeLateSuccess.status).toBe(200);

    expect((await sendWebhook({
      id: 'evt_int_checkout_success_after_favorable_dispute',
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          id: restoredPayment.stripe_session_id,
          payment_status: 'paid',
          payment_intent: restoredPayment.stripe_payment_intent,
        },
      },
    })).status).toBe(200);
    detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    const portalAfterLateSuccess = await get(`/api/portal/?t=${encodeURIComponent(confirmedVetteToken)}`);
    expect(detail.body.request.status).toBe('disputed');
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('succeeded');
    expect(detail.body.slots.map((slot: Json) => ({
      id: slot.id,
      status: slot.status,
      hold_expires_at: slot.hold_expires_at,
    }))).toEqual(slotsBeforeLateSuccess);
    expect(detail.body.messages.map((message: Json) => message.id).sort()).toEqual(messagesBeforeLateSuccess);
    expect(portalAfterLateSuccess.status).toBe(200);
    expect(portalAfterLateSuccess.body.booking).toEqual(portalBeforeLateSuccess.body.booking);
    expect(portalAfterLateSuccess.body.messages).toEqual(portalBeforeLateSuccess.body.messages);

    // A later-delivered but older status snapshot cannot regress the won state.
    expect((await sendWebhook({
      id: 'evt_int_confirmed_dispute_stale_update',
      type: 'charge.dispute.updated',
      created: providerCreated + 5,
      data: { object: { ...disputeObject, status: 'under_review' } },
    })).status).toBe(200);
    detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    expect(detail.body.paymentDisputes.find((dispute: Json) => dispute.provider_dispute_id === disputeObject.id)).toEqual(
      expect.objectContaining({ provider_status: 'won', funds_state: 'reinstated' }),
    );
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('succeeded');

    // A newer withdrawal closes the payment latch again, without changing the
    // already-terminal request/capacity state.
    expect((await sendWebhook({
      id: 'evt_int_confirmed_dispute_withdrawn',
      type: 'charge.dispute.funds_withdrawn',
      created: providerCreated + 30,
      data: { object: { ...disputeObject, status: 'won' } },
    })).status).toBe(200);
    detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    expect(detail.body.request.status).toBe('disputed');
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('disputed');
    expect(detail.body.paymentDisputes.find((dispute: Json) => dispute.provider_dispute_id === disputeObject.id)).toEqual(
      expect.objectContaining({ provider_status: 'won', funds_state: 'withdrawn' }),
    );

    // A close can be the first delivery observed for another dispute. It must
    // still create a durable terminal row rather than depending on created.
    const lostDispute = {
      ...disputeObject,
      id: 'du_int_first_seen_closed_lost',
      charge: 'ch_int_first_seen_closed_lost',
      amount: 3000,
      created: providerCreated + 40,
      status: 'lost',
    };
    expect((await sendWebhook({
      id: 'evt_int_first_seen_dispute_closed_lost',
      type: 'charge.dispute.closed',
      created: providerCreated + 50,
      data: { object: lostDispute },
    })).status).toBe(200);
    detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    expect(detail.body.paymentDisputes.find((dispute: Json) => dispute.provider_dispute_id === lostDispute.id)).toEqual(
      expect.objectContaining({ provider_status: 'lost', funds_state: 'unknown' }),
    );
    expect(detail.body.request.status).toBe('disputed');
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('disputed');

    const overview = await get('/api/admin/overview', admin);
    expect(overview.body.upcoming.some((booking: Json) => booking.id === confirmedVetteId)).toBe(false);
  });

  it('records pending/failed refund states, webhook updates, and one explicit idempotent retry', async () => {
    const list = await get('/api/admin/requests?include=test', admin);
    const paid = list.body.requests.find((row: Json) => row.ref === 'PPI-FIXTURE-PAIDOK');
    expect(paid).toBeTruthy();
    const before = await get(`/api/admin/requests/${paid.id}`, admin);
    const payment = before.body.payments.find((candidate: Json) => candidate.status === 'succeeded');
    expect(payment).toBeTruthy();

    expect((await fetch('http://127.0.0.1:8798/test/refund-status/pending', { method: 'POST' })).status).toBe(200);
    const providerBefore = await getProviderState();
    const pending = await adminPost(paid.id, { action: 'refund', paymentId: payment.id, amountCents: 5000 });
    expect(pending.status).toBe(202);
    expect(pending.body.operationStatus).toBe('pending');
    const operationId = pending.body.operationId;

    const afterPendingProvider = await getProviderState();
    expect(afterPendingProvider.refundRequests.length - providerBefore.refundRequests.length).toBe(1);
    const firstProviderAttempt = afterPendingProvider.refundRequests.at(-1);
    expect(firstProviderAttempt.responseStatus).toBe('pending');
    const firstParams = new URLSearchParams(firstProviderAttempt.body);
    expect(firstParams.get('metadata[refund_operation_id]')).toBe(operationId);
    expect(firstParams.get('metadata[refund_attempt_no]')).toBe('1');

    const duplicatePending = await adminPost(paid.id, { action: 'refund', paymentId: payment.id, amountCents: 5000 });
    expect(duplicatePending.status).toBe(409);
    expect(duplicatePending.body.error.code).toBe('refund_reconciliation_required');
    expect((await getProviderState()).refundRequests).toHaveLength(afterPendingProvider.refundRequests.length);

    const pendingWebhook = await sendWebhook({
      id: 'evt_int_refund_pending_update',
      type: 'refund.created',
      created: firstProviderAttempt.responseCreated + 1,
      data: {
        object: {
          id: firstProviderAttempt.responseId,
          object: 'refund',
          created: firstProviderAttempt.responseCreated,
          payment_intent: 'pi_test_fixture_PAIDOK',
          amount: 5000,
          currency: 'usd',
          status: 'pending',
          metadata: { refund_operation_id: operationId, refund_attempt_no: '1' },
        },
      },
    });
    expect(pendingWebhook.status).toBe(200);

    const failedWebhook = await sendWebhook({
      id: 'evt_int_refund_failed_update',
      type: 'refund.failed',
      created: firstProviderAttempt.responseCreated + 2,
      data: {
        object: {
          id: firstProviderAttempt.responseId,
          object: 'refund',
          created: firstProviderAttempt.responseCreated,
          payment_intent: 'pi_test_fixture_PAIDOK',
          amount: 5000,
          currency: 'usd',
          status: 'failed',
          failure_reason: 'mock provider failure',
          metadata: { refund_operation_id: operationId, refund_attempt_no: '1' },
        },
      },
    });
    expect(failedWebhook.status).toBe(200);

    const failedDetail = await get(`/api/admin/requests/${paid.id}`, admin);
    expect(failedDetail.body.refundOperations.find((operation: Json) => operation.id === operationId).status).toBe('failed');
    expect(failedDetail.body.refundAttempts.find((attempt: Json) => attempt.operation_id === operationId).outcome_status).toBe('failed');
    expect(failedDetail.body.messages.some(
      (message: Json) => message.dedupe_key === `owner_refund_status:${operationId}:1:failed`,
    )).toBe(true);

    const retryWithoutConfirmation = await adminPost(paid.id, { action: 'refund', paymentId: payment.id, amountCents: 5000 });
    expect(retryWithoutConfirmation.status).toBe(409);
    expect(retryWithoutConfirmation.body.error.code).toBe('refund_retry_available');
    expect((await getProviderState()).refundRequests).toHaveLength(afterPendingProvider.refundRequests.length);

    expect((await fetch('http://127.0.0.1:8798/test/refund-status/succeeded', { method: 'POST' })).status).toBe(200);
    const retried = await adminPost(paid.id, {
      action: 'refund',
      paymentId: payment.id,
      amountCents: 5000,
      refundOperationId: operationId,
    });
    expect(retried.status).toBe(200);
    expect(retried.body.operationStatus).toBe('provider_accepted');

    const afterRetryProvider = await getProviderState();
    expect(afterRetryProvider.refundRequests.length - afterPendingProvider.refundRequests.length).toBe(1);
    const secondProviderAttempt = afterRetryProvider.refundRequests.at(-1);
    expect(secondProviderAttempt.idempotencyKey).not.toBe(firstProviderAttempt.idempotencyKey);
    const secondParams = new URLSearchParams(secondProviderAttempt.body);
    expect(secondParams.get('metadata[refund_operation_id]')).toBe(operationId);
    expect(secondParams.get('metadata[refund_attempt_no]')).toBe('2');

    const staleOldAttempt = await sendWebhook({
      id: 'evt_int_refund_old_attempt_stale',
      type: 'refund.updated',
      created: firstProviderAttempt.responseCreated + 1,
      data: {
        object: {
          id: firstProviderAttempt.responseId,
          object: 'refund',
          created: firstProviderAttempt.responseCreated,
          payment_intent: 'pi_test_fixture_PAIDOK',
          amount: 5000,
          currency: 'usd',
          status: 'pending',
          metadata: { refund_operation_id: operationId, refund_attempt_no: '1' },
        },
      },
    });
    expect(staleOldAttempt.status).toBe(200);
    const finalDetail = await get(`/api/admin/requests/${paid.id}`, admin);
    expect(finalDetail.body.refundOperations.find((operation: Json) => operation.id === operationId).status).toBe('provider_accepted');
    const attempts = finalDetail.body.refundAttempts.filter((attempt: Json) => attempt.operation_id === operationId);
    expect(attempts).toHaveLength(2);
    const firstAttempt = attempts.find((attempt: Json) => attempt.attempt_no === 1);
    expect(firstAttempt.outcome_status).toBe('failed');
    expect(firstAttempt.provider_status).toBe('failed');
    expect(firstAttempt.error).toBe('mock provider failure');
    expect(finalDetail.body.request.status).toBe('confirmed');
    expect(finalDetail.body.payments.find((candidate: Json) => candidate.id === payment.id).status).toBe('succeeded');

    // Confirm operation 1, then prove a later authoritative Refund failure can
    // reduce a cumulative charge balance without delivery order changing the
    // result.
    expect((await sendWebhook({
      id: 'evt_int_refund_first_operation_confirmed',
      type: 'charge.refunded',
      created: 300,
      data: { object: { payment_intent: 'pi_test_fixture_PAIDOK', amount_refunded: 5000, refunded: false } },
    })).status).toBe(200);
    expect((await fetch('http://127.0.0.1:8798/test/refund-status/pending', { method: 'POST' })).status).toBe(200);
    const secondPending = await adminPost(paid.id, { action: 'refund', paymentId: payment.id, amountCents: 4000 });
    expect(secondPending.status).toBe(202);
    const secondOperationId = secondPending.body.operationId;
    const secondOperationProvider = (await getProviderState()).refundRequests.at(-1);

    expect((await sendWebhook({
      id: 'evt_int_refund_second_operation_confirmed',
      type: 'refund.updated',
      created: secondOperationProvider.responseCreated + 1,
      data: {
        object: {
          id: secondOperationProvider.responseId,
          object: 'refund',
          created: secondOperationProvider.responseCreated,
          payment_intent: 'pi_test_fixture_PAIDOK',
          amount: 4000,
          currency: 'usd',
          status: 'succeeded',
          metadata: { refund_operation_id: secondOperationId, refund_attempt_no: '1' },
        },
      },
    })).status).toBe(200);
    const afterSecondSuccess = await get(`/api/admin/requests/${paid.id}`, admin);
    expect(afterSecondSuccess.body.payments.find((candidate: Json) => candidate.id === payment.id).refunded_cents).toBe(9000);

    const laterFailureEvent = {
      id: 'evt_int_refund_second_attempt_failed',
      type: 'refund.failed',
      created: secondOperationProvider.responseCreated + 2,
      data: {
        object: {
          id: secondOperationProvider.responseId,
          object: 'refund',
          created: secondOperationProvider.responseCreated,
          payment_intent: 'pi_test_fixture_PAIDOK',
          amount: 4000,
          currency: 'usd',
          status: 'failed',
          failure_reason: 'late failure after success',
          metadata: { refund_operation_id: secondOperationId, refund_attempt_no: '1' },
        },
      },
    };
    expect((await sendWebhook(laterFailureEvent)).status).toBe(200);
    const afterLaterFailure = await get(`/api/admin/requests/${paid.id}`, admin);
    expect(afterLaterFailure.body.refundOperations.find(
      (operation: Json) => operation.id === secondOperationId,
    ).status).toBe('failed');
    expect(afterLaterFailure.body.refundAttempts.find(
      (attempt: Json) => attempt.operation_id === secondOperationId && attempt.attempt_no === 1,
    ).outcome_status).toBe('failed');
    expect(afterLaterFailure.body.payments.find((candidate: Json) => candidate.id === payment.id).refunded_cents).toBe(5000);

    const duplicateFailure = await sendWebhook(laterFailureEvent);
    expect(duplicateFailure.status).toBe(200);
    expect(duplicateFailure.body.replay).toBe(true);

    // Deliver the older success after the newer failure: it must not restore
    // the amount or operation state.
    expect((await sendWebhook({
      id: 'evt_int_refund_second_operation_stale_success',
      type: 'refund.updated',
      created: secondOperationProvider.responseCreated + 1,
      data: {
        object: {
          id: secondOperationProvider.responseId,
          object: 'refund',
          created: secondOperationProvider.responseCreated,
          payment_intent: 'pi_test_fixture_PAIDOK',
          amount: 4000,
          currency: 'usd',
          status: 'succeeded',
          metadata: { refund_operation_id: secondOperationId, refund_attempt_no: '1' },
        },
      },
    })).status).toBe(200);
    const afterStaleSuccess = await get(`/api/admin/requests/${paid.id}`, admin);
    expect(afterStaleSuccess.body.refundOperations.find(
      (operation: Json) => operation.id === secondOperationId,
    ).status).toBe('failed');
    expect(afterStaleSuccess.body.payments.find((candidate: Json) => candidate.id === payment.id).refunded_cents).toBe(5000);
  });

  it('processes admin refund + charge.refunded webhook', async () => {
    const detail = await get(`/api/admin/requests/${euroId}`, admin);
    const paymentId = detail.body.payments[0].id;
    const providerBefore = await getProviderState();
    const refund = await adminPost(euroId, { action: 'refund', paymentId });
    expect(refund.status).toBe(200);
    expect(refund.body.operationId).toBeTruthy();
    const duplicate = await adminPost(euroId, { action: 'refund', paymentId });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('refund_reconciliation_required');
    const providerAfter = await getProviderState();
    expect(providerAfter.refundRequests.length - providerBefore.refundRequests.length).toBe(1);
    const providerRefund = providerAfter.refundRequests.at(-1);

    const amount = detail.body.payments[0].amount_cents;
    const wh = await sendWebhook({
      id: 'evt_int_refund',
      type: 'charge.refunded',
      created: 1000,
      data: { object: { payment_intent: 'pi_mock_1', amount_refunded: amount, refunded: true } },
    });
    expect(wh.status).toBe(200);

    const after = await get(`/api/admin/requests/${euroId}`, admin);
    expect(after.body.payments[0].status).toBe('refunded');
    expect(after.body.request.status).toBe('refunded');
    expect(after.body.slots.every((slot: Json) => slot.status !== 'confirmed' && slot.status !== 'held')).toBe(true);
    expect(after.body.messages.some((message: Json) => message.dedupe_key === `owner_refund:${paymentId}:${amount}`)).toBe(true);
    expect((await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(euroOldToken)}`)).status).toBe(404);

    const stalePartial = await sendWebhook({
      id: 'evt_int_refund_stale_partial',
      type: 'charge.refunded',
      created: 900,
      data: { object: { payment_intent: 'pi_mock_1', amount_refunded: Math.floor(amount / 2), refunded: false } },
    });
    expect(stalePartial.status).toBe(200);
    const monotonic = await get(`/api/admin/requests/${euroId}`, admin);
    expect(monotonic.body.payments[0].status).toBe('refunded');
    expect(monotonic.body.payments[0].refunded_cents).toBe(amount);
    expect(monotonic.body.request.status).toBe('refunded');

    const lateFailure = {
      id: 'evt_int_refund_late_failure_after_full',
      type: 'refund.failed',
      created: providerRefund.responseCreated + 1,
      data: {
        object: {
          id: providerRefund.responseId,
          object: 'refund',
          created: providerRefund.responseCreated,
          payment_intent: 'pi_mock_1',
          amount,
          currency: 'usd',
          status: 'failed',
          failure_reason: 'provider reversed refund after settlement attempt',
          metadata: { refund_operation_id: refund.body.operationId, refund_attempt_no: '1' },
        },
      },
    };
    await executeLocalD1(`
      CREATE TRIGGER test_refund_reconciliation_request_fault
      BEFORE UPDATE OF status ON ppi_requests
      WHEN OLD.id = ${sqlLiteral(euroId)} AND NEW.status = 'refund_reconciliation_needed'
      BEGIN
        SELECT RAISE(ABORT, 'simulated refund reconciliation request fault');
      END;
    `);
    let interruptedRegression: { status: number; body: Json };
    try {
      interruptedRegression = await sendWebhook(lateFailure);
    } finally {
      await executeLocalD1(`DROP TRIGGER test_refund_reconciliation_request_fault;`);
    }
    expect(interruptedRegression!.status).toBe(500);
    const beforeRepair = await get(`/api/admin/requests/${euroId}`, admin);
    expect(beforeRepair.body.payments[0].status).toBe('succeeded');
    expect(beforeRepair.body.payments[0].refunded_cents).toBe(0);
    expect(beforeRepair.body.request.status).toBe('refunded');

    expect((await sendWebhook(lateFailure)).status).toBe(200);
    const regressed = await get(`/api/admin/requests/${euroId}`, admin);
    expect(regressed.body.payments[0].status).toBe('succeeded');
    expect(regressed.body.payments[0].refunded_cents).toBe(0);
    expect(regressed.body.request.status).toBe('refund_reconciliation_needed');
    expect(regressed.body.slots.every((slot: Json) => !['offered', 'held', 'confirmed'].includes(slot.status))).toBe(true);
    expect(regressed.body.messages.some((message: Json) => message.dedupe_key === `portal_refund_reconcile:${paymentId}:${providerRefund.responseId}`)).toBe(true);
    expect(regressed.body.messages.some((message: Json) => message.dedupe_key === `refund_reconciliation_customer:${paymentId}:${providerRefund.responseId}`)).toBe(true);
    expect(regressed.body.messages.some((message: Json) => message.dedupe_key === `owner_refund_reconciliation:${paymentId}:${providerRefund.responseId}`)).toBe(true);
    expect((await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(euroOldToken)}`)).status).toBe(404);

    const messagesBeforeLateSuccess = regressed.body.messages.map((message: Json) => message.id).sort();
    const slotsBeforeLateSuccess = regressed.body.slots.map((slot: Json) => ({
      id: slot.id,
      status: slot.status,
      hold_expires_at: slot.hold_expires_at,
    }));
    const portalBeforeLateSuccess = await get(`/api/portal/?t=${encodeURIComponent(euroOldToken)}`);
    expect(portalBeforeLateSuccess.status).toBe(200);

    // Make an attempted magic-link insert observable through the existing admin
    // detail response without exposing link rows from a production endpoint.
    await executeLocalD1(`
      CREATE TRIGGER test_refund_reconciliation_late_success_link_probe
      AFTER INSERT ON magic_links
      WHEN NEW.request_id = ${sqlLiteral(euroId)}
      BEGIN
        INSERT INTO messages
          (id, request_id, direction, channel, body_text, status, created_at, dedupe_key)
        VALUES
          ('msg_refund_reconciliation_link_probe', NEW.request_id, 'outbound', 'portal',
           'Unexpected late-success link insertion', 'recorded', NEW.created_at,
           'refund_reconciliation_link_probe');
      END;
    `);
    let lateCheckoutSuccess: { status: number; body: Json };
    try {
      lateCheckoutSuccess = await sendWebhook({
        id: 'evt_int_checkout_success_after_refund_reconciliation',
        type: 'checkout.session.async_payment_succeeded',
        data: {
          object: {
            id: regressed.body.payments[0].stripe_session_id,
            payment_status: 'paid',
            payment_intent: regressed.body.payments[0].stripe_payment_intent,
          },
        },
      });
    } finally {
      await executeLocalD1(`DROP TRIGGER test_refund_reconciliation_late_success_link_probe;`);
    }
    expect(lateCheckoutSuccess!.status).toBe(200);

    const afterLateSuccess = await get(`/api/admin/requests/${euroId}`, admin);
    const portalAfterLateSuccess = await get(`/api/portal/?t=${encodeURIComponent(euroOldToken)}`);
    expect(afterLateSuccess.body.request.status).toBe('refund_reconciliation_needed');
    expect(afterLateSuccess.body.payments[0].status).toBe('succeeded');
    expect(afterLateSuccess.body.slots.map((slot: Json) => ({
      id: slot.id,
      status: slot.status,
      hold_expires_at: slot.hold_expires_at,
    }))).toEqual(slotsBeforeLateSuccess);
    expect(afterLateSuccess.body.messages.map((message: Json) => message.id).sort()).toEqual(messagesBeforeLateSuccess);
    expect(portalAfterLateSuccess.status).toBe(200);
    expect(portalAfterLateSuccess.body.booking).toEqual(portalBeforeLateSuccess.body.booking);
    expect(portalAfterLateSuccess.body.messages).toEqual(portalBeforeLateSuccess.body.messages);

    const replay = await sendWebhook(lateFailure);
    expect(replay.status).toBe(200);
    expect(replay.body.replay).toBe(true);
    expect((await sendWebhook({
      id: 'evt_int_refund_stale_success_after_failure',
      type: 'refund.updated',
      created: providerRefund.responseCreated,
      data: {
        object: {
          id: providerRefund.responseId,
          object: 'refund',
          created: providerRefund.responseCreated,
          payment_intent: 'pi_mock_1',
          amount,
          currency: 'usd',
          status: 'succeeded',
          metadata: { refund_operation_id: refund.body.operationId, refund_attempt_no: '1' },
        },
      },
    })).status).toBe(200);
    const afterOutOfOrderSuccess = await get(`/api/admin/requests/${euroId}`, admin);
    expect(afterOutOfOrderSuccess.body.request.status).toBe('refund_reconciliation_needed');
    expect(afterOutOfOrderSuccess.body.payments[0].refunded_cents).toBe(0);
  });

  it('atomically sums two different succeeded Refund events delivered concurrently', async () => {
    await executeLocalD1(`
      INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
      VALUES ('cus_refund_concurrent', 'Concurrent Refund', 'refund-concurrent@example.com', '702-555-0198', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO vehicles (id, make, model, created_at, updated_at)
      VALUES ('veh_refund_concurrent', 'Test', 'Concurrent', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
      VALUES ('req_refund_concurrent', 'PPI-REFUND-CONCURRENT', 'cus_refund_concurrent', 'veh_refund_concurrent', 'confirmed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO quotes (id, request_id, version, status, tier, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
      VALUES ('quo_refund_concurrent', 'req_refund_concurrent', 1, 'draft', 'standard', 19900, 19900, '2031-01-01T00:00:00.000Z', 'test', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
      VALUES ('qli_refund_concurrent', 'quo_refund_concurrent', 'base', 'Standard Vehicle PPI', 19900, 0);
      UPDATE quotes SET status = 'accepted' WHERE id = 'quo_refund_concurrent';
      INSERT INTO bookings (id, request_id, quote_id, status, confirmed_at, created_at, updated_at)
      VALUES ('bkg_refund_concurrent', 'req_refund_concurrent', 'quo_refund_concurrent', 'confirmed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_payment_intent, amount_cents, status, refunded_cents, created_at, updated_at)
      VALUES ('pay_refund_concurrent', 'req_refund_concurrent', 'quo_refund_concurrent', 'bkg_refund_concurrent', 'pi_refund_concurrent', 19900, 'succeeded', 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    `);
    const refundEvent = (id: string, amount: number) => ({
      id: `evt_${id}`,
      type: 'refund.created',
      created: 2000,
      data: {
        object: {
          id,
          object: 'refund',
          created: 1900,
          payment_intent: 'pi_refund_concurrent',
          amount,
          currency: 'usd',
          status: 'succeeded',
          metadata: {},
        },
      },
    });
    const responses = await Promise.all([
      sendWebhook(refundEvent('re_concurrent_one', 3000)),
      sendWebhook(refundEvent('re_concurrent_two', 4000)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const detail = await get('/api/admin/requests/req_refund_concurrent', admin);
    expect(detail.body.payments[0].status).toBe('partially_refunded');
    expect(detail.body.payments[0].refunded_cents).toBe(7000);
    expect(detail.body.providerRefunds).toHaveLength(2);
    expect(detail.body.providerRefunds.every((refund: Json) => refund.status === 'succeeded')).toBe(true);
  });

  it('repairs downstream lifecycle and outbox work when the same ledger event retries after a fault', async () => {
    await executeLocalD1(`
      INSERT INTO customers (id, full_name, email, phone, created_at, updated_at)
      VALUES ('cus_refund_retry', 'Refund Retry', 'refund-retry@example.com', '702-555-0197', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO vehicles (id, make, model, created_at, updated_at)
      VALUES ('veh_refund_retry', 'Test', 'Retry', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO ppi_requests (id, ref, customer_id, vehicle_id, status, created_at, updated_at)
      VALUES ('req_refund_retry', 'PPI-REFUND-RETRY', 'cus_refund_retry', 'veh_refund_retry', 'confirmed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO quotes (id, request_id, version, status, tier, subtotal_cents, total_cents, expires_at, approved_by, created_at, updated_at)
      VALUES ('quo_refund_retry', 'req_refund_retry', 1, 'draft', 'standard', 10000, 10000, '2031-01-01T00:00:00.000Z', 'test', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO quote_line_items (id, quote_id, kind, label, amount_cents, sort)
      VALUES ('qli_refund_retry', 'quo_refund_retry', 'base', 'Standard Vehicle PPI', 10000, 0);
      UPDATE quotes SET status = 'accepted' WHERE id = 'quo_refund_retry';
      INSERT INTO bookings (id, request_id, quote_id, status, confirmed_at, created_at, updated_at)
      VALUES ('bkg_refund_retry', 'req_refund_retry', 'quo_refund_retry', 'confirmed', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      INSERT INTO payments (id, request_id, quote_id, booking_id, stripe_payment_intent, amount_cents, status, refunded_cents, created_at, updated_at)
      VALUES ('pay_refund_retry', 'req_refund_retry', 'quo_refund_retry', 'bkg_refund_retry', 'pi_refund_retry', 10000, 'succeeded', 0, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
      CREATE TRIGGER test_refund_outbox_fault
      BEFORE INSERT ON messages
      WHEN NEW.request_id = 'req_refund_retry' AND NEW.dedupe_key LIKE 'refund_issued:%'
      BEGIN
        SELECT RAISE(ABORT, 'simulated refund outbox fault');
      END;
    `);
    const event = {
      id: 'evt_refund_retry_after_fault',
      type: 'refund.created',
      created: 2200,
      data: {
        object: {
          id: 're_refund_retry_after_fault',
          object: 'refund',
          created: 2100,
          payment_intent: 'pi_refund_retry',
          amount: 10000,
          currency: 'usd',
          status: 'succeeded',
          metadata: {},
        },
      },
    };
    const failed = await sendWebhook(event);
    expect(failed.status).toBe(500);
    await executeLocalD1(`DROP TRIGGER test_refund_outbox_fault;`);

    const retried = await sendWebhook(event);
    expect(retried.status).toBe(200);
    const detail = await get('/api/admin/requests/req_refund_retry', admin);
    expect(detail.body.request.status).toBe('refunded');
    expect(detail.body.payments[0].status).toBe('refunded');
    expect(detail.body.payments[0].refunded_cents).toBe(10000);
    expect(detail.body.providerRefunds).toHaveLength(1);
    expect(detail.body.messages.some((message: Json) => message.dedupe_key === 'refund_issued:pay_refund_retry:10000')).toBe(true);
  });
});

describe('paid-lapsed terminal reconciliation', () => {
  it('fully refunds an awaiting-time-selection payment and permanently disables scheduling', async () => {
    const intake = await post('/api/ppi/requests', intakePayload({
      submissionKey: 'integration_paid_lapsed_refund_01',
      email: 'paid-lapsed-refund@example.com',
      vin: '1HGCM82633A004352',
      make: 'Honda',
      model: 'Accord',
    }), { 'cf-connecting-ip': '203.0.113.210' });
    expect(intake.status).toBe(200);
    const token = intake.body.portalToken;
    const list = await get('/api/admin/requests?include=test', admin);
    const row = list.body.requests.find((request: Json) => request.ref === intake.body.requestRef);
    expect(row).toBeTruthy();
    expect((await adminPost(row.id, { action: 'set_status', to: 'ready_for_review' })).status).toBe(200);

    const quote = await adminPost(row.id, { action: 'create_quote', tier: 'standard', basePriceCents: 19900 });
    expect(quote.status).toBe(200);
    expect((await adminPost(row.id, { action: 'send_quote', quoteId: quote.body.quoteId })).status).toBe(200);
    const start = new Date(Date.now() + 18 * 86_400_000);
    start.setUTCHours(3, 17, 0, 0);
    expect((await adminPost(row.id, { action: 'propose_slots', slots: [start.toISOString()] })).body.inserted).toBe(1);

    const offered = await get('/api/portal', { authorization: `Bearer ${token}` });
    const slotId = offered.body.slots.find((slot: Json) => slot.status === 'offered').id;
    expect((await post('/api/portal/action', { action: 'select_slot', slotId }, { authorization: `Bearer ${token}` })).status).toBe(200);
    const agreementView = await get('/api/portal', { authorization: `Bearer ${token}` });
    expect((await post('/api/portal/action', {
      action: 'accept_agreements',
      typedName: 'Paid Lapsed Tester',
      versionIds: agreementView.body.agreements.required.map((doc: Json) => doc.id),
    }, { authorization: `Bearer ${token}` })).status).toBe(200);
    const checkout = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${token}` });
    expect(checkout.status).toBe(200);
    const checkoutSession = new URL(checkout.body.checkoutUrl).pathname.split('/').pop();
    expect((await adminPost(row.id, { action: 'release_slot', slotId })).status).toBe(200);
    const providerAfterRelease = await getProviderState();
    expect(providerAfterRelease.expiredSessions).toContain(checkoutSession);
    // Model the narrow provider race where payment completed just before the
    // expiration took effect. The webhook still reconciles it as paid-lapsed;
    // the released URL itself is no longer payable.
    expect((await sendWebhook({
      id: 'evt_int_paid_lapsed_refund_success',
      type: 'checkout.session.completed',
      data: { object: { id: checkoutSession, payment_status: 'paid', payment_intent: 'pi_mock_paid_lapsed_refund' } },
    })).status).toBe(200);

    const lapsed = await get(`/api/admin/requests/${row.id}`, admin);
    expect(lapsed.body.request.status).toBe('awaiting_time_selection');
    const payment = lapsed.body.payments.find((candidate: Json) => candidate.status === 'succeeded');
    expect((await adminPost(row.id, { action: 'refund', paymentId: payment.id })).status).toBe(200);
    expect((await sendWebhook({
      id: 'evt_int_paid_lapsed_full_refund',
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_mock_paid_lapsed_refund', amount_refunded: payment.amount_cents, refunded: true } },
    })).status).toBe(200);

    const reconciled = await get(`/api/admin/requests/${row.id}`, admin);
    expect(reconciled.body.request.status).toBe('refunded');
    expect(reconciled.body.payments.find((candidate: Json) => candidate.id === payment.id).status).toBe('refunded');
    expect(reconciled.body.slots.every((slot: Json) => !['offered', 'held', 'confirmed'].includes(slot.status))).toBe(true);
    expect((await post('/api/portal/action', { action: 'select_slot', slotId }, { authorization: `Bearer ${token}` })).status).toBe(409);
    expect((await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(token)}`)).status).toBe(404);
  });
});

describe('admin expiry lifecycle', () => {
  it('closes the checkout/cancel race, resumes a crash-left claim, then expires all capacity', async () => {
    const list = await get('/api/admin/requests?include=test', admin);
    const request = list.body.requests.find((row: Json) => row.ref === 'PPI-FIXTURE-LAMBO');
    expect(request).toBeTruthy();

    const quote = await adminPost(request.id, {
      action: 'create_quote',
      tier: 'exotic_collector',
      basePriceCents: 39900,
    });
    expect(quote.status).toBe(200);
    expect((await adminPost(request.id, { action: 'send_quote', quoteId: quote.body.quoteId })).status).toBe(200);
    const firstStart = new Date(Date.now() + 19 * 86_400_000);
    firstStart.setUTCHours(8, 3, 0, 0);
    const secondStart = new Date(firstStart.getTime() + 86_400_000);
    const proposed = await adminPost(request.id, {
      action: 'propose_slots',
      slots: [firstStart.toISOString(), secondStart.toISOString()],
    });
    expect(proposed.status).toBe(200);
    expect(proposed.body.inserted).toBe(2);

    const link = await adminPost(request.id, { action: 'reissue_link' });
    const token = new URL(link.body.url).searchParams.get('t')!;
    const portal = await get('/api/portal', { authorization: `Bearer ${token}` });
    const slotId = portal.body.slots.find((slot: Json) => slot.status === 'offered').id;
    expect((await post('/api/portal/action', { action: 'select_slot', slotId }, { authorization: `Bearer ${token}` })).status).toBe(200);
    const agreements = await get('/api/portal', { authorization: `Bearer ${token}` });
    expect((await post('/api/portal/action', {
      action: 'accept_agreements',
      typedName: 'Expiry Lifecycle Tester',
      versionIds: agreements.body.agreements.required.map((doc: Json) => doc.id),
    }, { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await fetch('http://127.0.0.1:8798/test/delay-next-checkout', { method: 'POST' })).status).toBe(200);
    const checkoutPromise = post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${token}` });
    let providerWhileWaiting: Json | null = null;
    for (let i = 0; i < 100; i++) {
      providerWhileWaiting = await getProviderState();
      if (providerWhileWaiting.checkoutWaiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(providerWhileWaiting?.checkoutWaiting).toBe(true);

    const racedCancellation = await post(
      '/api/portal/action',
      { action: 'cancel', reason: 'Concurrent cancellation regression' },
      { authorization: `Bearer ${token}` },
    );
    expect(racedCancellation.status).toBe(409);
    expect(racedCancellation.body.error.code).toBe('reconciliation_required');
    expect((await fetch('http://127.0.0.1:8798/test/release-checkout', { method: 'POST' })).status).toBe(200);

    const checkout = await checkoutPromise;
    expect(checkout.status).toBe(200);
    const sessionId = new URL(checkout.body.checkoutUrl).pathname.split('/').pop()!;
    const providerAfterCheckout = await getProviderState();
    const sessionCount = providerAfterCheckout.sessionCount;
    const persistedDetail = await get(`/api/admin/requests/${request.id}`, admin);
    const persistedPayment = persistedDetail.body.payments.find((payment: Json) => payment.stripe_session_id === sessionId);
    expect(persistedPayment).toBeTruthy();
    expect(persistedPayment.stripe_payment_intent).toBeNull();
    const expectedIdempotencyKey = `checkout/${persistedPayment.booking_id}/${persistedPayment.quote_id}/${persistedPayment.checkout_attempt}`;
    const providerSession = (await (await fetch('http://127.0.0.1:8798/last-session')).json()) as Json;
    expect(providerSession._idempotencyKey).toBe(expectedIdempotencyKey);

    // Recreate the durable row as it existed immediately before the provider
    // Session id was persisted. Updating a recorded provider id back to NULL is
    // intentionally forbidden by the production trigger, so this local-only
    // test deletes and reinserts the same disposable fixture identity at the
    // earlier checkpoint. Provider state retains the already-created Session.
    // A retry must reuse the exact D1 attempt/Stripe idempotency key and recover
    // the same Session already retained by the mock provider.
    await executeLocalD1(
      `DELETE FROM payments WHERE id = ${sqlLiteral(persistedPayment.id)};` +
      `INSERT INTO payments
         (id, request_id, quote_id, booking_id, stripe_session_id, stripe_payment_intent,
          amount_cents, currency, status, refunded_cents, created_at, updated_at, checkout_attempt)
       VALUES (
         ${sqlLiteral(persistedPayment.id)}, ${sqlLiteral(persistedPayment.request_id)},
         ${sqlLiteral(persistedPayment.quote_id)}, ${sqlLiteral(persistedPayment.booking_id)},
         NULL, NULL, ${Number(persistedPayment.amount_cents)}, ${sqlLiteral(persistedPayment.currency)},
         'pending', ${Number(persistedPayment.refunded_cents)}, ${sqlLiteral(persistedPayment.created_at)},
         ${sqlLiteral(persistedPayment.updated_at)}, ${Number(persistedPayment.checkout_attempt)}
       );`,
    );
    const recoveredCheckout = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${token}` });
    expect(recoveredCheckout.status).toBe(200);
    expect(recoveredCheckout.body.checkoutUrl).toBe(checkout.body.checkoutUrl);
    expect((await getProviderState()).sessionCount).toBe(sessionCount);
    const recoveredProviderSession = (await (await fetch('http://127.0.0.1:8798/last-session')).json()) as Json;
    expect(recoveredProviderSession._idempotencyKey).toBe(expectedIdempotencyKey);

    const unsafeBackward = await adminPost(request.id, {
      action: 'set_status',
      to: 'awaiting_time_selection',
      reason: 'Unsafe manual rollback regression',
    });
    expect(unsafeBackward.status).toBe(409);
    expect(unsafeBackward.body.error.code).toBe('dedicated_action_required');

    // Inverse ordering: terminal expiry snapshots attempt 1 first and then
    // waits on Stripe. A provider expiry webhook closes attempt 1, allowing a
    // concurrent checkout to claim attempt 2 before the terminal D1 batch.
    // The actual terminal CAS must lose and leave the request/slot active.
    expect((await fetch('http://127.0.0.1:8798/test/delay-next-expire', { method: 'POST' })).status).toBe(200);
    const inverseExpiryPromise = adminPost(request.id, {
      action: 'set_status',
      to: 'expired',
      reason: 'Inverse-order terminal race regression',
    });
    let expireWaiting = false;
    for (let i = 0; i < 100; i++) {
      expireWaiting = Boolean((await getProviderState()).expireWaiting);
      if (expireWaiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(expireWaiting).toBe(true);
    expect((await sendWebhook({
      id: 'evt_int_inverse_old_checkout_expired',
      type: 'checkout.session.expired',
      data: { object: { id: sessionId } },
    })).status).toBe(200);

    const inverseCheckout = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${token}` });
    expect(inverseCheckout.status).toBe(200);
    const inverseSessionId = new URL(inverseCheckout.body.checkoutUrl).pathname.split('/').pop()!;
    expect(inverseSessionId).not.toBe(sessionId);
    expect((await fetch('http://127.0.0.1:8798/test/release-expire', { method: 'POST' })).status).toBe(200);
    const inverseExpiry = await inverseExpiryPromise;
    expect(inverseExpiry.status).toBe(409);
    expect(inverseExpiry.body.error.code).toBe('reconciliation_required');
    const afterLostTerminalCas = await get(`/api/admin/requests/${request.id}`, admin);
    expect(afterLostTerminalCas.body.request.status).toBe('awaiting_payment');
    expect(afterLostTerminalCas.body.slots.some((slot: Json) => slot.id === slotId && slot.status === 'held')).toBe(true);

    const expired = await adminPost(request.id, {
      action: 'set_status',
      to: 'expired',
      reason: 'Customer did not complete scheduling',
    });
    expect(expired.status).toBe(200);
    const detail = await get(`/api/admin/requests/${request.id}`, admin);
    expect(detail.body.request.status).toBe('expired');
    expect(detail.body.payments[0].status).toBe('expired');
    expect(detail.body.slots.every((slot: Json) => !['offered', 'held', 'confirmed'].includes(slot.status))).toBe(true);
    const expiredPortal = await get('/api/portal', { authorization: `Bearer ${token}` });
    expect(expiredPortal.body.booking.status).toBe('cancelled');
    expect(expiredPortal.body.slots).toHaveLength(0);
    expect((await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(token)}`)).status).toBe(404);
    const provider = await getProviderState();
    expect(provider.expiredSessions).toContain(sessionId);
    expect(provider.expiredSessions).toContain(inverseSessionId);
    const overview = await get('/api/admin/overview', admin);
    expect(overview.body.upcoming.some((booking: Json) => booking.id === request.id)).toBe(false);
  });
});

describe('refreshed quote Checkout', () => {
  it.each(['expired', 'failed'] as const)(
    'preserves a provider-verified %s attempt while reusing the booking for a refreshed quote',
    async (terminalStatus) => {
      const fixture = await seedCheckoutWebhookFixture(`requote_${terminalStatus}`);
      const terminalEvent = terminalStatus === 'expired'
        ? {
            id: `evt_requote_${terminalStatus}`,
            type: 'checkout.session.expired',
            data: { object: { id: fixture.sessionId } },
          }
        : {
            id: `evt_requote_${terminalStatus}`,
            type: 'checkout.session.async_payment_failed',
            data: { object: fixture.object('unpaid') },
          };
      expect((await sendWebhook(terminalEvent)).status).toBe(200);

      const closed = await adminPost(fixture.requestId, {
        action: 'set_status',
        to: 'expired',
        reason: `Close provider-verified ${terminalStatus} Checkout`,
      });
      expect(closed.status).toBe(200);
      expect((await adminPost(fixture.requestId, {
        action: 'set_status',
        to: 'ready_for_review',
        reason: 'Customer requested a refreshed quote',
      })).status).toBe(200);

      const refreshedAmount = terminalStatus === 'expired' ? 22900 : 23900;
      const refreshed = await adminPost(fixture.requestId, {
        action: 'create_quote',
        tier: 'standard',
        basePriceCents: refreshedAmount,
        travelCents: 0,
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.quoteId).not.toBe(fixture.quoteId);
      expect(refreshed.body.totalCents).toBe(refreshedAmount);
      expect((await adminPost(fixture.requestId, {
        action: 'send_quote',
        quoteId: refreshed.body.quoteId,
      })).status).toBe(200);

      // Stay comfortably inside the 21-day ceiling. Snapping an exact +21-day
      // value to a later UTC hour can move it just beyond the rolling window.
      const startsAt = new Date(Date.now() + 17 * 86_400_000);
      startsAt.setUTCHours(terminalStatus === 'expired' ? 5 : 11, 37, 0, 0);
      const proposed = await adminPost(fixture.requestId, {
        action: 'propose_slots',
        slots: [startsAt.toISOString()],
      });
      expect(proposed.status).toBe(200);
      expect(proposed.body.inserted, String(proposed.body.skipped ?? '')).toBe(1);

      const link = await adminPost(fixture.requestId, { action: 'reissue_link' });
      expect(link.status).toBe(200);
      const token = new URL(link.body.url).searchParams.get('t')!;
      const headers = { authorization: `Bearer ${token}` };
      const quoteView = await get('/api/portal', headers);
      expect(quoteView.body.quote.id).toBe(refreshed.body.quoteId);
      const slotId = quoteView.body.slots.find((slot: Json) => slot.status === 'offered').id;
      expect((await post('/api/portal/action', { action: 'select_slot', slotId }, headers)).status).toBe(200);

      const agreementView = await get('/api/portal', headers);
      expect((await post('/api/portal/action', {
        action: 'accept_agreements',
        typedName: 'Refreshed Quote Tester',
        versionIds: agreementView.body.agreements.required.map((doc: Json) => doc.id),
      }, headers)).status).toBe(200);

      const checkout = await post('/api/portal/action', { action: 'checkout' }, headers);
      expect(checkout.status).toBe(200);

      const lastSession = (await (await fetch('http://127.0.0.1:8798/last-session')).json()) as Json;
      expect(lastSession['metadata[request_id]']).toBe(fixture.requestId);
      expect(lastSession['metadata[quote_id]']).toBe(refreshed.body.quoteId);
      expect(lastSession['metadata[booking_id]']).toBe(fixture.bookingId);
      expect(Number(lastSession['line_items[0][price_data][unit_amount]'])).toBe(refreshedAmount);

      // A delayed unpaid snapshot for the provider-terminal old Session is
      // harmless after the booking is deliberately rebound. A paid snapshot
      // for that superseded quote is not harmless and must remain retryable for
      // manual reconciliation rather than fulfilling the refreshed booking.
      expect((await sendWebhook({
        id: `evt_requote_${terminalStatus}_late_unpaid`,
        type: 'checkout.session.async_payment_failed',
        data: { object: fixture.object('unpaid') },
      })).status).toBe(200);
      expect((await sendWebhook({
        id: `evt_requote_${terminalStatus}_late_paid`,
        type: 'checkout.session.async_payment_succeeded',
        data: { object: fixture.object('paid') },
      })).status).toBe(500);

      const detail = await get(`/api/admin/requests/${fixture.requestId}`, admin);
      expect(detail.body.payments).toHaveLength(2);
      expect(detail.body.payments.find((payment: Json) => payment.id === fixture.paymentId)).toMatchObject({
        request_id: fixture.requestId,
        quote_id: fixture.quoteId,
        booking_id: fixture.bookingId,
        stripe_session_id: fixture.sessionId,
        amount_cents: 19900,
        currency: 'usd',
        status: terminalStatus,
      });
      expect(detail.body.payments.find((payment: Json) => payment.id !== fixture.paymentId)).toMatchObject({
        request_id: fixture.requestId,
        quote_id: refreshed.body.quoteId,
        booking_id: fixture.bookingId,
        amount_cents: refreshedAmount,
        currency: 'usd',
        status: 'created',
      });
    },
  );
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

    const list = await get('/api/admin/requests?include=test', admin);
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
    const portalHeaders = { 'cf-connecting-ip': '198.51.100.201' };
    expect((await get('/api/portal', { ...portalHeaders, authorization: `Bearer ${euroToken}` })).status).toBe(200);
    const old = await get('/api/portal', { ...portalHeaders, authorization: `Bearer ${euroOldToken}` });
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('link_revoked');
  });

  it('refreshes a revoked email link on retry without revoking another working link', async () => {
    const list = await get('/api/admin/requests?include=test', admin);
    const request = list.body.requests.find((row: Json) => row.ref === camryRef);
    const before = await get(`/api/admin/requests/${request.id}`, admin);
    const original = before.body.messages.find((message: Json) => message.template === 'request_received');
    const originalUrl = original.body_text.match(/https?:\/\/[^\s]+\/ppi\/portal\/\?t=[^\s]+/)?.[0];
    expect(originalUrl).toBeTruthy();

    const manuallyReissued = await adminPost(request.id, { action: 'reissue_link' });
    const workingToken = new URL(manuallyReissued.body.url).searchParams.get('t')!;
    const portalHeaders = { 'cf-connecting-ip': '198.51.100.202' };
    expect((await get('/api/portal', { ...portalHeaders, authorization: `Bearer ${workingToken}` })).status).toBe(200);
    expect((await get('/api/portal', { ...portalHeaders, authorization: `Bearer ${new URL(originalUrl).searchParams.get('t')}` })).status).toBe(401);

    const retry = await adminPost(request.id, { action: 'retry_email', messageId: original.id });
    expect(retry.status).toBe(503);
    expect(retry.body.error.code).toBe('email_provider_unavailable');
    expect(retry.body.error.messageId).not.toBe(original.id);

    const after = await get(`/api/admin/requests/${request.id}`, admin);
    const successor = after.body.messages.find((message: Json) => message.id === retry.body.error.messageId);
    expect(successor.dedupe_key).toBe(`email_link_refresh:${original.id}`);
    expect(successor.body_text).not.toContain(originalUrl);
    const successorUrl = successor.body_text.match(/https?:\/\/[^\s]+\/ppi\/portal\/\?t=[^\s]+/)?.[0];
    const successorToken = new URL(successorUrl).searchParams.get('t')!;
    expect((await get('/api/portal', { ...portalHeaders, authorization: `Bearer ${successorToken}` })).status).toBe(200);
    expect((await get('/api/portal', { ...portalHeaders, authorization: `Bearer ${workingToken}` })).status).toBe(200);
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
      headers: { ...admin, origin: BASE, 'content-type': 'application/json' },
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
      headers: { ...admin, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ pricing: { launch: { enabled: false } } }),
    });
    const off = await get('/api/ppi/runtime-config');
    expect(off.body.launchActive).toBe(false);
  });

  it('config: admin cannot enable diagnostic scan before the reviewed capability release', async () => {
    const rejected = await fetch(BASE + '/api/admin/config', {
      method: 'PUT',
      headers: { ...admin, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ scan: { included: true } }),
    });
    expect(rejected.status).toBe(422);
    expect(((await rejected.json()) as Json).error.code).toBe('configuration_not_released');
    const pub = await get('/api/ppi/runtime-config');
    expect(pub.body.scanIncluded).toBe(false);
  });

  it('config: admin cannot publish unattributed customer reviews', async () => {
    const rejected = await fetch(`${BASE}/api/admin/config`, {
      method: 'PUT',
      headers: { ...admin, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({
        reviews: {
          enabled: true,
          items: [{ name: 'Anonymous', text: 'Great inspection.' }],
        },
      }),
    });
    expect(rejected.status).toBe(422);
    expect(((await rejected.json()) as Json).error.code).toBe('configuration_not_released');
    const pub = await get('/api/ppi/runtime-config');
    expect(pub.body.reviews).toEqual([]);
  });

  it('config: malformed, unsafe, and unknown values fail before persistence', async () => {
    for (const patch of [
      { contact: null },
      { scheduling: { slotTemplates: ['25:90'] } },
      { uploads: { allowedTypes: ['text/html'] } },
      { unknownControl: true },
    ]) {
      const rejected = await fetch(`${BASE}/api/admin/config`, {
        method: 'PUT',
        headers: { ...admin, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      expect(rejected.status).toBe(422);
      expect(((await rejected.json()) as Json).error.code).toBe('invalid_configuration');
    }
    const pub = await get('/api/ppi/runtime-config');
    expect(pub.status).toBe(200);
    expect(pub.body.contact.configured).toBe(false);
  });

  it('analytics endpoint accepts allowlisted events only (and never PII fields)', async () => {
    expect((await post('/api/ppi/events', { event: 'ppi_page_view', step: '', source: 'web' })).status).toBe(200);
    expect((await post('/api/ppi/events', { event: 'ppi_form_completed', step: 'review', source: 'web' })).status).toBe(200);
    expect((await post('/api/ppi/events', { event: 'request_confirmation_viewed', step: '', source: 'web' })).status).toBe(200);
    expect((await post('/api/ppi/events', { event: 'made_up_event' })).status).toBe(200); // silently dropped
    const overview = await get('/api/admin/overview', admin);
    expect(overview.body.funnel30d.find((row: Json) => row.event === 'ppi_form_completed')?.n).toBe(1);
    expect(overview.body.funnel30d.find((row: Json) => row.event === 'request_confirmation_viewed')?.n).toBe(1);
    expect(overview.body.funnel30d.find((row: Json) => row.event === 'made_up_event')).toBeUndefined();
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
