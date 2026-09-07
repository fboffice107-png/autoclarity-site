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

async function getProviderState(): Promise<Json> {
  return (await (await fetch('http://127.0.0.1:8798/test-state')).json()) as Json;
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
    const r = await post('/api/ppi/requests', intakePayload({ submissionKey: camrySubmissionKey }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.ref).toMatch(/^PPI-/);
    expect(r.body.requestRef).toBe(r.body.ref);
    expect(r.body.portalToken.length).toBeGreaterThan(30);
    expect(r.body.emailStatus).toBe('recorded');
    camryToken = r.body.portalToken;
    camryRef = r.body.ref;
    const list = await get('/api/admin/requests', admin);
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
    const list = await get('/api/admin/requests', admin);
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

    const list = await get('/api/admin/requests', admin);
    expect(list.body.requests.filter((row: Json) => row.email === base.email)).toHaveLength(1);
  });

  it('records rich deduplicated receipts, a direct owner link, and a safe retry state', async () => {
    const list = await get('/api/admin/requests', admin);
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
    const list = await get('/api/admin/requests', admin);
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

  it('records payment without claiming a lapsed slot and queues durable notices', async () => {
    const released = await adminPost(euroId, { action: 'release_slot', slotId: heldSlotId });
    expect(released.status).toBe(200);

    const r = await sendWebhook({
      id: 'evt_int_1',
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
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_mock_1' } },
    });
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
    const list = await get('/api/admin/requests', admin);
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
    expect(overview.body.authoritativeFunnel30d.payments_succeeded).toBeGreaterThanOrEqual(1);
    expect(overview.body.authoritativeFunnel30d.bookings_confirmed).toBeGreaterThanOrEqual(1);
    expect(overview.body.funnel30d.find((row: Json) => row.event === 'ppi_payment_confirmed')?.n).toBeGreaterThanOrEqual(1);
    expect(overview.body.funnel30d.find((row: Json) => row.event === 'ppi_booking_confirmed')?.n).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a dispute from a confirmed booking and disables calendar access', async () => {
    const webhook = await sendWebhook({
      id: 'evt_int_confirmed_dispute',
      type: 'charge.dispute.created',
      data: { object: { payment_intent: 'pi_mock_normal' } },
    });
    expect(webhook.status).toBe(200);

    const detail = await get(`/api/admin/requests/${confirmedVetteId}`, admin);
    expect(detail.body.request.status).toBe('disputed');
    expect(detail.body.payments.find((payment: Json) => payment.id === confirmedVettePaymentId).status).toBe('disputed');
    expect(detail.body.slots.every((slot: Json) => slot.status !== 'confirmed' && slot.status !== 'held')).toBe(true);
    expect(detail.body.messages.some((message: Json) => message.dedupe_key === `owner_dispute:${confirmedVettePaymentId}`)).toBe(true);
    expect((await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(confirmedVetteToken)}`)).status).toBe(404);

    const overview = await get('/api/admin/overview', admin);
    expect(overview.body.upcoming.some((booking: Json) => booking.id === confirmedVetteId)).toBe(false);
  });

  it('records pending/failed refund states, webhook updates, and one explicit idempotent retry', async () => {
    const list = await get('/api/admin/requests', admin);
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
      type: 'refund.updated',
      data: {
        object: {
          id: firstProviderAttempt.responseId,
          object: 'refund',
          payment_intent: 'pi_test_fixture_PAIDOK',
          status: 'pending',
          metadata: { refund_operation_id: operationId, refund_attempt_no: '1' },
        },
      },
    });
    expect(pendingWebhook.status).toBe(200);

    const failedWebhook = await sendWebhook({
      id: 'evt_int_refund_failed_update',
      type: 'refund.failed',
      data: {
        object: {
          id: firstProviderAttempt.responseId,
          object: 'refund',
          payment_intent: 'pi_test_fixture_PAIDOK',
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
      data: {
        object: {
          id: firstProviderAttempt.responseId,
          object: 'refund',
          payment_intent: 'pi_test_fixture_PAIDOK',
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

    // Confirm operation 1, then race a definitive failure for operation 2
    // against the cumulative charge.refunded authority. Whichever webhook wins
    // first, the confirmed operation/attempt must be monotonic.
    expect((await sendWebhook({
      id: 'evt_int_refund_first_operation_confirmed',
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_test_fixture_PAIDOK', amount_refunded: 5000, refunded: false } },
    })).status).toBe(200);
    expect((await fetch('http://127.0.0.1:8798/test/refund-status/pending', { method: 'POST' })).status).toBe(200);
    const secondPending = await adminPost(paid.id, { action: 'refund', paymentId: payment.id, amountCents: 4000 });
    expect(secondPending.status).toBe(202);
    const secondOperationId = secondPending.body.operationId;
    const secondOperationProvider = (await getProviderState()).refundRequests.at(-1);

    const concurrentRefundEvents = await Promise.all([
      sendWebhook({
        id: 'evt_int_refund_second_attempt_failed_race',
        type: 'refund.failed',
        data: {
          object: {
            id: secondOperationProvider.responseId,
            object: 'refund',
            payment_intent: 'pi_test_fixture_PAIDOK',
            status: 'failed',
            failure_reason: 'late failure racing confirmation',
            metadata: { refund_operation_id: secondOperationId, refund_attempt_no: '1' },
          },
        },
      }),
      sendWebhook({
        id: 'evt_int_refund_second_operation_confirmed_race',
        type: 'charge.refunded',
        data: { object: { payment_intent: 'pi_test_fixture_PAIDOK', amount_refunded: 9000, refunded: false } },
      }),
    ]);
    expect(concurrentRefundEvents.map((response) => response.status)).toEqual([200, 200]);

    const afterConcurrentRefunds = await get(`/api/admin/requests/${paid.id}`, admin);
    expect(afterConcurrentRefunds.body.refundOperations.find(
      (operation: Json) => operation.id === secondOperationId,
    ).status).toBe('confirmed');
    expect(afterConcurrentRefunds.body.refundAttempts.find(
      (attempt: Json) => attempt.operation_id === secondOperationId && attempt.attempt_no === 1,
    ).outcome_status).toBe('confirmed');

    expect((await sendWebhook({
      id: 'evt_int_refund_second_attempt_stale_failed',
      type: 'refund.failed',
      data: {
        object: {
          id: secondOperationProvider.responseId,
          object: 'refund',
          payment_intent: 'pi_test_fixture_PAIDOK',
          status: 'failed',
          failure_reason: 'stale failure after confirmation',
          metadata: { refund_operation_id: secondOperationId, refund_attempt_no: '1' },
        },
      },
    })).status).toBe(200);
    const afterStaleFailure = await get(`/api/admin/requests/${paid.id}`, admin);
    expect(afterStaleFailure.body.refundOperations.find(
      (operation: Json) => operation.id === secondOperationId,
    ).status).toBe('confirmed');
    expect(afterStaleFailure.body.refundAttempts.find(
      (attempt: Json) => attempt.operation_id === secondOperationId && attempt.attempt_no === 1,
    ).outcome_status).toBe('confirmed');
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
    expect(after.body.slots.every((slot: Json) => slot.status !== 'confirmed' && slot.status !== 'held')).toBe(true);
    expect(after.body.messages.some((message: Json) => message.dedupe_key === `owner_refund:${paymentId}:${amount}`)).toBe(true);
    expect((await fetch(`${BASE}/api/portal/calendar?t=${encodeURIComponent(euroOldToken)}`)).status).toBe(404);

    const stalePartial = await sendWebhook({
      id: 'evt_int_refund_stale_partial',
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_mock_1', amount_refunded: Math.floor(amount / 2), refunded: false } },
    });
    expect(stalePartial.status).toBe(200);
    const monotonic = await get(`/api/admin/requests/${euroId}`, admin);
    expect(monotonic.body.payments[0].status).toBe('refunded');
    expect(monotonic.body.payments[0].refunded_cents).toBe(amount);
    expect(monotonic.body.request.status).toBe('refunded');
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
    const list = await get('/api/admin/requests', admin);
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
    const list = await get('/api/admin/requests', admin);
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

    // Simulate a Worker termination after the durable claim and provider call,
    // but before the provider Session id was persisted. A retry must reuse the
    // exact D1 attempt/Stripe idempotency key and recover the same Session.
    await executeLocalD1(
      `UPDATE payments SET status = 'pending', stripe_session_id = NULL
       WHERE request_id = ${sqlLiteral(request.id)} AND stripe_session_id = ${sqlLiteral(sessionId)}`,
    );
    const recoveredCheckout = await post('/api/portal/action', { action: 'checkout' }, { authorization: `Bearer ${token}` });
    expect(recoveredCheckout.status).toBe(200);
    expect(recoveredCheckout.body.checkoutUrl).toBe(checkout.body.checkoutUrl);
    expect((await getProviderState()).sessionCount).toBe(sessionCount);

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

  it('refreshes a revoked email link on retry without revoking another working link', async () => {
    const list = await get('/api/admin/requests', admin);
    const request = list.body.requests.find((row: Json) => row.ref === camryRef);
    const before = await get(`/api/admin/requests/${request.id}`, admin);
    const original = before.body.messages.find((message: Json) => message.template === 'request_received');
    const originalUrl = original.body_text.match(/https?:\/\/[^\s]+\/ppi\/portal\/\?t=[^\s]+/)?.[0];
    expect(originalUrl).toBeTruthy();

    const manuallyReissued = await adminPost(request.id, { action: 'reissue_link' });
    const workingToken = new URL(manuallyReissued.body.url).searchParams.get('t')!;
    expect((await get('/api/portal', { authorization: `Bearer ${workingToken}` })).status).toBe(200);
    expect((await get('/api/portal', { authorization: `Bearer ${new URL(originalUrl).searchParams.get('t')}` })).status).toBe(401);

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
    expect((await get('/api/portal', { authorization: `Bearer ${successorToken}` })).status).toBe(200);
    expect((await get('/api/portal', { authorization: `Bearer ${workingToken}` })).status).toBe(200);
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
