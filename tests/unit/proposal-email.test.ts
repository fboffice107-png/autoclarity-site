/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node builtins are supplied by the test runtime.
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error Node builtins are supplied by the test runtime.
import { readFileSync } from 'node:fs';
// @ts-expect-error Node builtins are supplied by the test runtime.
import vm from 'node:vm';
import { onRequestGet, onRequestPost } from '../../functions/api/admin/requests/[id].ts';
import { renderBrandedEmailHtml } from '../../functions/lib/email.ts';
import { canonicalBookingUrl } from '../../functions/lib/proposal-delivery.ts';
import { redactProposalBookingLinks } from '../../functions/lib/proposal-email.ts';
import type { Env } from '../../functions/lib/types.ts';

const migrations = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const origin = 'https://preview.example.com';
const adminKey = 'test-admin-key-0123456789abcdef';
const source = readFileSync(new URL('../../assets/js/ppi-admin.js', import.meta.url), 'utf8');
function asD1(db: DatabaseSync): D1Database {
  function prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async first<T>(column?: string) {
        const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async all<T>() {
        return { success: true, results: db.prepare(sql).all(...values) as T[], meta: {} };
      },
      async run<T>() {
        const result = db.prepare(sql).run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } } as T;
      },
    };
    return statement;
  }

  return {
    prepare,
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function fixture(options: { ownerFails?: boolean; customerFails?: boolean; noProvider?: boolean; owner?: string; failOwnerRecord?: boolean; sms?: boolean; smsFails?: boolean; emailThrows?: boolean; phone?: string; email?: string } = {}) {
  const sql = new DatabaseSync(':memory:');
  for (const name of Object.keys(migrations).sort()) sql.exec(migrations[name]);
  sql.exec(`INSERT INTO customers (id,full_name,email,phone,created_at,updated_at) VALUES ('cus_copy','Taylor Buyer','buyer@example.com','7025550100','2026-01-01','2026-01-01');
    INSERT INTO vehicles (id,year,make,model,mod_status,created_at,updated_at) VALUES ('veh_copy',2016,'Toyota','Corolla','stock','2026-01-01','2026-01-01');
    INSERT INTO ppi_requests (id,ref,customer_id,vehicle_id,status,seller_type,inspection_location_type,perm_inspection,loc_city,loc_zip,created_at,updated_at)
    VALUES ('req_copy','PPI-COPY','cus_copy','veh_copy','submitted','private','private_residence',1,'Las Vegas','89147','2026-01-01','2026-01-01');`);
  if (options.failOwnerRecord) sql.exec(`CREATE TRIGGER fail_owner_copy BEFORE INSERT ON messages WHEN NEW.template = 'owner_booking_proposal' BEGIN SELECT RAISE(ABORT,'synthetic owner outbox failure'); END;`);
  if (options.phone !== undefined) sql.prepare('UPDATE customers SET phone = ?').run(options.phone);
  if (options.email !== undefined) sql.prepare('UPDATE customers SET email = ?').run(options.email);
  if (options.sms) {
    sql.exec("UPDATE customers SET preferred_contact='text', transactional_consent=1");
    sql.exec(`INSERT INTO configuration (key,value_json,updated_at,updated_by) VALUES ('ppi','{"contact":{"smsEnabled":true,"businessPhone":"+17025550123"}}','2026-01-01','test')`);
  }
  const jobs: any[] = [];
  const db = asD1(sql);
  const env = { DB: db, PPI_ENV: 'preview', PPI_MODE: 'live', BOOKING_ENABLED: 'true', ADMIN_DEV_KEY: adminKey,
    PUBLIC_BASE_URL: origin, RESEND_API_KEY: options.noProvider ? '' : 'synthetic-resend-key', EMAIL_FROM: 'AutoClarity <notify@example.com>',
    ADMIN_NOTIFY_EMAIL: options.owner ?? 'owner@example.com', SMS_ENABLED: options.sms ? 'true' : 'false',
    SMS_QUEUE: { send: async (job: any) => { jobs.push(job); if (options.smsFails) throw new Error('secret recipient payload MUST NOT BE LOGGED'); } },
  } as unknown as Env;
  const accepted = new Map<string, any>();
  const calls: any[] = [];
  const failures = { owner: !!options.ownerFails, customer: !!options.customerFails };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.resend.com/emails'); // Every network call stays mocked.
    const body = JSON.parse(String(init.body));
    const key = new Headers(init.headers).get('Idempotency-Key')!;
    calls.push(body);
    if (options.emailThrows && body.to[0] !== 'owner@example.com') throw new Error('private provider payload MUST NOT BE LOGGED');
    const fail = body.to[0] === 'buyer@example.com' ? failures.customer : failures.owner;
    if (fail) return new Response('synthetic provider failure', { status: 500 });
    if (!accepted.has(key)) accepted.set(key, body);
    return Response.json({ id: 'provider_' + key });
  }));
  const pending: Promise<unknown>[] = [];
  const invoke = async (method: string, body?: any, authenticated = true) => {
    const request = new Request(origin + '/api/admin/requests/req_copy', { method,
      headers: { ...(authenticated ? { authorization: 'Bearer ' + adminKey } : {}), origin, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const handler = method === 'GET' ? onRequestGet : onRequestPost;
    const response = await handler({ request, env, params: { id: 'req_copy' }, waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as EventContext<Env, string, Record<string, unknown>>);
    await Promise.all(pending.splice(0));
    return { status: response.status, body: await response.json() as any };
  };
  const slots = [3, 4].map(days => new Date(Date.now() + days * 86400000).toISOString());
  const sendBody = { action: 'send_booking_proposal', tier: 'standard', basePriceCents: 19900, travelCents: 2500,
    customerNote: 'Saved customer message <script>not executable</script>', slots, proposalKey: 'synthetic_owner_copy_key' };
  return { sql, db, env, calls, accepted, failures, jobs, sendBody, invoke, detail: () => invoke('GET'), send: () => invoke('POST', sendBody) };
}

afterEach(() => vi.unstubAllGlobals());

describe('booking proposal owner confirmation, real handlers with local SQLite and mocked mail', () => {
  it('sends one unchanged customer email and one owner copy with the same content and $224', async () => {
    const f = fixture();
    const sent = await f.send();
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.totalCents).toBe(22400);
    expect(sent.body.notification.emailStatus).toBe('sent');
    const messages = f.sql.prepare('SELECT * FROM messages ORDER BY created_at').all();
    expect(messages).toHaveLength(2);
    const customer = messages.find((m: any) => m.template === 'booking_proposal');
    const owner = messages.find((m: any) => m.template === 'owner_booking_proposal');
    expect(owner.subject).toBe(customer.subject);
    expect(owner.body_text).toContain('Owner copy — this booking proposal was sent to Taylor.\n\n' + customer.body_text);
    expect(customer.body_text).toContain('Total: $224.00');
    expect(customer.body_text).toContain('Mobile-service charge: $25.00');
    expect(f.accepted.size).toBe(2);
    const delivered = [...f.accepted.values()];
    const customerPayload = delivered.find(p => p.to[0] === 'buyer@example.com');
    expect(customerPayload.text).toBe(customer.body_text);
    expect(customerPayload.html).toBe(renderBrandedEmailHtml(customer.subject, customer.body_text));
    expect(JSON.stringify(customerPayload)).not.toContain('owner@example.com');
    expect(customerPayload.bcc).toBeUndefined();
    expect(customerPayload.cc).toBeUndefined();
    const ownerPayload = delivered.find(p => p.to[0] === 'owner@example.com');
    expect(ownerPayload.html).toBe(renderBrandedEmailHtml(owner.subject, owner.body_text));
    const detail = (await f.detail()).body;
    expect(detail.proposal).toMatchObject({ totalCents: 22400, notificationStatus: 'sent', ownerCopy: { status: 'sent' } });
    expect(detail.proposal.emailSnapshot).toMatchObject({ recipient: 'buyer@example.com', subject: customer.subject, status: 'sent' });
    expect(detail.proposal.emailSnapshot.sentAt).toBeTruthy();
    expect(detail.proposal.emailSnapshot.bodyText).not.toContain('?t=');
    expect(detail.proposal.emailSnapshot.bodyText).toContain('Open your secure booking page');
    expect(detail.payments).toEqual([]);
    f.sql.close();
  });

  it('deduplicates the complete proposal and never backfills a copy on an already-sent retry', async () => {
    const f = fixture(); const first = await f.send();
    expect((await f.send()).body.duplicate).toBe(true);
    expect((await f.invoke('POST', { action: 'retry_proposal_notification', proposalId: first.body.proposalId })).body.alreadySent).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.sql.prepare('SELECT count(*) AS n FROM booking_proposals').get().n).toBe(1);
    f.sql.close();
  });

  it('keeps customer send successful when owner delivery fails; owner retry never resends the customer', async () => {
    const f = fixture({ ownerFails: true });
    const sent = await f.send();
    expect(sent.status).toBe(200);
    expect(sent.body.notification.emailStatus).toBe('sent');
    const detail = (await f.detail()).body;
    expect(detail.proposal.notificationStatus).toBe('sent');
    expect(detail.proposal.ownerCopy.status).toBe('failed');
    const owner = detail.messages.find((m: any) => m.template === 'owner_booking_proposal');
    expect(owner.error).toContain('HTTP 500');
    f.failures.owner = false;
    expect((await f.invoke('POST', { action: 'retry_email', messageId: owner.id })).status).toBe(200);
    expect(f.calls.filter(p => p.to[0] === 'buyer@example.com')).toHaveLength(1);
    expect(f.accepted.size).toBe(2);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('sent');
    f.sql.close();
  });

  it.each(['retry_proposal_notification', 'retry_email'])('sends failure and retry summaries without duplicating the customer through %s', async action => {
    const f = fixture({ customerFails: true }); const sent = await f.send();
    expect(sent.status).toBe(207);
    expect(f.calls).toHaveLength(2);
    expect(f.sql.prepare("SELECT count(*) AS n FROM messages WHERE template='owner_booking_proposal'").get().n).toBe(1);
    f.failures.customer = false;
    const retried = await f.invoke('POST', { action, proposalId: sent.body.proposalId, messageId: sent.body.notification.messageId, deliveryId: sent.body.notification.delivery.id });
    expect(retried.status).toBe(200);
    expect(f.accepted.size).toBe(3);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('sent');
    f.sql.close();
  });

  it('does not treat recorded-only mail as successful customer send', async () => {
    const f = fixture({ noProvider: true });
    expect((await f.send()).body.notification.emailStatus).toBe('recorded');
    expect(f.calls).toHaveLength(0);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('recorded');
    f.sql.close();
  });

  it.each([{ failOwnerRecord: true }, { owner: '' }, { owner: 'buyer@example.com' }])('isolates a missing/invalid owner copy from customer success: %j', async options => {
    const f = fixture(options); const sent = await f.send();
    expect(sent.status).toBe(200);
    expect(sent.body.notification.emailStatus).toBe('sent');
    expect(f.calls).toHaveLength(1);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('failed');
    expect((await f.detail()).body.proposal.delivery.adminNotification.status).toBe('failed');
    f.sql.close();
  });

  it('shows the stored sent snapshot after mutable request/proposal state changes, without sending on GET', async () => {
    const f = fixture(); const sent = await f.send();
    f.sql.exec('DELETE FROM proposal_deliveries');
    const before = (await f.detail()).body.proposal.emailSnapshot;
    f.sql.exec("UPDATE customers SET email='changed@example.com',full_name='Changed Name'; UPDATE booking_proposals SET customer_message='Changed message';");
    f.sql.exec('DELETE FROM proposal_deliveries');
    f.sql.prepare("DELETE FROM messages WHERE template='owner_booking_proposal'").run(); // Simulate a pre-feature sent proposal.
    const callsBefore = f.calls.length;
    const after = (await f.detail()).body;
    expect(after.proposal.emailSnapshot).toEqual(before);
    expect(after.proposal.ownerCopy.status).toBe('not_recorded');
    expect(f.calls).toHaveLength(callsBefore);
    expect((await f.invoke('POST', { action: 'retry_proposal_notification', proposalId: sent.body.proposalId })).body.alreadySent).toBe(true);
    expect(f.calls).toHaveLength(callsBefore);
    f.sql.close();
  });

  it('keeps the stored snapshot behind admin authentication', async () => {
    const f = fixture(); await f.send();
    const response = await f.invoke('GET', undefined, false);
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('buyer@example.com');
    f.sql.close();
  });
});

describe('sent email admin view', () => {
  it('preserves text and CTA presentation while removing secure portal tokens', () => {
    const text = 'Original message\nTotal: $224.00\nChoose one:\nhttps://example.com/ppi/portal/?t=super-secret&x=1\nhttps://example.com/info';
    expect(redactProposalBookingLinks(text)).toBe('Original message\nTotal: $224.00\nChoose one:\n[Open your secure booking page — link hidden in this admin preview]\nhttps://example.com/info');
  });
  it('renders the stored subject/recipient/time/body as escaped text and labels provider acceptance accurately', () => {
    const start = source.indexOf('  function sentProposalEmailHtml(');
    const end = source.indexOf('  function proposalCard(', start);
    const render = vm.runInNewContext(source.slice(start, end) + '\nsentProposalEmailHtml', {
      esc: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), when: (s: string) => s,
    });
    const html = render({ status: 'sent', subject: 'Stored subject', recipient: 'buyer@example.com', sentAt: '2026-10-03T05:00:00Z', bodyText: '<script>bad()</script>\nTotal: $224.00\nMonday 6 PM\n[Open your secure booking page — link hidden in this admin preview]' });
    expect(html).toContain('View sent proposal email');
    expect(html).toContain('Stored subject'); expect(html).toContain('buyer@example.com'); expect(html).toContain('2026-10-03T05:00:00Z');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('Monday 6 PM'); expect(html).toContain('$224.00');
    expect(source).not.toContain('Delivered to the customer');
    expect(source).toContain('Proposal sent to customer');
    expect(source).toContain('Owner copy failed. Customer channel results are unchanged');
  });
});

describe('central proposal delivery ledger (mock providers only)', () => {
  it('accepts email and queues exactly one text with the same canonical URL and full owner summary', async () => {
    const f = fixture({ sms: true }); const sent = await f.send();
    const d = sent.body.notification.delivery;
    expect(d).toMatchObject({ state: 'complete', customerEmail: { status: 'accepted', destination: 'b***@example.com', attempted: true }, customerSms: { status: 'queued', destination: '(***) ***-0100', attempted: true }, adminNotification: { status: 'accepted' } });
    expect(sent.body.notification.deliveryConfirmed).toBe(false);
    expect(f.jobs).toHaveLength(1);
    const customer = f.calls.find(p => p.to[0] === 'buyer@example.com');
    const owner = f.calls.find(p => p.to[0] === 'owner@example.com');
    const url = customer.text.match(/https:\/\/preview.example.com\/ppi\/portal\/\?t=\S+/)[0];
    expect(f.jobs[0].body).toContain(url);
    expect(f.jobs[0].id).toBe(d.id);
    expect(owner.text).toContain(f.jobs[0].body);
    expect(owner.text.endsWith(customer.text)).toBe(true);
    for (const value of ['Taylor Buyer', 'buyer@example.com', '7025550100', '2016 Toyota Corolla', sent.body.proposalId, 'Customer email: ACCEPTED', 'Customer SMS: QUEUED', 'Email provider ID:', url]) expect(owner.text).toContain(value);
    expect(JSON.stringify(d)).not.toContain('?t=');
    expect(JSON.stringify(d)).not.toContain('buyer@example.com');
    expect(d.customerSms.providerId).toBeNull(); // Queue is not an SMS provider.
    expect(f.sql.prepare('SELECT total_cents FROM quotes').get().total_cents).toBe(22400);
    expect(f.sql.prepare('SELECT count(*) AS n FROM payments').get().n).toBe(0);
    f.sql.close();
  });

  it('keeps accepted email when text queue throws and never automatically repeats that ambiguous text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture({ sms: true, smsFails: true }); const sent = await f.send();
    expect(sent.body.notification.delivery).toMatchObject({ customerEmail: { status: 'accepted' }, customerSms: { status: 'unknown' }, adminNotification: { status: 'accepted' } });
    expect(f.calls.find(p => p.to[0] === 'owner@example.com').text).toContain('Handoff is unconfirmed');
    await f.invoke('POST', { action: 'retry_proposal_notification', proposalId: sent.body.proposalId, deliveryId: sent.body.notification.delivery.id });
    expect(f.jobs).toHaveLength(1);
    expect(f.calls.filter(p => p.to[0] === 'buyer@example.com')).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret recipient');
    log.mockRestore(); f.sql.close();
  });

  it.each([{ customerFails: true }, { emailThrows: true }])('continues text and owner channels after email failure: %j', async options => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture({ sms: true, ...options }); const sent = await f.send();
    expect(sent.status).toBe(207);
    expect(sent.body.notification.delivery).toMatchObject({ customerEmail: { status: 'failed' }, customerSms: { status: 'queued' }, adminNotification: { status: 'accepted' } });
    expect(f.jobs).toHaveLength(1);
    expect(f.calls.find(p => p.to[0] === 'owner@example.com').text).toContain('Customer email: FAILED');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private provider');
    expect(f.sql.prepare("SELECT error FROM messages WHERE template='booking_proposal'").get().error).not.toContain('payload');
    log.mockRestore(); f.sql.close();
  });

  it.each(['', 'not-an-email', 'buyer@example.com\r\nBcc: outsider@example.com'])('skips invalid email without blocking a valid text (%s)', async email => {
    const f = fixture({ sms: true, email }); const sent = await f.send();
    expect(sent.body.notification.delivery.customerEmail).toMatchObject({ status: 'failed', attempted: false });
    expect(f.jobs).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].to).toEqual(['owner@example.com']);
    f.sql.close();
  });

  it.each(['', 'invalid phone', '702'])('skips missing/invalid phone while still sending email (%s)', async phone => {
    const f = fixture({ sms: true, phone }); const sent = await f.send();
    expect(sent.body.notification.delivery).toMatchObject({ customerEmail: { status: 'accepted' }, customerSms: { status: 'skipped', attempted: false } });
    expect(f.jobs).toHaveLength(0); f.sql.close();
  });

  it('reports disabled SMS, missing queue, and missing consent/preference accurately', async () => {
    const disabled = fixture();
    expect((await disabled.send()).body.notification.delivery.customerSms.status).toBe('disabled'); disabled.sql.close();
    const unavailable = fixture({ sms: true }); delete unavailable.env.SMS_QUEUE;
    expect((await unavailable.send()).body.notification.delivery.customerSms.status).toBe('unavailable'); unavailable.sql.close();
    const unconsented = fixture({ sms: true }); unconsented.sql.exec('UPDATE customers SET transactional_consent=0');
    expect((await unconsented.send()).body.notification.delivery.customerSms.status).toBe('skipped');
    expect(unconsented.jobs).toHaveLength(0); unconsented.sql.close();
    const preference = fixture({ sms: true }); preference.sql.exec("UPDATE customers SET preferred_contact='email'");
    expect((await preference.send()).body.notification.delivery.customerSms.status).toBe('skipped');
    expect(preference.jobs).toHaveLength(0); preference.sql.close();
  });

  it('does not let missing email-provider configuration block a valid text', async () => {
    const f = fixture({ sms: true, noProvider: true }); const sent = await f.send();
    expect(sent.body.notification.delivery).toMatchObject({ customerEmail: { status: 'recorded', attempted: false }, customerSms: { status: 'queued' }, adminNotification: { status: 'recorded' } });
    expect(f.calls).toHaveLength(0); expect(f.jobs).toHaveLength(1); f.sql.close();
  });

  it('deduplicates concurrent initial sends and same-operation retries across both channels', async () => {
    const f = fixture({ sms: true, customerFails: true });
    await Promise.all([f.send(), f.send()]);
    const detail = (await f.detail()).body;
    expect(f.sql.prepare('SELECT count(*) AS n FROM booking_proposals').get().n).toBe(1);
    expect(f.jobs).toHaveLength(1);
    f.failures.customer = false;
    const body = { action: 'retry_proposal_notification', proposalId: detail.proposal.id, deliveryId: detail.proposal.delivery.id };
    const retried = await Promise.all([f.invoke('POST', body), f.invoke('POST', body)]);
    expect(retried.some(r => r.body.duplicate)).toBe(true);
    expect(f.jobs).toHaveLength(1);
    expect([...f.accepted.values()].filter(p => p.to[0] === 'buyer@example.com')).toHaveLength(1);
    expect(f.sql.prepare('SELECT count(*) AS n FROM magic_links').get().n).toBe(1);
    f.sql.close();
  });

  it('intentionally resends one saved proposal, requires confirmation, and deduplicates even different keys from the same prior operation', async () => {
    const f = fixture({ sms: true }); const sent = await f.send();
    const body = { action: 'resend_booking_proposal', proposalId: sent.body.proposalId, deliveryId: sent.body.notification.delivery.id, deliveryKey: 'explicit_resend_one', confirmResend: true };
    expect((await f.invoke('POST', { ...body, confirmResend: false })).status).toBe(409);
    const quoteBefore = f.sql.prepare('SELECT * FROM quotes').all();
    const slotsBefore = f.sql.prepare('SELECT * FROM appointment_slots').all();
    expect((await f.invoke('POST', body)).status).toBe(200);
    expect((await f.invoke('POST', body)).body.duplicate).toBe(true);
    expect((await f.invoke('POST', { ...body, deliveryKey: 'another_tab_same_parent' })).body.duplicate).toBe(true);
    expect(f.jobs).toHaveLength(2);
    expect(f.jobs[0].body).toBe(f.jobs[1].body);
    const customer = f.calls.filter(p => p.to[0] === 'buyer@example.com');
    expect(customer).toHaveLength(2); expect(customer[0].text).toBe(customer[1].text);
    expect(f.calls.filter(p => p.to[0] === 'owner@example.com')).toHaveLength(2);
    expect(f.sql.prepare('SELECT * FROM quotes').all()).toEqual(quoteBefore);
    expect(f.sql.prepare('SELECT * FROM appointment_slots').all()).toEqual(slotsBefore);
    expect(f.sql.prepare('SELECT count(*) AS n FROM booking_proposals').get().n).toBe(1);
    f.sql.close();
  });

  it('rejects recipients supplied by the client and guards auth/origin for resend', async () => {
    const f = fixture({ sms: true });
    const sent = await f.invoke('POST', { ...f.sendBody, email: 'outsider@example.com', phone: '+17025559999', to: 'outsider@example.com' });
    expect(f.calls.some(p => p.to.includes('outsider@example.com'))).toBe(false);
    expect(f.jobs[0].to).toBe('+17025550100');
    const action = { action: 'resend_booking_proposal', proposalId: sent.body.proposalId, deliveryId: sent.body.notification.delivery.id, deliveryKey: 'forbidden_resend_key', confirmResend: true };
    expect((await f.invoke('POST', action, false)).status).toBe(401);
    const response = await onRequestPost({ env: f.env, params: { id: 'req_copy' }, request: new Request(origin + '/api/admin/requests/req_copy', { method: 'POST', headers: { authorization: 'Bearer ' + adminKey, origin: 'https://outsider.example' }, body: JSON.stringify(action) }) } as unknown as EventContext<Env, string, Record<string, unknown>>);
    expect(response.status).toBe(403); expect(f.jobs).toHaveLength(1); f.sql.close();
  });

  it('rejects a stale/expired proposal resend without changing booking state or sending', async () => {
    const f = fixture({ sms: true }); const sent = await f.send();
    f.sql.exec("UPDATE quotes SET expires_at='2020-01-01T00:00:00Z'");
    const r = await f.invoke('POST', { action: 'resend_booking_proposal', proposalId: sent.body.proposalId, deliveryId: sent.body.notification.delivery.id, deliveryKey: 'expired_resend_key', confirmResend: true });
    expect(r.status).toBe(409); expect(f.calls).toHaveLength(2); expect(f.jobs).toHaveLength(1); f.sql.close();
  });

  it('requires explicit fresh-email confirmation after the provider retry window and keeps both-channel history', async () => {
    const f = fixture({ sms: true, customerFails: true }); const sent = await f.send();
    const messageId = sent.body.notification.messageId;
    f.sql.prepare("UPDATE messages SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(messageId);
    const body = { action: 'retry_email', messageId, deliveryId: sent.body.notification.delivery.id };
    expect((await f.invoke('POST', body)).body.error.requiresFreshConfirmation).toBe(true);
    f.failures.customer = false;
    const retried = await f.invoke('POST', { ...body, confirmFresh: true });
    expect(retried.status).toBe(200);
    expect(retried.body.messageId).not.toBe(messageId);
    expect(f.jobs).toHaveLength(1); // Prior queued SMS was not duplicated.
    expect(f.sql.prepare('SELECT count(*) AS n FROM proposal_deliveries').get().n).toBe(2);
    f.sql.close();
  });

  it('persists the actual refreshed email URL before first text handoff on an email retry', async () => {
    const f = fixture({ sms: true, customerFails: true }); f.env.SMS_ENABLED = 'false';
    const sent = await f.send();
    f.sql.exec("UPDATE magic_links SET revoked_at='2026-01-01'");
    f.env.SMS_ENABLED = 'true'; f.failures.customer = false;
    const retried = await f.invoke('POST', { action: 'retry_email', messageId: sent.body.notification.messageId, deliveryId: sent.body.notification.delivery.id });
    expect(retried.status).toBe(200);
    const email = f.calls.filter(p => p.to[0] === 'buyer@example.com').at(-1);
    const url = email.text.match(/https:\/\/preview.example.com\/ppi\/portal\/\?t=\S+/)[0];
    expect(f.jobs).toHaveLength(1); expect(f.jobs[0].body).toContain(url);
    f.sql.close();
  });

  it('fails closed before external delivery if the ledger cannot be written', async () => {
    const f = fixture({ sms: true });
    f.sql.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON proposal_deliveries BEGIN SELECT RAISE(ABORT,'synthetic DB failure'); END;");
    const sent = await f.send();
    expect(sent.status).toBe(503); expect(f.calls).toHaveLength(0); expect(f.jobs).toHaveLength(0);
    expect(f.sql.prepare('SELECT count(*) AS n FROM booking_proposals').get().n).toBe(1); f.sql.close();
  });

  it('keeps one queued text after a tracking-write interruption and safely retries only email', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture({ sms: true });
    f.sql.exec("CREATE TRIGGER fail_sms_result BEFORE UPDATE OF sms_status ON proposal_deliveries WHEN NEW.sms_status='queued' BEGIN SELECT RAISE(ABORT,'synthetic DB failure'); END;");
    const sent = await f.send();
    expect(sent.body.notification.delivery.state).toBe('interrupted'); expect(f.jobs).toHaveLength(1);
    f.sql.exec('DROP TRIGGER fail_sms_result');
    await f.invoke('POST', { action: 'retry_proposal_notification', proposalId: sent.body.proposalId, deliveryId: sent.body.notification.delivery.id });
    expect(f.jobs).toHaveLength(1); expect(f.calls.filter(p => p.to[0] === 'buyer@example.com')).toHaveLength(1);
    log.mockRestore(); f.sql.close();
  });

  it('applies migration 0019 additively without altering populated prior tables', () => {
    const sql = new DatabaseSync(':memory:');
    for (const name of Object.keys(migrations).sort().filter(n => !n.includes('0019_'))) sql.exec(migrations[name]);
    sql.exec("INSERT INTO customers (id,full_name,email,phone,created_at,updated_at) VALUES ('cus_old','Old Fixture','old@example.com','7025550100','2026-01-01','2026-01-01')");
    const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r: any) => r.name);
    const before = tables.map((t: string) => sql.prepare('SELECT * FROM "' + t + '"').all());
    sql.exec(Object.entries(migrations).find(([n]) => n.includes('0019_'))![1]);
    expect(tables.map((t: string) => sql.prepare('SELECT * FROM "' + t + '"').all())).toEqual(before);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(sql.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
    sql.close();
  });

  it('shows partial/unavailable results rather than a generic success and never claims queued text was sent', () => {
    const start = source.indexOf('  function proposalDeliveryText('); const end = source.indexOf('  function sentProposalEmailHtml(', start);
    const render = vm.runInNewContext(source.slice(start, end) + '\nproposalDeliveryText');
    const text = render({ state: 'complete', customerEmail: { status: 'accepted', destination: 'b***@example.com' }, customerSms: { status: 'queued', destination: '(***) ***-0100' }, adminNotification: { status: 'failed' } });
    expect(text).toContain('Email: sent (provider accepted; mailbox delivery unconfirmed)');
    expect(text).toContain('Text: queued; not confirmed sent');
    expect(text).toContain('Owner confirmation: failed');
  });
});


describe('historical proposal copy safety', () => {
  it('preserves every historical link and customer content on a fresh owner-only retry', async () => {
    const f = fixture({ ownerFails: true }); await f.send();
    const original = f.sql.prepare("SELECT * FROM messages WHERE template='owner_booking_proposal'").get();
    f.sql.prepare("UPDATE messages SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(original.id);
    f.sql.exec("UPDATE magic_links SET revoked_at='2026-01-01'");
    f.failures.owner = false;
    const r = await f.invoke('POST', { action: 'retry_email', messageId: original.id, confirmFresh: true });
    expect(r.status).toBe(200);
    expect(f.calls.filter(p => p.to[0] === 'buyer@example.com')).toHaveLength(1);
    expect(f.calls.filter(p => p.to[0] === 'owner@example.com').at(-1).text).toBe(original.body_text);
    expect((await f.detail()).body.proposal.delivery.adminNotification.status).toBe('accepted');
    f.sql.close();
  });
  it('can explicitly resend an earlier proposal without inventing legacy history or changing its quote', async () => {
    const f = fixture(); const sent = await f.send();
    f.sql.exec('DELETE FROM proposal_deliveries');
    expect((await f.detail()).body.proposal.delivery).toBeNull();
    const body = { action: 'resend_booking_proposal', proposalId: sent.body.proposalId, deliveryId: 'legacy', deliveryKey: 'explicit_legacy_resend', confirmResend: true };
    expect((await f.invoke('POST', body)).status).toBe(200);
    expect((await f.invoke('POST', body)).body.duplicate).toBe(true);
    expect(f.calls.filter(p => p.to[0] === 'buyer@example.com')).toHaveLength(2);
    expect(f.sql.prepare('SELECT count(*) AS n FROM quotes').get().n).toBe(1);
    f.sql.close();
  });
  it('refreshes the actual template CTA even when a customer note contains an earlier pasted portal URL', async () => {
    const f = fixture({ sms: true, customerFails: true }); f.env.SMS_ENABLED = 'false';
    f.sendBody.customerNote = 'An earlier pasted link: ' + origin + '/ppi/portal/?t=old_pasted_token_123456789';
    const sent = await f.send();
    const old = f.calls.find(p => p.to[0] === 'buyer@example.com').text;
    const oldUrl = canonicalBookingUrl(old, origin);
    f.sql.exec("UPDATE magic_links SET revoked_at='2026-01-01'");
    f.env.SMS_ENABLED = 'true'; f.failures.customer = false;
    expect((await f.invoke('POST', { action: 'retry_email', messageId: sent.body.notification.messageId, deliveryId: sent.body.notification.delivery.id })).status).toBe(200);
    const fresh = f.calls.filter(p => p.to[0] === 'buyer@example.com').at(-1).text;
    const url = canonicalBookingUrl(fresh, origin);
    expect(url).not.toBe(oldUrl); expect(f.jobs[0].body).toContain(url);
    expect(fresh).toContain('old_pasted_token_123456789');
    f.sql.close();
  });
});
