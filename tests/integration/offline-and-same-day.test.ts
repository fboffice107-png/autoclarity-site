// Two things that used to be impossible, end to end over real HTTP:
//
//   1. The $25 same-day priority fee. It was a configured number that no code
//      path ever added to a price, so the box on the intake form did nothing.
//   2. Recording money collected outside Stripe. A real customer paid $325 in
//      cash and the system had nowhere to put it: the request sat at
//      "submitted" forever and the revenue figures were short by the only
//      money the business had actually taken.

import { describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const CLIENT_IP = '203.0.113.31';

type Json = Record<string, any>;

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

let seq = 0;
function intake(overrides: Json = {}): Json {
  seq += 1;
  return {
    turnstileToken: 'XXXX.DUMMY.TOKEN',
    submissionKey: `offlinesameday_${String(seq).padStart(8, '0')}`,
    attributionSource: 'ppi_direct',
    fullName: 'Offline Buyer',
    email: `offline-${seq}@example.com`,
    phone: '702-555-0188',
    preferredContact: 'email',
    transactionalConsent: true,
    marketingConsent: false,
    year: '2018', make: 'Mercedes-Benz', model: 'GLS-Class', trim: 'AMG GLS 63',
    mileage: '61000', modStatus: 'stock', titleStatus: 'clean', startsDrives: 'yes',
    locStreet: '4000 Example Ave', locCity: 'Las Vegas', locState: 'NV', locZip: '89147',
    sellerType: 'private', inspectionLocationType: 'private_residence', permInspection: true, permRoadTest: 'yes', permPhotos: 'yes',
    permUnderbody: 'unknown', ackAccessDependent: true,
    decisionTimeline: 'few_days', timeWindow: 'afternoon', sameDayPriority: false,
    ...overrides,
  };
}

async function submitAndFind(payload: Json): Promise<string> {
  const submitted = await post('/api/ppi/requests', payload, { 'cf-connecting-ip': `203.0.113.${(seq % 60) + 150}` });
  expect(JSON.stringify(submitted)).toContain('"ok":true');
  const list = await get('/api/admin/requests?include=test', admin);
  const row = list.body.requests.find((r: Json) => r.id === submitted.body.requestId)
    ?? list.body.requests.find((r: Json) => r.ref === submitted.body.ref);
  expect(row, 'submitted request should appear in the admin list').toBeTruthy();
  return row.id;
}

/** Hours on today's Las Vegas date, and on a day well in the future. */
function hoursToday(count = 3): string[] {
  // Keep the test on today's business-local date even when UTC is tomorrow.
  // Immediate future instants also avoid testing already-past afternoon slots.
  return Array.from({ length: count }, (_, i) => new Date(Date.now() + (i + 1) * 1000).toISOString());
}
function hoursOnDay(daysOut: number, count = 3): string[] {
  const day = new Date(Date.now() + daysOut * 86_400_000).toISOString().slice(0, 10);
  return Array.from({ length: count }, (_, i) =>
    new Date(`${day}T${String(18 + i).padStart(2, '0')}:00:00.000Z`).toISOString());
}

describe('the $25 same-day priority fee', () => {
  it('appears on the public estimate the moment the box is ticked', async () => {
    const plain = await post('/api/ppi/estimate', { year: 2019, make: 'Toyota', model: 'Corolla', locZip: '89147' });
    expect(plain.status).toBe(200);
    expect(plain.body.totalCents).toBe(19900);

    const rushed = await post('/api/ppi/estimate', {
      year: 2019, make: 'Toyota', model: 'Corolla', locZip: '89147', sameDayPriority: true,
    });
    expect(rushed.body.totalCents).toBe(19900 + 2500);
    expect(rushed.body.sameDayPriority).toBe(true);
    expect(rushed.body.lines.some((l: Json) => l.label === 'Same-day priority' && l.display === '$25.00')).toBe(true);
  });

  it('is charged on a proposal that really does offer a time today', async () => {
    const id = await submitAndFind(intake({ sameDayPriority: true }));
    const slots = hoursToday();

    const preview = await adminPost(id, { action: 'price_preview', tier: 'standard', sameDayPriority: true, slots });
    expect(preview.body.totalCents).toBe(19900 + 2500);

    const sent = await adminPost(id, {
      action: 'send_booking_proposal', tier: 'standard', sameDayPriority: true, slots,
      proposalKey: `sameday_charged_${id}`,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.sameDayPriority).toBe(true);
    expect(sent.body.sameDayFeeDropped).toBeFalsy();

    const detail = await get(`/api/admin/requests/${id}`, admin);
    expect(detail.body.proposal.totalCents).toBe(19900 + 2500);
  });

  it('is NOT charged when every offered time is a later day', async () => {
    // The intake page promises this in writing, so the owner leaving the box
    // ticked must not be able to overcharge a customer who is booked next week.
    const id = await submitAndFind(intake({ sameDayPriority: true }));
    const slots = hoursOnDay(6);

    const preview = await adminPost(id, { action: 'price_preview', tier: 'standard', sameDayPriority: true, slots });
    expect(preview.body.totalCents).toBe(19900);

    const sent = await adminPost(id, {
      action: 'send_booking_proposal', tier: 'standard', sameDayPriority: true, slots,
      proposalKey: `sameday_dropped_${id}`,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.sameDayPriority).toBe(false);
    expect(sent.body.sameDayFeeDropped).toBe(true);

    const detail = await get(`/api/admin/requests/${id}`, admin);
    expect(detail.body.proposal.totalCents).toBe(19900);
  });
});

describe('money collected outside Stripe', () => {
  it('records the job, counts the revenue, and invents no Stripe charge', async () => {
    const id = await submitAndFind(intake());
    // Whatever the intake itself sent; recording must add nothing to it.
    const before = await get(`/api/admin/requests/${id}`, admin);
    const outboundBefore = before.body.messages.filter((m: Json) => m.direction === 'outbound').length;

    const recorded = await adminPost(id, {
      action: 'record_offline_payment',
      amountCents: 32500,
      tier: 'euro_luxury_performance',
      offlineNote: 'Zelle',
      collectedAt: '2026-08-27T19:00:00.000Z',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.amountLabel).toBe('$325.00');
    expect(recorded.body.status).toBe('confirmed');

    const detail = await get(`/api/admin/requests/${id}`, admin);
    expect(detail.body.request.status).toBe('confirmed');
    const payment = detail.body.payments[0];
    expect(payment.amount_cents).toBe(32500);
    expect(payment.status).toBe('succeeded');
    expect(payment.method).toBe('offline');
    expect(payment.offline_note).toBe('Zelle');
    // Nothing that support could look up in Stripe and fail to find.
    expect(payment.stripe_session_id).toBeFalsy();
    expect(payment.stripe_payment_intent).toBeFalsy();

    // Recording a job that happened weeks ago must not email that customer a
    // fresh booking confirmation out of the blue.
    expect(detail.body.messages.filter((m: Json) => m.direction === 'outbound')).toHaveLength(outboundBefore);

    // The walk through the state machine is recorded, so the history reads
    // like a normal job rather than a row that teleported to confirmed.
    const history = detail.body.history ?? [];
    expect(history.some((h: Json) => h.to_status === 'confirmed')).toBe(true);
  });

  it('refuses to record a second payment against the same job', async () => {
    const id = await submitAndFind(intake());
    const first = await adminPost(id, { action: 'record_offline_payment', amountCents: 19900, offlineNote: 'cash' });
    expect(first.status).toBe(200);
    const second = await adminPost(id, { action: 'record_offline_payment', amountCents: 19900, offlineNote: 'cash again' });
    expect(second.status).toBe(409);
  });

  it('insists on knowing how the money arrived', async () => {
    const id = await submitAndFind(intake());
    const vague = await adminPost(id, { action: 'record_offline_payment', amountCents: 19900 });
    expect(vague.status).toBe(422);
  });

  it('still refuses to call the job completed without a delivered report', async () => {
    // "Completed" is what tells a customer their report is ready. Paying for
    // the job cannot be allowed to claim it.
    const id = await submitAndFind(intake());
    await adminPost(id, { action: 'record_offline_payment', amountCents: 32500, offlineNote: 'cash at the vehicle' });
    const completed = await adminPost(id, { action: 'set_status', status: 'completed' });
    expect(completed.status).toBeGreaterThanOrEqual(400);
    const detail = await get(`/api/admin/requests/${id}`, admin);
    expect(detail.body.request.status).not.toBe('completed');
  });
});
