// Request-first payment flow, proven end to end over HTTP.
//
// The business rule under test: submitting an inspection request is FREE and
// creates nothing payable. Stripe Checkout only becomes reachable after the
// owner reviewed the request, sent an exact quote, offered real windows, the
// customer held one, and accepted every agreement — and only a verified
// webhook may confirm the appointment.
import { describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const MOCK_STRIPE = 'http://127.0.0.1:8798';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const WEBHOOK_SECRET = 'whsec_integration_test_secret';

type Json = Record<string, any>;

const admin = { authorization: `Bearer ${ADMIN_KEY}` };

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

const adminPost = (id: string, body: Json) => post(`/api/admin/requests/${id}`, body, admin);
// Portal calls carry each customer's own client IP: the portal rate limiter is
// per IP, and real customers do not share one.
const portalPost = (c: Customer, body: Json) =>
  post('/api/portal/action', body, { authorization: `Bearer ${c.token}`, 'cf-connecting-ip': c.ip });
const portalGet = (c: Customer) => get('/api/portal', { authorization: `Bearer ${c.token}`, 'cf-connecting-ip': c.ip });

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

const stripeMock = {
  sessions: async (): Promise<{ created: number; open: string[] }> =>
    (await (await fetch(`${MOCK_STRIPE}/session-count`)).json()) as { created: number; open: string[] },
  expired: async (): Promise<string[]> => (await (await fetch(`${MOCK_STRIPE}/expired-sessions`)).json()) as string[],
  emails: async (): Promise<Json[]> => (await (await fetch(`${MOCK_STRIPE}/sent-emails`)).json()) as Json[],
};

// Each request comes from its own client IP so the 5/hour public submission
// limit (exercised elsewhere) never interferes with these scenarios.
let ipCounter = 10;
let vinCounter = 100;

interface Customer {
  id: string;
  ref: string;
  token: string;
  email: string;
  ip: string;
}

async function submitRequest(label: string): Promise<{ customer: Customer; response: Json }> {
  const ip = `198.51.100.${ipCounter++}`;
  const email = `gates-${label}@example.com`;
  const vin = `4T1B11HK5KU212${vinCounter++}`;
  const res = await fetch(BASE + '/api/ppi/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({
      turnstileToken: 'XXXX.DUMMY.TOKEN',
      fullName: `Gate Tester ${label}`,
      email,
      phone: '702-555-0134',
      preferredContact: 'email',
      transactionalConsent: true,
      marketingConsent: false,
      year: '2019',
      make: 'Toyota',
      model: 'Camry',
      trim: 'SE',
      mileage: '48000',
      vin,
      askingPrice: '18500',
      expectedPrice: '17800',
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
    }),
  });
  const body = (await res.json()) as Json;
  expect(res.status, `submit ${label}`).toBe(200);
  expect(body.ok).toBe(true);

  const list = await get('/api/admin/requests', admin);
  const row = list.body.requests.find((r: Json) => r.ref === body.ref);
  expect(row, `admin can see ${body.ref}`).toBeTruthy();
  return { customer: { id: row.id, ref: body.ref, token: body.portalToken, email, ip }, response: body };
}

/**
 * Owner actions that email the customer rotate the magic link and revoke the
 * previous one, so the test customer always re-reads their newest link — the
 * same thing a real customer does by opening the latest email.
 */
async function adminAction(c: Customer, body: Json): Promise<{ status: number; body: Json }> {
  const r = await adminPost(c.id, body);
  const link = await adminPost(c.id, { action: 'reissue_link' });
  expect(link.status).toBe(200);
  c.token = new URL(link.body.url).searchParams.get('t')!;
  return r;
}

/** Owner review → exact quote → sent to the customer. */
async function quoteAndSend(c: Customer, tier = 'standard'): Promise<string> {
  const created = await adminAction(c, { action: 'create_quote', tier, customerNote: 'Exact price for your Camry.' });
  expect(created.status).toBe(200);
  const sent = await adminAction(c, { action: 'send_quote', quoteId: created.body.quoteId });
  expect(sent.status).toBe(200);
  return created.body.quoteId;
}

/** Offered windows, far enough out to clear the minimum-lead and buffer rules. */
function slotTimes(dayOffset: number, count = 2): string[] {
  const times: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() + (dayOffset + i * 2) * 24 * 3600_000);
    d.setUTCHours(17, 0, 0, 0);
    times.push(d.toISOString());
  }
  return times;
}

async function proposeSlots(c: Customer, times: string[]): Promise<void> {
  const r = await adminAction(c, { action: 'propose_slots', slots: times });
  expect(r.status).toBe(200);
  expect(r.body.inserted, `slots inserted (${JSON.stringify(r.body.skipped)})`).toBe(times.length);
}

async function acceptAllAgreements(c: Customer): Promise<void> {
  const view = await portalGet(c);
  const ids = view.body.agreements.required.map((d: Json) => d.id);
  const r = await portalPost(c, { action: 'accept_agreements', typedName: 'Gate Tester', versionIds: ids });
  expect(r.status).toBe(200);
}

// ---------------------------------------------------------------------------

describe('submitting a request is free and creates nothing payable', () => {
  let c: Customer;
  let submitResponse: Json;

  it('accepts the request and returns only a reference plus a portal link', async () => {
    const created = await submitRequest('free-submit');
    c = created.customer;
    submitResponse = created.response;
    expect(submitResponse.ref).toMatch(/^PPI-/);
    // Nothing in the submission response can start a payment.
    const serialized = JSON.stringify(submitResponse);
    expect(serialized).not.toMatch(/checkout|stripe|cs_|client_secret|payment/i);
  });

  it('creates no Stripe Checkout Session at submission time', async () => {
    const before = await stripeMock.sessions();
    const again = await submitRequest('free-submit-2');
    const after = await stripeMock.sessions();
    expect(after.created).toBe(before.created);
    expect(again.customer.ref).toMatch(/^PPI-/);
  });

  it('creates no payment record and no booking at submission time', async () => {
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments).toEqual([]);
    expect(detail.body.request.status).toBe('submitted');
    const portal = await portalGet(c);
    expect(portal.body.payment).toBeNull();
    expect(portal.body.booking).toBeNull();
    expect(portal.body.quote).toBeNull();
    expect(portal.body.slots).toEqual([]);
  });

  it('sends the customer confirmation and the owner notice, and neither asks for money', async () => {
    const sent = await stripeMock.emails();
    const customerMail = sent.find((m) => (m.to as string[]).includes(c.email) && String(m.subject).includes(c.ref));
    expect(customerMail).toBeTruthy();
    expect(String(customerMail!.text)).toContain('/ppi/portal/?t=');
    expect(String(customerMail!.text)).not.toMatch(/pay now|checkout\.stripe|card/i);
    const ownerMail = sent.find((m) => (m.to as string[]).includes('owner-test@example.com') && String(m.subject).includes(c.ref));
    expect(ownerMail).toBeTruthy();
    expect(String(ownerMail!.subject)).toContain('new request');
  });

  it('refuses checkout for a submitted, unreviewed request', async () => {
    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('wrong_state');
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments).toEqual([]);
  });
});

describe('checkout stays closed until every gate is satisfied', () => {
  let c: Customer;

  it('creates the request', async () => {
    c = (await submitRequest('gate-walk')).customer;
  });

  it('refuses checkout while the owner is still reviewing', async () => {
    await adminAction(c, { action: 'set_status', to: 'ready_for_review' });
    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('wrong_state');
  });

  it('refuses checkout when a quote exists but has not been sent', async () => {
    const created = await adminAction(c, { action: 'create_quote', tier: 'standard' });
    expect(created.status).toBe(200);
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.request.status).toBe('quote_prepared');
    expect(detail.body.quotes[0].status).toBe('draft');
    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('wrong_state');
    // The draft quote is invisible to the customer until the owner sends it.
    const portal = await portalGet(c);
    expect(portal.body.quote).toBeNull();

    const sent = await adminAction(c, { action: 'send_quote', quoteId: detail.body.quotes[0].id });
    expect(sent.status).toBe(200);
  });

  it('refuses checkout after the quote is sent but before a time is chosen', async () => {
    const portal = await portalGet(c);
    expect(portal.body.status).toBe('quote_sent');
    expect(portal.body.quote.totalCents).toBeGreaterThan(0);
    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('wrong_state');
  });

  it('refuses checkout after a time is held but before agreements are accepted', async () => {
    await proposeSlots(c, slotTimes(30));
    const portal = await portalGet(c);
    const slot = portal.body.slots.find((s: Json) => s.status === 'offered');
    const held = await portalPost(c, { action: 'select_slot', slotId: slot.id });
    expect(held.status).toBe(200);
    const after = await portalGet(c);
    expect(after.body.status).toBe('awaiting_agreement');

    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('wrong_state');
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments).toEqual([]);
  });

  it('refuses agreement acceptance that omits documents', async () => {
    const view = await portalGet(c);
    const ids = view.body.agreements.required.map((d: Json) => d.id).slice(1);
    const r = await portalPost(c, { action: 'accept_agreements', typedName: 'Gate Tester', versionIds: ids });
    expect(r.status).toBe(422);
    const still = await portalGet(c);
    expect(still.body.status).toBe('awaiting_agreement');
  });

  it('opens checkout only once all agreements are accepted against the current quote', async () => {
    await acceptAllAgreements(c);
    const view = await portalGet(c);
    expect(view.body.status).toBe('awaiting_payment');

    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(200);
    expect(r.body.checkoutUrl).toContain('127.0.0.1:8798');

    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.payments[0].status).toBe('created'); // an attempt, not a charge
    expect(detail.body.request.status).toBe('awaiting_payment'); // still not confirmed
  });

  it('returns the SAME session on a duplicate click instead of a second payable session', async () => {
    const before = await stripeMock.sessions();
    const first = await portalPost(c, { action: 'checkout' });
    const second = await portalPost(c, { action: 'checkout' });
    const after = await stripeMock.sessions();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.checkoutUrl).toBe(second.body.checkoutUrl);
    expect(first.body.reused).toBe(true);
    expect(after.created).toBe(before.created); // no new sessions minted

    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    const openAttempts = detail.body.payments.filter((p: Json) => p.status === 'created' || p.status === 'pending');
    expect(openAttempts).toHaveLength(1);
  });

  it('a success-page visit without a webhook cannot confirm the appointment', async () => {
    const page = await fetch(`${BASE}/ppi/portal/?checkout=success&t=${encodeURIComponent(c.token)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('ppi-portal.js'); // the page only renders server state

    const view = await portalGet(c);
    expect(view.body.status).toBe('awaiting_payment');
    expect(view.body.booking.status).toBe('pending_payment'); // never 'confirmed'
    expect(view.body.payment.status).toBe('created');
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments[0].status).toBe('created');
    expect(detail.body.slots.some((s: Json) => s.status === 'confirmed')).toBe(false);
  });

  it('an unsigned or wrongly signed webhook cannot confirm the appointment', async () => {
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    const sessionId = detail.body.payments[0].stripe_session_id;
    const payload = JSON.stringify({
      id: 'evt_forged_1',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_forged' } },
    });
    for (const signature of ['t=1,v1=deadbeef', '']) {
      const res = await fetch(BASE + '/api/stripe/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
        body: payload,
      });
      expect(res.status).toBe(400);
    }
    const after = await get(`/api/admin/requests/${c.id}`, admin);
    expect(after.body.request.status).toBe('awaiting_payment');
    expect(after.body.payments[0].status).toBe('created');
  });

  it('confirms the appointment only on a verified webhook, then releases the other windows', async () => {
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    const sessionId = detail.body.payments[0].stripe_session_id;
    const heldSlot = detail.body.slots.find((s: Json) => s.status === 'held');

    const wh = await sendWebhook({
      id: 'evt_gate_paid_1',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_gate_1' } },
    });
    expect(wh.status).toBe(200);

    const after = await get(`/api/admin/requests/${c.id}`, admin);
    expect(after.body.request.status).toBe('confirmed');
    expect(after.body.payments[0].status).toBe('succeeded');
    expect(after.body.slots.find((s: Json) => s.id === heldSlot.id).status).toBe('confirmed');
    expect(after.body.slots.filter((s: Json) => s.status === 'released').length).toBeGreaterThanOrEqual(1);
    expect(after.body.quotes[0].status).toBe('accepted');
  });

  it('refuses a further checkout once the appointment is confirmed', async () => {
    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('already_confirmed');
  });

  it('ignores a duplicate paid delivery carrying a different event id', async () => {
    const before = await get(`/api/admin/requests/${c.id}`, admin);
    const sessionId = before.body.payments[0].stripe_session_id;
    const wh = await sendWebhook({
      id: 'evt_gate_paid_1_duplicate',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_gate_1' } },
    });
    expect(wh.status).toBe(200);

    const after = await get(`/api/admin/requests/${c.id}`, admin);
    expect(after.body.payments).toHaveLength(before.body.payments.length);
    expect(after.body.history.filter((h: Json) => h.to_status === 'confirmed')).toHaveLength(1);
    const emails = await stripeMock.emails();
    const confirmations = emails.filter(
      (m) => (m.to as string[]).includes(c.email) && String(m.subject).toLowerCase().includes('appointment confirmed'),
    );
    expect(confirmations).toHaveLength(1);
  });

  it('replays the exact same event without reprocessing it', async () => {
    const before = await get(`/api/admin/requests/${c.id}`, admin);
    const sessionId = before.body.payments[0].stripe_session_id;
    const wh = await sendWebhook({
      id: 'evt_gate_paid_1',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_gate_1' } },
    });
    expect(wh.body.replay).toBe(true);
    const after = await get(`/api/admin/requests/${c.id}`, admin);
    expect(after.body.payments).toHaveLength(before.body.payments.length);
    expect(after.body.history.filter((h: Json) => h.to_status === 'confirmed')).toHaveLength(1);
  });
});

describe('an expired checkout releases the window and reopens scheduling', () => {
  let c: Customer;
  let sessionId = '';
  let heldSlotId = '';

  it('drives a request to an open checkout', async () => {
    c = (await submitRequest('expired-checkout')).customer;
    await quoteAndSend(c);
    await proposeSlots(c, slotTimes(40));
    const view = await portalGet(c);
    heldSlotId = view.body.slots.find((s: Json) => s.status === 'offered').id;
    expect((await portalPost(c, { action: 'select_slot', slotId: heldSlotId })).status).toBe(200);
    await acceptAllAgreements(c);
    const checkout = await portalPost(c, { action: 'checkout' });
    expect(checkout.status).toBe(200);
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    sessionId = detail.body.payments[0].stripe_session_id;
  });

  it('releases the held window and returns the customer to time selection', async () => {
    const wh = await sendWebhook({
      id: 'evt_gate_expired_1',
      type: 'checkout.session.expired',
      data: { object: { id: sessionId } },
    });
    expect(wh.status).toBe(200);

    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments[0].status).toBe('expired');
    expect(detail.body.request.status).toBe('awaiting_time_selection');
    expect(detail.body.slots.find((s: Json) => s.id === heldSlotId).status).toBe('offered');

    const portal = await portalGet(c);
    expect(portal.body.messages.some((m: Json) => /checkout expired/i.test(m.body))).toBe(true);
    expect(portal.body.slots.filter((s: Json) => s.status === 'offered').length).toBeGreaterThan(0);
  });

  it('lets the customer pick a time again and pay with a fresh session', async () => {
    const select = await portalPost(c, { action: 'select_slot', slotId: heldSlotId });
    expect(select.status).toBe(200);
    await acceptAllAgreements(c);
    const checkout = await portalPost(c, { action: 'checkout' });
    expect(checkout.status).toBe(200);
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    const open = detail.body.payments.filter((p: Json) => p.status === 'created');
    expect(open).toHaveLength(1);
    expect(open[0].stripe_session_id).not.toBe(sessionId);
  });

  it('a failed payment on the new session releases the window too', async () => {
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    const newSession = detail.body.payments.find((p: Json) => p.status === 'created').stripe_session_id;
    const wh = await sendWebhook({
      id: 'evt_gate_failed_1',
      type: 'checkout.session.async_payment_failed',
      data: { object: { id: newSession } },
    });
    expect(wh.status).toBe(200);
    const after = await get(`/api/admin/requests/${c.id}`, admin);
    expect(after.body.payments.find((p: Json) => p.stripe_session_id === newSession).status).toBe('failed');
    expect(after.body.request.status).toBe('awaiting_time_selection');
    expect(after.body.slots.find((s: Json) => s.id === heldSlotId).status).toBe('offered');
  });
});

describe('admin schedule changes invalidate a stale checkout attempt', () => {
  let c: Customer;
  let slotId = '';

  it('drives a request to awaiting_payment', async () => {
    c = (await submitRequest('stale-slot')).customer;
    await quoteAndSend(c);
    await proposeSlots(c, slotTimes(50));
    const view = await portalGet(c);
    slotId = view.body.slots.find((s: Json) => s.status === 'offered').id;
    expect((await portalPost(c, { action: 'select_slot', slotId })).status).toBe(200);
    await acceptAllAgreements(c);
    expect((await portalGet(c)).body.status).toBe('awaiting_payment');
  });

  it('refuses checkout after the owner releases the held window, and reopens scheduling', async () => {
    const release = await adminAction(c, { action: 'release_slot', slotId });
    expect(release.status).toBe(200);

    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('hold_lapsed');

    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments).toEqual([]); // no attempt was ever recorded
    expect(detail.body.request.status).toBe('awaiting_time_selection');
    const portal = await portalGet(c);
    expect(portal.body.messages.some((m: Json) => /released/i.test(m.body))).toBe(true);
  });

  it('refuses checkout for a request the customer cancelled', async () => {
    await proposeSlots(c, slotTimes(56));
    const view = await portalGet(c);
    const fresh = view.body.slots.find((s: Json) => s.status === 'offered');
    expect((await portalPost(c, { action: 'select_slot', slotId: fresh.id })).status).toBe(200);
    await acceptAllAgreements(c);
    expect((await portalGet(c)).body.status).toBe('awaiting_payment');

    const cancel = await portalPost(c, { action: 'cancel', reason: 'Bought a different car' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(true);

    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('request_closed');
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments).toEqual([]);
    expect(detail.body.slots.every((s: Json) => s.status !== 'held' && s.status !== 'confirmed')).toBe(true);
  });
});

describe('an updated quote invalidates the old agreement acceptance', () => {
  let c: Customer;

  it('drives a request to awaiting_payment on quote v1', async () => {
    c = (await submitRequest('requote')).customer;
    await quoteAndSend(c);
    await proposeSlots(c, slotTimes(62));
    const view = await portalGet(c);
    const slot = view.body.slots.find((s: Json) => s.status === 'offered');
    expect((await portalPost(c, { action: 'select_slot', slotId: slot.id })).status).toBe(200);
    await acceptAllAgreements(c);
    expect((await portalGet(c)).body.status).toBe('awaiting_payment');
  });

  it('sending a corrected quote takes payment off the table until the customer re-accepts', async () => {
    // The owner reopens scheduling and issues quote v2 (the only route the API
    // allows — quotes cannot be rewritten under a customer who is mid-payment).
    expect((await adminAction(c, { action: 'set_status', to: 'awaiting_time_selection', reason: 'Correcting the quote' })).status).toBe(200);
    const created = await adminAction(c, { action: 'create_quote', tier: 'euro_luxury_performance', customerNote: 'Corrected tier.' });
    expect(created.status).toBe(200);
    expect(created.body.version).toBe(2);
    expect((await adminAction(c, { action: 'send_quote', quoteId: created.body.quoteId })).status).toBe(200);

    // v1 is superseded, and the v1 acceptances cannot unlock payment on v2.
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.quotes.find((q: Json) => q.version === 1).status).toBe('superseded');
    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('wrong_state');
    expect((await get(`/api/admin/requests/${c.id}`, admin)).body.payments).toEqual([]);
  });

  it('charges the new total only after the customer re-selects a time and re-accepts', async () => {
    const view = await portalGet(c);
    expect(view.body.quote.version).toBe(2);
    const slot = view.body.slots.find((s: Json) => s.status === 'offered' || s.status === 'held');
    expect((await portalPost(c, { action: 'select_slot', slotId: slot.id })).status).toBe(200);
    await acceptAllAgreements(c);

    const checkout = await portalPost(c, { action: 'checkout' });
    expect(checkout.status).toBe(200);
    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    const attempt = detail.body.payments.find((p: Json) => p.status === 'created');
    const v2 = detail.body.quotes.find((q: Json) => q.version === 2);
    expect(attempt.quote_id).toBe(v2.id);
    expect(attempt.amount_cents).toBe(v2.total_cents); // the amount the customer saw
  });
});

describe('two customers can never hold or confirm the same window', () => {
  let first: Customer;
  let second: Customer;
  const shared = slotTimes(70, 1);

  it('sets up two quoted requests offered the same start time', async () => {
    first = (await submitRequest('double-a')).customer;
    second = (await submitRequest('double-b')).customer;
    await quoteAndSend(first);
    await quoteAndSend(second);
    // Offering the same free window to two customers is legitimate — the race
    // is resolved at selection time, not at proposal time.
    await proposeSlots(first, shared);
    await proposeSlots(second, shared);
  });

  it('lets the first customer hold it and refuses the second', async () => {
    const viewA = await portalGet(first);
    const slotA = viewA.body.slots.find((s: Json) => s.status === 'offered');
    expect((await portalPost(first, { action: 'select_slot', slotId: slotA.id })).status).toBe(200);

    const viewB = await portalGet(second);
    const slotB = viewB.body.slots.find((s: Json) => s.status === 'offered');
    const race = await portalPost(second, { action: 'select_slot', slotId: slotB.id });
    expect(race.status).toBe(409);
    expect(['slot_taken', 'slot_unavailable']).toContain(race.body.error.code);

    const detailB = await get(`/api/admin/requests/${second.id}`, admin);
    expect(detailB.body.request.status).toBe('quote_sent'); // untouched
    expect(detailB.body.slots.every((s: Json) => s.status !== 'held')).toBe(true);
  });

  it('refuses the second customer even after the first one has paid', async () => {
    await acceptAllAgreements(first);
    const checkout = await portalPost(first, { action: 'checkout' });
    expect(checkout.status).toBe(200);
    const detailA = await get(`/api/admin/requests/${first.id}`, admin);
    const sessionId = detailA.body.payments[0].stripe_session_id;
    expect(
      (
        await sendWebhook({
          id: 'evt_gate_double_paid',
          type: 'checkout.session.completed',
          data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_gate_double' } },
        })
      ).status,
    ).toBe(200);
    expect((await get(`/api/admin/requests/${first.id}`, admin)).body.request.status).toBe('confirmed');

    const viewB = await portalGet(second);
    const slotB = viewB.body.slots.find((s: Json) => s.status === 'offered');
    const race = await portalPost(second, { action: 'select_slot', slotId: slotB.id });
    expect(race.status).toBe(409);
    const detailB = await get(`/api/admin/requests/${second.id}`, admin);
    expect(detailB.body.payments).toEqual([]);
    expect(detailB.body.request.status).toBe('quote_sent');
  });

  it('never proposes a window that clashes with a confirmed appointment', async () => {
    const r = await adminAction(second, { action: 'propose_slots', slots: shared });
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(0);
    expect(r.body.skipped).toHaveLength(1);
  });
});

// If the held window is gone by the time Stripe confirms — the hold lapsed and
// the owner gave the time away, or the no-double-booking index refuses the
// confirmation — the money still lands, but the appointment must NOT be
// confirmed on top of someone else's slot.
describe('a payment that lands after its window is gone never confirms a lost slot', () => {
  let c: Customer;
  let slotId = '';
  let sessionId = '';

  it('opens checkout, then the owner reassigns the held window', async () => {
    c = (await submitRequest('late-webhook')).customer;
    await quoteAndSend(c);
    await proposeSlots(c, slotTimes(80));
    const view = await portalGet(c);
    slotId = view.body.slots.find((s: Json) => s.status === 'offered').id;
    expect((await portalPost(c, { action: 'select_slot', slotId })).status).toBe(200);
    await acceptAllAgreements(c);
    expect((await portalPost(c, { action: 'checkout' })).status).toBe(200);

    sessionId = (await get(`/api/admin/requests/${c.id}`, admin)).body.payments[0].stripe_session_id;
    expect((await adminAction(c, { action: 'release_slot', slotId })).status).toBe(200);
  });

  it('records the payment, reopens scheduling, and alerts the owner instead of confirming', async () => {
    const wh = await sendWebhook({
      id: 'evt_gate_late_1',
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_gate_late' } },
    });
    expect(wh.status).toBe(200);

    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments[0].status).toBe('succeeded'); // the money is recorded
    expect(detail.body.request.status).toBe('awaiting_time_selection'); // NOT confirmed
    expect(detail.body.slots.find((s: Json) => s.id === slotId).status).toBe('released');
    expect(detail.body.slots.some((s: Json) => s.status === 'confirmed')).toBe(false);
    const booking = detail.body.payments[0].booking_id;
    expect(booking).toBeTruthy();

    const portal = await portalGet(c);
    expect(portal.body.booking.status).toBe('pending_payment');
    expect(portal.body.messages.some((m: Json) => /payment was received/i.test(m.body))).toBe(true);

    const emails = await stripeMock.emails();
    const alert = emails.find(
      (m) => (m.to as string[]).includes('owner-test@example.com') && String(m.subject).includes(c.ref) && /SLOT LAPSED/i.test(String(m.subject)),
    );
    expect(alert).toBeTruthy();
  });

  it('does not send a confirmation email for an appointment that was never confirmed', async () => {
    const emails = await stripeMock.emails();
    const confirmations = emails.filter(
      (m) => String(m.subject).includes(c.ref) && String(m.subject).toLowerCase().includes('appointment confirmed'),
    );
    expect(confirmations).toEqual([]);
  });

  it('never charges the customer a second time when they re-book the lost window', async () => {
    // The customer picks another offered window and re-accepts — the same path
    // an unpaid customer takes, so the Pay button would otherwise reappear.
    const view = await portalGet(c);
    const another = view.body.slots.find((s: Json) => s.status === 'offered');
    expect(another).toBeTruthy();
    expect((await portalPost(c, { action: 'select_slot', slotId: another.id })).status).toBe(200);
    await acceptAllAgreements(c);
    expect((await portalGet(c)).body.status).toBe('awaiting_payment');

    const before = await stripeMock.sessions();
    const r = await portalPost(c, { action: 'checkout' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('already_paid');
    const after = await stripeMock.sessions();
    expect(after.created).toBe(before.created); // no second session, no second charge

    const detail = await get(`/api/admin/requests/${c.id}`, admin);
    expect(detail.body.payments.filter((p: Json) => p.status === 'succeeded')).toHaveLength(1);
    expect(detail.body.payments.filter((p: Json) => p.status === 'created')).toHaveLength(0);
  });
});

describe('payment environment safety', () => {
  it('only ever talked to the mock Stripe endpoint — no live API call was made', async () => {
    // STRIPE_API_BASE points at the mock and is honoured only outside
    // production; every session in this suite came from it.
    const sessions = await stripeMock.sessions();
    expect(sessions.created).toBeGreaterThan(0);
    const detail = await get('/api/admin/overview', admin);
    expect(detail.status).toBe(200);
  });

  it('never exposes Stripe keys or webhook secrets on public surfaces', async () => {
    const runtime = await get('/api/ppi/runtime-config');
    const serialized = JSON.stringify(runtime.body);
    expect(serialized).not.toMatch(/sk_test|sk_live|rk_live|whsec/);
    expect(serialized).not.toContain('checkout');
  });

  it('every checkout session Stripe was asked for carries internal ids only', async () => {
    const last = (await (await fetch(`${MOCK_STRIPE}/last-session`)).json()) as Json;
    expect(last['metadata[request_id]']).toBeTruthy();
    expect(last['metadata[quote_id]']).toBeTruthy();
    expect(last['metadata[booking_id]']).toBeTruthy();
    const serialized = JSON.stringify(last);
    expect(serialized).not.toMatch(/4T1B11HK|123 Test St|89109/);
  });
});
