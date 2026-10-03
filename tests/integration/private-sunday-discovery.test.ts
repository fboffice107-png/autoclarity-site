// Real local HTTP and D1, with simulated Stripe and recorded-only emails.
// Covers explicit Sunday eligibility, legacy request confirmation, optional
// discovery, and a Sunday appointment through a signed webhook replay.

import { describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const WEBHOOK_SECRET = 'whsec_integration_test_secret';

type Json = Record<string, any>;

// This suite's own client address. Rate limits are per-IP by design, so a
// dedicated address keeps this file from spending another file's budget.
const CLIENT_IP = '192.0.2.41';

async function post(path: string, body: Json, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': CLIENT_IP, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(BASE + path, { headers: { 'cf-connecting-ip': CLIENT_IP, ...headers } });
  return { status: res.status, body: (await res.json()) as Json };
}

const admin = { authorization: `Bearer ${ADMIN_KEY}` };
const adminPost = (id: string, body: Json) => post(`/api/admin/requests/${id}`, body, admin);

async function signWebhook(payload: string, timestampSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestampSec}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestampSec},v1=${hex}`;
}

async function sendWebhook(event: Json): Promise<{ status: number; body: Json }> {
  let enriched = event;
  if (event.type === 'checkout.session.completed' && typeof event.data?.object?.id === 'string') {
    const mockSession = await fetch(`http://127.0.0.1:8798/test/session/${encodeURIComponent(event.data.object.id)}`);
    if (mockSession.ok) {
      enriched = { ...event, data: { object: { ...(await mockSession.json() as Json), ...event.data.object } } };
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

let seq = 0;
function corollaIntake(overrides: Json = {}): Json {
  seq += 1;
  return {
    turnstileToken: 'XXXX.DUMMY.TOKEN',
    submissionKey: `private_sunday_${String(seq).padStart(8, '0')}`,
    attributionSource: 'ppi_direct',
    fullName: 'Dang Proposal',
    email: `sunday-${seq}@example.com`,
    phone: '702-555-0142',
    preferredContact: 'email',
    transactionalConsent: true,
    marketingConsent: false,
    year: '2019',
    make: 'Toyota',
    model: 'Corolla',
    trim: 'LE',
    mileage: '52000',
    modStatus: 'stock',
    titleStatus: 'clean',
    startsDrives: 'yes',
    locStreet: '4000 Example Ave',
    locCity: 'Las Vegas',
    locState: 'NV',
    locZip: '89147', // the service-base ZIP: travel is genuinely included
    sellerType: 'private',
    inspectionLocationType: 'private_residence',
    permInspection: true,
    permRoadTest: 'yes',
    permPhotos: 'yes',
    permUnderbody: 'unknown',
    ackAccessDependent: true,
    decisionTimeline: 'few_days',
    timeWindow: 'afternoon',
    sameDayPriority: false,
    ...overrides,
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function executeLocalD1(sql: string): Promise<void> {
  const response = await fetch('http://127.0.0.1:8798/test/d1', { method: 'POST', body: sql });
  if (!response.ok) throw new Error(`Local D1 test injection failed: ${await response.text()}`);
}

async function submitAndFind(payload: Json): Promise<string> {
  // Intake is rate limited per IP by design; give each fixture its own client
  // address so the limiter measures what it is meant to measure.
  const submitted = await post('/api/ppi/requests', payload, { 'cf-connecting-ip': `192.0.2.${(seq % 150) + 50}` });
  expect(submitted.status).toBe(200);
  expect(submitted.body.ok).toBe(true);
  const list = await get('/api/admin/requests?include=test', admin);
  const row = list.body.requests.find((r: Json) => r.id === submitted.body.requestId)
    ?? list.body.requests.find((r: Json) => r.ref === submitted.body.ref);
  expect(row, 'submitted request should appear in the admin list').toBeTruthy();
  return row.id;
}

// Find upcoming Sundays dynamically; no production date is hardcoded.
function nextSunday(weeks = 0): string {
  const day = new Date(Date.now() + 86_400_000);
  day.setUTCHours(20, 7, 0, 0); // afternoon in LA, in either DST offset
  while (day.getUTCDay() !== 0) day.setUTCDate(day.getUTCDate() + 1);
  day.setUTCDate(day.getUTCDate() + weeks * 7);
  return day.toISOString();
}
async function detail(id: string): Promise<Json> { return (await get(`/api/admin/requests/${id}`, admin)).body; }
async function portalHeaders(id: string): Promise<Record<string, string>> {
  const link = await adminPost(id, { action: 'reissue_link' });
  return { authorization: `Bearer ${new URL(link.body.url).searchParams.get('t')}`, 'cf-connecting-ip': '192.0.2.42' };
}
function offer(id: string, slots: string[]) {
  return adminPost(id, { action: 'send_booking_proposal', tier: 'standard', slots, proposalKey: `sunday_offer_${id}_${slots.join('').replace(/\W/g, '')}` });
}
async function configure(scheduling: Json): Promise<void> {
  const res = await fetch(BASE + '/api/admin/config', { method: 'PUT', headers: { ...admin, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ scheduling }) });
  expect(res.status, await res.text()).toBe(200);
}

describe('private Sundays and optional discovery, real local HTTP', () => {
  it('requires an explicit seller, and saves optional dealer/discovery answers only with the new request', async () => {
    const absent = corollaIntake({ sellerType: undefined });
    const rejected = await post('/api/ppi/requests', absent, { 'cf-connecting-ip': '192.0.2.201' });
    expect(rejected.status).toBe(422);
    const id = await submitAndFind(corollaIntake({ sellerType: 'dealership', dealershipName: 'Example <Motors>', discoverySource: 'instagram', discoveryDetail: '@account <img onerror="bad">' }));
    const saved = await detail(id);
    expect(saved.request.seller_type).toBe('dealership');
    expect(saved.request.dealership_name).toBe('Example <Motors>');
    expect(saved.request.discovery_source).toBe('instagram');
    expect(saved.discoveryLabel).toBe('Instagram video or post');
    expect(saved.messages.find((m: Json) => m.template === 'owner_new_request').body_text).toContain('Discovery (customer-reported): Instagram video or post');
    expect(saved.messages.find((m: Json) => m.template === 'owner_new_request').body_text).toContain('Dealership name: Example <Motors>');
    const view = (await get('/api/portal', await portalHeaders(id))).body;
    expect(view.discovery.source).toBe('instagram');
    const omitted = await submitAndFind(corollaIntake({ dealershipName: 'hidden dealer' }));
    const noAnswer = await detail(omitted);
    expect(noAnswer.request.discovery_source).toBeNull();
    expect(noAnswer.request.dealership_name).toBeNull();
  });

  it('rejects Sunday offers for dealership, unknown, and unconfirmed residence requests through both owner endpoints', async () => {
    for (const fields of [{ sellerType: 'dealership', dealershipName: '' }, { sellerType: 'unknown' }, { inspectionLocationType: undefined }, { inspectionLocationType: 'other' }, { permInspection: false }]) {
      const id = await submitAndFind(corollaIntake(fields));
      expect((await detail(id)).proposalDraft.daysOfOperation).not.toContain(0);
      const rejected = await offer(id, [nextSunday()]);
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
      expect(rejected.body.error.skipped.join(' ')).toContain('Sunday');
      const manual = await adminPost(id, { action: 'propose_slots', slots: [nextSunday()] });
      expect(manual.body.inserted).toBe(0);
      expect(manual.body.skipped.join(' ')).toContain('Sunday');
      expect((await detail(id)).slots).toHaveLength(0);
    }
  });

  it('hides and rejects a stale/forged dealership Sunday offer even when globally enabled', async () => {
    const before = (await get('/api/admin/config', admin)).body.config.scheduling;
    await configure({ daysOfOperation: [0, 1, 2, 3, 4, 5, 6] });
    try {
      const id = await submitAndFind(corollaIntake({ sellerType: 'dealership', dealershipName: '' }));
      const monday = new Date(Date.parse(nextSunday()) + 86_400_000 - 8 * 3600_000).toISOString();
      expect((await offer(id, [monday])).status).toBe(200);
      const d = await detail(id), slotId = d.slots[0].id;
      const start = nextSunday(); const end = new Date(Date.parse(start) + 7200_000).toISOString();
      await executeLocalD1(`UPDATE appointment_slots SET starts_at=${sqlLiteral(start)}, ends_at=${sqlLiteral(end)} WHERE id=${sqlLiteral(slotId)}`);
      const headers = await portalHeaders(id);
      expect((await get('/api/portal', headers)).body.slots).toHaveLength(0);
      const response = await post('/api/portal/action', { action: 'select_slot', slotId }, headers);
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('Sunday');
      // Neither a missing classification nor an arbitrary value opens Sunday.
      for (const type of ['NULL', "'unknown'"]) {
        await executeLocalD1(`UPDATE ppi_requests SET seller_type=${type} WHERE id=${sqlLiteral(id)}`);
        expect((await post('/api/portal/action', { action: 'select_slot', slotId }, headers)).status).toBe(409);
      }
    } finally { await configure(before); }
  });

  it('confirms residence on the same legacy private request without resubmission or an email', async () => {
    const id = await submitAndFind(corollaIntake({ inspectionLocationType: undefined, permInspection: false }));
    const old = await detail(id);
    expect(old.request.seller_type).toBe('private');
    expect(old.proposalDraft.sundayEligible).toBe(false);
    const updated = await adminPost(id, { action: 'set_inspection_location', inspectionLocationType: 'private_residence', permInspection: true });
    expect(updated.status).toBe(200);
    const ready = await detail(id);
    expect(ready.request.id).toBe(old.request.id);
    expect(ready.request.ref).toBe(old.request.ref);
    expect(ready.proposalDraft.sundayEligible).toBe(true);
    expect(ready.messages).toHaveLength(old.messages.length);
    expect((await offer(id, [new Date(Date.parse(nextSunday(1)) - 8 * 3600_000).toISOString()])).status).toBe(200);
    // Existing explicit eligibility is read as-is and does not need another confirmation.
    expect((await detail(id)).proposalDraft.daysOfOperation).toContain(0);
  });

  it('preserves configured Tuesday closure, blackouts, lead times and booking limits', async () => {
    const before = (await get('/api/admin/config', admin)).body.config.scheduling;
    const id = await submitAndFind(corollaIntake());
    const sunday = nextSunday();
    try {
      await configure({ daysOfOperation: [1, 3, 4, 5, 6], blackoutDates: [sunday.slice(0, 10)] });
      const d = await detail(id);
      expect(d.proposalDraft.daysOfOperation).toEqual([0, 1, 3, 4, 5, 6]);
      expect((await offer(id, [sunday])).body.error.skipped.join(' ')).toContain('blacked out');
      const tuesday = new Date(Date.parse(sunday) + 2 * 86_400_000).toISOString();
      expect((await offer(id, [tuesday])).body.error.skipped.join(' ')).toContain('operating');
      await configure({ blackoutDates: [], minLeadHours: 72 });
      const close = new Date(Date.now() + 3600_000).toISOString();
      expect((await offer(id, [close])).body.error.skipped.join(' ')).toContain('lead time');
      const distant = new Date(Date.now() + 60 * 86_400_000).toISOString();
      expect((await offer(id, [distant])).body.error.skipped.join(' ')).toContain('scheduling window');
    } finally { await configure(before); }
  });

  it('keeps Sunday intact through selection, optional late discovery, agreements, mock Checkout and signed idempotent webhook', async () => {
    const id = await submitAndFind(corollaIntake({ year: '2016' }));
    const sunday = nextSunday();
    expect((await offer(id, [sunday])).status).toBe(200);
    const headers = await portalHeaders(id);
    const view = (await get('/api/portal', headers)).body;
    const chosen = view.slots.find((s: Json) => s.startsAt === sunday);
    expect(chosen).toBeTruthy();
    expect(view.discovery.source).toBeNull();
    expect((await post('/api/portal/action', { action: 'select_slot', slotId: 'unoffered_sunday' }, headers)).status).toBe(409);
    expect((await post('/api/portal/action', { action: 'select_slot', slotId: chosen.id, discoverySource: 'other', discoveryDetail: 'A neighborhood flyer' }, headers)).status).toBe(200);
    const held = (await get('/api/portal', headers)).body;
    expect(held.discovery).toEqual({ source: 'other', detail: 'A neighborhood flyer' });
    expect(held.slots[0].startsAt).toBe(sunday);
    const heldDetail = await detail(id);
    const beforeMessages = heldDetail.messages.length;
    // A later blank cannot erase the answer; agreements remain the same required set.
    const accepted = await post('/api/portal/action', { action: 'accept_agreements', typedName: 'Synthetic Sunday Buyer', versionIds: held.agreements.required.map((d: Json) => d.id), discoverySource: '', discoveryDetail: '' }, headers);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await detail(id)).messages).toHaveLength(beforeMessages);
    const checkout = await post('/api/portal/action', { action: 'checkout', discoverySource: 'google_maps' }, headers);
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect((await get('/api/portal', headers)).body.status).toBe('awaiting_payment');
    const params = await (await fetch('http://127.0.0.1:8798/last-session')).json() as Json;
    expect(params['metadata[request_id]']).toBe(id);
    expect(params['metadata[booking_id]']).toBeTruthy();
    expect(JSON.stringify(params)).not.toContain('neighborhood flyer');
    expect(Object.keys(params).some((k) => k.includes('discovery'))).toBe(false);
    const sessionId = new URL(checkout.body.checkoutUrl).pathname.split('/').pop()!;
    const event = { id: `evt_sunday_${seq}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: { id: sessionId, payment_status: 'paid', payment_intent: `pi_sunday_${seq}` } } };
    expect((await sendWebhook(event)).status).toBe(200);
    expect((await sendWebhook(event)).status).toBe(200);
    const booked = (await get('/api/portal', headers)).body;
    expect(booked.status).toBe('confirmed');
    expect(booked.booking.startsAt).toBe(sunday);
    expect(booked.discovery.source).toBe('other');
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(new Date(booked.booking.startsAt))).toBe('Sunday');
    const done = await detail(id);
    expect(done.payments).toHaveLength(1);
    expect(done.history.filter((h: Json) => h.to_status === 'confirmed')).toHaveLength(1);
    expect(done.messages.filter((m: Json) => ['payment_confirmed', 'booking_confirmed', 'owner_notify'].includes(m.template)).some((m: Json) => m.body_text.includes('Sun'))).toBe(true);
    expect((await adminPost(id, { action: 'set_inspection_location', inspectionLocationType: 'other' })).status).toBe(409);
    // Occupied windows plus travel/report buffers still block another request.
    const conflictId = await submitAndFind(corollaIntake());
    const overlap = new Date(Date.parse(sunday) + 2.5 * 3600_000).toISOString();
    const conflict = await offer(conflictId, [overlap]);
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.skipped.join(' ')).toContain('buffers');
  });
});
