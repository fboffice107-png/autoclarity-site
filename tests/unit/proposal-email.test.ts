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

function fixture(options: { ownerFails?: boolean; customerFails?: boolean; noProvider?: boolean; owner?: string; failOwnerRecord?: boolean } = {}) {
  const sql = new DatabaseSync(':memory:');
  for (const name of Object.keys(migrations).sort()) sql.exec(migrations[name]);
  sql.exec(`INSERT INTO customers (id,full_name,email,phone,created_at,updated_at) VALUES ('cus_copy','Taylor Buyer','buyer@example.com','7025550100','2026-01-01','2026-01-01');
    INSERT INTO vehicles (id,year,make,model,mod_status,created_at,updated_at) VALUES ('veh_copy',2016,'Toyota','Corolla','stock','2026-01-01','2026-01-01');
    INSERT INTO ppi_requests (id,ref,customer_id,vehicle_id,status,seller_type,inspection_location_type,perm_inspection,loc_city,loc_zip,created_at,updated_at)
    VALUES ('req_copy','PPI-COPY','cus_copy','veh_copy','submitted','private','private_residence',1,'Las Vegas','89147','2026-01-01','2026-01-01');`);
  if (options.failOwnerRecord) sql.exec(`CREATE TRIGGER fail_owner_copy BEFORE INSERT ON messages WHEN NEW.template = 'owner_booking_proposal' BEGIN SELECT RAISE(ABORT,'synthetic owner outbox failure'); END;`);
  const db = asD1(sql);
  const env = { DB: db, PPI_ENV: 'preview', PPI_MODE: 'live', BOOKING_ENABLED: 'true', ADMIN_DEV_KEY: adminKey,
    PUBLIC_BASE_URL: origin, RESEND_API_KEY: options.noProvider ? '' : 'synthetic-resend-key', EMAIL_FROM: 'AutoClarity <notify@example.com>',
    ADMIN_NOTIFY_EMAIL: options.owner ?? 'owner@example.com',
  } as Env;
  const accepted = new Map<string, any>();
  const calls: any[] = [];
  const failures = { owner: !!options.ownerFails, customer: !!options.customerFails };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.resend.com/emails'); // Every network call stays mocked.
    const body = JSON.parse(String(init.body));
    const key = new Headers(init.headers).get('Idempotency-Key')!;
    calls.push(body);
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
  return { sql, db, env, calls, accepted, failures, sendBody, invoke, detail: () => invoke('GET'), send: () => invoke('POST', sendBody) };
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
    expect(owner.body_text).toBe('Owner copy — this booking proposal was sent to Taylor.\n\n' + customer.body_text);
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
    expect(owner.error).toContain('synthetic provider failure');
    f.failures.owner = false;
    expect((await f.invoke('POST', { action: 'retry_email', messageId: owner.id })).status).toBe(200);
    expect(f.calls.filter(p => p.to[0] === 'buyer@example.com')).toHaveLength(1);
    expect(f.accepted.size).toBe(2);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('sent');
    f.sql.close();
  });

  it.each(['retry_proposal_notification', 'retry_email'])('sends the owner copy only after a failed customer send succeeds through %s', async action => {
    const f = fixture({ customerFails: true }); const sent = await f.send();
    expect(sent.status).toBe(207);
    expect(f.calls).toHaveLength(1);
    expect(f.sql.prepare("SELECT count(*) AS n FROM messages WHERE template='owner_booking_proposal'").get().n).toBe(0);
    f.failures.customer = false;
    const retried = await f.invoke('POST', { action, proposalId: sent.body.proposalId, messageId: sent.body.notification.messageId });
    expect(retried.status).toBe(200);
    expect(f.accepted.size).toBe(2);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('sent');
    f.sql.close();
  });

  it('does not treat recorded-only mail as successful customer send', async () => {
    const f = fixture({ noProvider: true });
    expect((await f.send()).body.notification.emailStatus).toBe('recorded');
    expect(f.calls).toHaveLength(0);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('not_recorded');
    f.sql.close();
  });

  it.each([{ failOwnerRecord: true }, { owner: '' }, { owner: 'buyer@example.com' }])('isolates a missing/invalid owner copy from customer success: %j', async options => {
    const f = fixture(options); const sent = await f.send();
    expect(sent.status).toBe(200);
    expect(sent.body.notification.emailStatus).toBe('sent');
    expect(f.calls).toHaveLength(1);
    expect((await f.detail()).body.proposal.ownerCopy.status).toBe('failed');
    expect(f.sql.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='notification_record_failed'").get().n).toBe(1);
    f.sql.close();
  });

  it('shows the stored sent snapshot after mutable request/proposal state changes, without sending on GET', async () => {
    const f = fixture(); const sent = await f.send();
    const before = (await f.detail()).body.proposal.emailSnapshot;
    f.sql.exec("UPDATE customers SET email='changed@example.com',full_name='Changed Name'; UPDATE booking_proposals SET customer_message='Changed message';");
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
    const html = render({ subject: 'Stored subject', recipient: 'buyer@example.com', sentAt: '2026-10-03T05:00:00Z', bodyText: '<script>bad()</script>\nTotal: $224.00\nMonday 6 PM\n[Open your secure booking page — link hidden in this admin preview]' });
    expect(html).toContain('View sent proposal email');
    expect(html).toContain('Stored subject'); expect(html).toContain('buyer@example.com'); expect(html).toContain('2026-10-03T05:00:00Z');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('Monday 6 PM'); expect(html).toContain('$224.00');
    expect(source).not.toContain('Delivered to the customer');
    expect(source).toContain('Proposal sent to customer');
    expect(source).toContain('Owner copy failed. The customer proposal remains sent');
  });
});
