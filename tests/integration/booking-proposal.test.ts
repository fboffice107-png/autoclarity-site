// The representative journey, end to end over real HTTP against the live
// local stack and the mock Stripe:
//
//   a Standard Corolla, included travel, no extras, shows $199 at EVERY step;
//   the owner sends THREE afternoon options in ONE action;
//   the customer picks one, accepts the agreements, pays, and sees a
//   confirmed appointment.
//
// Plus the failure shapes that used to be silent: a proposal with no usable
// times, a duplicate send, a retry, and a fee-boundary flag.

import { describe, expect, it } from 'vitest';

const BASE = 'http://127.0.0.1:8799';
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const WEBHOOK_SECRET = 'whsec_integration_test_secret';

type Json = Record<string, any>;

// This suite's own client address. Rate limits are per-IP by design, so a
// dedicated address keeps this file from spending another file's budget.
const CLIENT_IP = '203.0.113.11';

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
    submissionKey: `bookingproposal_${String(seq).padStart(8, '0')}`,
    attributionSource: 'ppi_direct',
    fullName: 'Dang Proposal',
    email: `proposal-${seq}@example.com`,
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

async function submitAndFind(payload: Json): Promise<string> {
  // Intake is rate limited per IP by design; give each fixture its own client
  // address so the limiter measures what it is meant to measure.
  const submitted = await post('/api/ppi/requests', payload, { 'cf-connecting-ip': `203.0.113.${(seq % 200) + 20}` });
  expect(submitted.status).toBe(200);
  expect(submitted.body.ok).toBe(true);
  const list = await get('/api/admin/requests', admin);
  const row = list.body.requests.find((r: Json) => r.id === submitted.body.requestId)
    ?? list.body.requests.find((r: Json) => r.ref === submitted.body.ref);
  expect(row, 'submitted request should appear in the admin list').toBeTruthy();
  return row.id;
}

/**
 * Three afternoon options on one Las Vegas day, past the 18-hour lead time.
 * Each caller gets its own day, and the minutes are deliberately odd, so this
 * file's appointments cannot collide with fixtures scheduled elsewhere in the
 * integration suite (which occupy days 6 and 10-20).
 */
function afternoonOptions(daysOut: number): string[] {
  const day = new Date(Date.now() + daysOut * 86_400_000).toISOString().slice(0, 10);
  // 1:07pm / 3:07pm / 4:52pm Pacific, expressed in UTC.
  return ['20:07', '22:07', '23:52'].map((hhmm) => new Date(`${day}T${hhmm}:00.000Z`).toISOString());
}

describe('booking proposal — one owner action, one customer decision', () => {
  it('shows $199 at every step for a Standard Corolla with included travel', async () => {
    const payload = corollaIntake();

    // 1. What the customer is shown BEFORE submitting.
    const estimate = await post('/api/ppi/estimate', {
      year: payload.year, make: payload.make, model: payload.model, trim: payload.trim,
      modStatus: 'stock', titleStatus: 'clean', startsDrives: 'yes', locZip: payload.locZip,
    });
    expect(estimate.status).toBe(200);
    expect(estimate.body.suggestedTier).toBe('standard');
    expect(estimate.body.totalCents).toBe(19900);
    expect(estimate.body.travel.included).toBe(true);
    expect(estimate.body.travel.feeCents).toBe(0);
    expect(estimate.body.lines.find((l: Json) => l.kind === 'travel').display).toBe('Included');
    expect(estimate.body.kind).toBe('estimate');
    expect(estimate.body.disclaimer).toContain('estimate');

    const requestId = await submitAndFind(payload);

    // 2. What the owner is shown when the request is opened.
    const detail = await get(`/api/admin/requests/${requestId}`, admin);
    expect(detail.status).toBe(200);
    expect(detail.body.proposalDraft.tier).toBe('standard');
    expect(detail.body.proposalDraft.totalCents).toBe(19900);
    expect(detail.body.proposalDraft.travel.included).toBe(true);
    expect(detail.body.proposalDraft.travelOriginLabel).toContain('89147');
    expect(detail.body.proposal).toBeNull();

    // 3. What the send button will say.
    const preview = await adminPost(requestId, { action: 'price_preview', tier: 'standard' });
    expect(preview.status).toBe(200);
    expect(preview.body.totalCents).toBe(19900);

    // 4. Three afternoon options, one action.
    const slots = afternoonOptions(3);
    const sent = await adminPost(requestId, {
      action: 'send_booking_proposal',
      tier: 'standard',
      slots,
      proposalKey: `corolla-happy-path-${seq}`,
      vehicleLabel: '2019 Toyota Corolla LE',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.totalCents).toBe(19900);
    expect(sent.body.offeredSlots, `skipped: ${JSON.stringify(sent.body.skipped)}`).toBe(3);
    expect(sent.body.skipped).toHaveLength(0);
    expect(sent.body.notification.messageId).toBeTruthy();

    // 5. The saved proposal survives a reload and states the delivery truth.
    const afterSend = await get(`/api/admin/requests/${requestId}`, admin);
    expect(afterSend.body.request.status).toBe('awaiting_time_selection');
    expect(afterSend.body.proposal.totalCents).toBe(19900);
    expect(afterSend.body.proposal.slots).toHaveLength(3);
    expect(['sent', 'queued']).toContain(afterSend.body.proposal.notificationStatus);
    expect(afterSend.body.proposal.createdAt).toBeTruthy();
    // Exactly one customer notification, not three.
    const proposalEmails = afterSend.body.messages.filter((m: Json) => m.template === 'booking_proposal');
    expect(proposalEmails).toHaveLength(1);
    // The one email carries the price, the times and one link — and reads
    // like a sentence rather than a template with a hole in it.
    const emailBody: string = proposalEmails[0].body_text;
    expect(emailBody).toContain('inspection for 2019 Toyota Corolla LE is ready to book');
    expect(emailBody).toContain('Standard Vehicle PPI: $199.00');
    expect(emailBody).toContain('Mobile-service charge: Included');
    expect(emailBody).toContain('Total: $199.00');
    expect(emailBody).not.toContain('for the your vehicle');
    expect(emailBody.match(/\/ppi\/portal\/\?t=/gu) ?? []).toHaveLength(1);
    expect(emailBody).toMatch(/AVAILABLE TIMES\n(\s+•.*\n){3}/u);

    // 6. The customer opens the single link.
    const link = await adminPost(requestId, { action: 'reissue_link' });
    const token = new URL(link.body.url).searchParams.get('t')!;
    const portal = { authorization: `Bearer ${token}` };
    const view = await get('/api/portal', portal);
    expect(view.body.quote.totalCents).toBe(19900);
    expect(view.body.slots.filter((s: Json) => s.status === 'offered')).toHaveLength(3);

    // 7. Choose a time → accept → pay.
    const chosen = view.body.slots.find((s: Json) => s.status === 'offered');
    const selected = await post('/api/portal/action', { action: 'select_slot', slotId: chosen.id }, portal);
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);

    const held = await get('/api/portal', portal);
    expect(held.body.status).toBe('awaiting_agreement');
    expect(held.body.quote.totalCents).toBe(19900);

    const accept = await post('/api/portal/action', {
      action: 'accept_agreements',
      typedName: 'Dang Proposal',
      versionIds: held.body.agreements.required.map((d: Json) => d.id),
    }, portal);
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);

    const checkout = await post('/api/portal/action', { action: 'checkout' }, portal);
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(checkout.body.checkoutUrl).toBeTruthy();

    // The amount Stripe is actually asked to charge is the same $199.
    const session = await (await fetch('http://127.0.0.1:8798/last-session')).json() as Json;
    expect(session['line_items[0][price_data][unit_amount]']).toBe('19900');
    expect(session['line_items[0][price_data][currency]']).toBe('usd');

    const sessionId = new URL(checkout.body.checkoutUrl).pathname.split('/').pop()!;
    expect(sessionId).toMatch(/^cs_mock_/u);
    const webhook = await sendWebhook({
      id: `evt_proposal_${seq}`,
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, payment_status: 'paid', payment_intent: `pi_mock_proposal_${seq}` } },
    });
    expect(webhook.status, JSON.stringify(webhook.body)).toBe(200);

    // 8. What the customer sees afterwards.
    const confirmed = await get('/api/portal', portal);
    expect(confirmed.body.status).toBe('confirmed');
    expect(confirmed.body.booking.status).toBe('confirmed');
    expect(confirmed.body.payment.status).toBe('succeeded');
    expect(confirmed.body.payment.amountCents).toBe(19900);
    expect(confirmed.body.slots.find((s: Json) => s.id === chosen.id).status).toBe('confirmed');
    // The alternatives were released, never held as extra appointments.
    expect(confirmed.body.slots.filter((s: Json) => s.status === 'offered')).toHaveLength(0);
  });

  it('refuses to save a proposal whose times are all unusable, and says why', async () => {
    const requestId = await submitAndFind(corollaIntake());
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const tooSoon = new Date(Date.now() + 3600_000).toISOString();

    const r = await adminPost(requestId, {
      action: 'send_booking_proposal',
      tier: 'standard',
      slots: [past, tooSoon],
      proposalKey: `unusable-proposal-${seq}`,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('no_usable_times');
    expect(r.body.error.skipped.join(' ')).toContain('lead time');

    // Nothing was written: no quote, no times, no email, no status change.
    const after = await get(`/api/admin/requests/${requestId}`, admin);
    expect(after.body.request.status).toBe('submitted');
    expect(after.body.quotes).toHaveLength(0);
    expect(after.body.slots).toHaveLength(0);
    expect(after.body.proposal).toBeNull();
  });

  it('treats a repeated send as the same proposal, not a second one', async () => {
    const requestId = await submitAndFind(corollaIntake());
    const slots = afternoonOptions(5);
    const key = `idem-proposal-key-${seq}`;

    const first = await adminPost(requestId, { action: 'send_booking_proposal', tier: 'standard', slots, proposalKey: key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    const second = await adminPost(requestId, { action: 'send_booking_proposal', tier: 'standard', slots, proposalKey: key });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.proposal.id).toBe(first.body.proposalId);

    const after = await get(`/api/admin/requests/${requestId}`, admin);
    expect(after.body.quotes).toHaveLength(1);
    expect(after.body.slots.filter((s: Json) => s.status === 'offered')).toHaveLength(3);
    expect(after.body.messages.filter((m: Json) => m.template === 'booking_proposal')).toHaveLength(1);
  });

  it('retries a notification without creating a second proposal or a second email', async () => {
    const requestId = await submitAndFind(corollaIntake());
    const sent = await adminPost(requestId, {
      action: 'send_booking_proposal',
      tier: 'standard',
      slots: afternoonOptions(7),
      proposalKey: `retry-proposal-${seq}`,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const retry = await adminPost(requestId, { action: 'retry_proposal_notification', proposalId: sent.body.proposalId });
    expect(retry.status).toBe(200);

    const after = await get(`/api/admin/requests/${requestId}`, admin);
    expect(after.body.messages.filter((m: Json) => m.template === 'booking_proposal')).toHaveLength(1);
    expect(after.body.quotes).toHaveLength(1);
  });

  it('carries the travel fee into the total for a further-out ZIP, and never blanks it', async () => {
    // Boulder City is a real, mapped, far ZIP: a visible charge, not a blank.
    const requestId = await submitAndFind(corollaIntake({ locZip: '89005', locCity: 'Boulder City' }));
    const detail = await get(`/api/admin/requests/${requestId}`, admin);
    const travelLine = detail.body.proposalDraft.lines.find((l: Json) => l.kind === 'travel');
    expect(travelLine).toBeTruthy();
    expect(travelLine.display).not.toBe('');
    if (detail.body.proposalDraft.totalCents !== null) {
      // Inside the banded range: base + a stated, non-zero mobile-service charge.
      expect(detail.body.proposalDraft.totalCents).toBeGreaterThan(19900);
      expect(travelLine.amountCents).toBeGreaterThan(0);
    } else {
      // Beyond the last band: refused, with the reason stated, never guessed.
      expect(travelLine.display).toBe('Custom review required');
      expect(detail.body.proposalDraft.reviewNotes.join(' ')).toContain('custom travel amount');
      const blocked = await adminPost(requestId, {
        action: 'send_booking_proposal',
        tier: 'standard',
        slots: afternoonOptions(9),
        proposalKey: `far-proposal-${seq}`,
      });
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('travel_quote_required');
    }
  });

  it('records a customer-selected package and flags a disagreement for review', async () => {
    // A Corvette suggests Luxury & Performance; the customer picks Standard.
    const requestId = await submitAndFind(corollaIntake({
      make: 'Chevrolet', model: 'Corvette', trim: 'Stingray', selectedTier: 'standard',
    }));
    const detail = await get(`/api/admin/requests/${requestId}`, admin);
    expect(detail.body.proposalDraft.suggestedTier).toBe('euro_luxury_performance');
    expect(detail.body.proposalDraft.customerSelectedTier).toBe('standard');
    expect(detail.body.proposalDraft.tierMismatch.direction).toBe('lower');
    expect(Number(detail.body.request.tier_review_needed)).toBe(1);
    // The customer's pick is what gets prefilled — it is never silently raised.
    expect(detail.body.proposalDraft.tier).toBe('standard');
    expect(detail.body.proposalDraft.totalCents).toBe(19900);
  });

  it('keeps a heavily modified vehicle at its vehicle price and explains the review', async () => {
    const requestId = await submitAndFind(corollaIntake({
      modStatus: 'heavy', modDetails: 'turbo kit, coilovers, roll cage',
    }));
    const detail = await get(`/api/admin/requests/${requestId}`, admin);
    expect(detail.body.proposalDraft.tier).toBe('standard');
    expect(detail.body.proposalDraft.totalCents).toBe(19900);
    expect(detail.body.proposalDraft.manualReview).toBe(true);
    expect(detail.body.proposalDraft.reviewCeiling).toBe('exotic_collector');
    expect(detail.body.proposalDraft.manualReasons.join(' ')).toContain('turbo kit, coilovers, roll cage');
  });

  it('rejects a modification answer with no description', async () => {
    const r = await post('/api/ppi/requests', corollaIntake({ modStatus: 'light', modDetails: '' }),
      { 'cf-connecting-ip': '203.0.113.240' });
    expect(r.status).toBe(422);
    expect(r.body.fields.modDetails).toContain('what was modified');
  });
});
