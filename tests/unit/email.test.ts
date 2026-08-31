import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_TEMPLATES,
  requireRecordedEmail,
  resendIdempotencyWindowOpen,
  renderBrandedEmailHtml,
  retryStoredEmail,
  sendEmail,
  type StoredEmailMessage,
} from '../../functions/lib/email.ts';
import { sha256Hex } from '../../functions/lib/util.ts';
import type { Env } from '../../functions/lib/types.ts';
import type { PpiConfig } from '../../functions/lib/config.ts';

function fakeDb(failInsert = false): { db: D1Database; calls: Array<{ sql: string; args: unknown[] }> } {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async run() {
          calls.push({ sql, args });
          if (failInsert && sql.includes('INSERT INTO messages')) throw new Error('simulated D1 outage');
          return { meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

interface RetryMessageRow extends StoredEmailMessage {
  dedupe_key: string | null;
}

function retryDb(seed: {
  oldTokenHash: string;
  oldExpiresAt: string;
  failMessageInsert?: boolean;
}): {
  db: D1Database;
  messages: Map<string, RetryMessageRow>;
  sqlRuns: string[];
} {
  const messages = new Map<string, RetryMessageRow>();
  const magic = new Map<string, {
    id: string;
    request_id: string;
    expires_at: string;
    revoked_at: string | null;
  }>([[seed.oldTokenHash, {
    id: 'ml_old',
    request_id: 'req_1',
    expires_at: seed.oldExpiresAt,
    revoked_at: null,
  }]]);
  const sqlRuns: string[] = [];

  function statement(sql: string) {
    let args: unknown[] = [];
    return {
      sql,
      get args() { return args; },
      bind(...values: unknown[]) { args = values; return this; },
      async run() {
        sqlRuns.push(sql);
        if (sql.includes('INSERT INTO magic_links')) {
          magic.set(String(args[2]), {
            id: String(args[0]),
            request_id: String(args[1]),
            expires_at: String(args[3]),
            revoked_at: null,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('INSERT INTO messages')) {
          if (seed.failMessageInsert) throw new Error('simulated outbox outage');
          const id = String(args[0]);
          const dedupeKey = args[7] == null ? null : String(args[7]);
          const existing = [...messages.values()].find((row) => row.dedupe_key === dedupeKey && dedupeKey !== null);
          if (existing) return { meta: { changes: 0 } };
          messages.set(id, {
            id,
            request_id: args[1] == null ? null : String(args[1]),
            template: String(args[2]),
            to_email: String(args[3]),
            subject: String(args[4]),
            body_text: String(args[5]),
            status: 'recorded',
            created_at: String(args[6]),
            dedupe_key: dedupeKey,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE messages SET status')) {
          const row = messages.get(String(args[3]));
          if (row) row.status = String(args[0]) as RetryMessageRow['status'];
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (sql.includes('UPDATE magic_links SET revoked_at')) {
          for (const row of magic.values()) {
            if (row.id === String(args[1])) row.revoked_at = String(args[0]);
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
      async first<T>() {
        if (sql.includes('FROM magic_links WHERE token_hash')) {
          return (magic.get(String(args[0])) ?? null) as T | null;
        }
        if (sql.includes('WHERE dedupe_key =')) {
          return ([...messages.values()].find((row) => row.dedupe_key === String(args[0])) ?? null) as T | null;
        }
        if (sql.includes('SELECT body_text FROM messages WHERE id')) {
          const row = messages.get(String(args[0]));
          return (row ? { body_text: row.body_text } : null) as T | null;
        }
        return null;
      },
    };
  }

  const db = {
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  } as unknown as D1Database;
  return { db, messages, sqlRuns };
}

afterEach(() => vi.unstubAllGlobals());

describe('transactional email', () => {
  it('treats the provider 24-hour idempotency boundary as expired', () => {
    const now = Date.parse('2026-08-29T12:00:00.000Z');
    expect(resendIdempotencyWindowOpen('2026-08-28T12:00:00.001Z', now)).toBe(true);
    expect(resendIdempotencyWindowOpen('2026-08-28T12:00:00.000Z', now)).toBe(false);
    expect(resendIdempotencyWindowOpen('not-a-date', now)).toBe(false);
  });

  it('renders branded HTML while escaping customer-controlled text', () => {
    const html = renderBrandedEmailHtml('Request <script>alert(1)</script>', 'Name: <img src=x onerror=alert(1)>\nhttps://example.com/path');
    expect(html).toContain('AutoClarity');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('href="https://example.com/path"');
  });

  it('puts rich request details in the body but keeps PII out of the subject', () => {
    const rendered = EMAIL_TEMPLATES.request_received({
      ref: 'PPI-TEST-1234',
      portalUrl: 'https://example.com/ppi/portal/?t=safe',
      supportEmail: 'support@example.com',
      extra: {
        name: 'Taylor Tester',
        vehicle: '2022 Toyota Camry SE',
        vin: '4T1B11HK5KU212399',
        location: 'Las Vegas, NV, 89109',
        timing: 'Saturday morning',
      },
    });
    expect(rendered.subject).toBe('AutoClarity — inspection request received (PPI-TEST-1234)');
    expect(rendered.subject).not.toContain('Taylor');
    expect(rendered.subject).not.toContain('4T1B');
    expect(rendered.text).toContain('Taylor Tester');
    expect(rendered.text).toContain('2022 Toyota Camry SE');
    expect(rendered.text).toContain('Reply to this email');
  });

  it('uses accurate no-link copy and distinguishes paid-but-unbooked receipts', () => {
    const intake = EMAIL_TEMPLATES.request_received({
      ref: 'PPI-TEST-1',
      supportEmail: 'support@example.com',
      extra: { name: 'Taylor' },
    });
    expect(intake.text).toContain('could not be included');
    expect(intake.text).toContain('support@example.com');
    expect(intake.text).not.toContain('will email you when');

    const lapsed = EMAIL_TEMPLATES.payment_slot_lapsed({
      ref: 'PPI-TEST-1',
      portalUrl: 'https://example.com/ppi/portal/?t=secure',
      supportEmail: 'support@example.com',
      extra: { amount: '$199.00' },
    });
    expect(lapsed.text).toContain('appointment time was not booked');
    expect(lapsed.text).toContain('will not be asked to pay again');
    expect(lapsed.text).toContain('?t=secure');

    const refund = EMAIL_TEMPLATES.refund_issued({
      ref: 'PPI-TEST-1',
      supportEmail: 'support@example.com',
      extra: { amount: '$199.00' },
    });
    expect(refund.text).toContain('bank or payment provider controls when');
    expect(refund.text).not.toMatch(/\d+\s*[–-]\s*\d+ business days/i);
  });

  it('throws when a webhook-required outbox row was not recorded', () => {
    expect(() => requireRecordedEmail({ id: null, status: 'failed' }, 'appointment_confirmed')).toThrow(/not recorded/);
    expect(requireRecordedEmail({ id: 'msg_1', status: 'recorded' }, 'appointment_confirmed').id).toBe('msg_1');
  });

  it('sends HTML + text with the message id as Resend idempotency key', async () => {
    const { db, calls } = fakeDb();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(headers.get('idempotency-key')).toMatch(/^msg_/);
      expect(headers.get('user-agent')).toBe('AutoClarity-PPI/1.0');
      expect(payload['html']).toContain('AutoClarity');
      expect(payload['reply_to']).toBe('support@example.com');
      return new Response(JSON.stringify({ id: 'resend_123' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { RESEND_API_KEY: 'not-a-real-secret', EMAIL_FROM: 'AutoClarity <notify@example.com>' } as unknown as Env;

    const result = await sendEmail(env, db, 'req_1', 'request_received', {
      to: 'customer@example.com',
      subject: 'AutoClarity — request received (PPI-1)',
      text: 'Reference: PPI-1',
      replyTo: 'support@example.com',
    });

    expect(result.status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.sql.includes('INSERT INTO messages'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('UPDATE messages SET status'))).toBe(true);
  });

  it('contains a D1 recording failure instead of throwing', async () => {
    const { db, calls } = fakeDb(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendEmail({} as Env, db, 'req_stored', 'request_received', {
      to: 'customer@example.com',
      subject: 'Subject',
      text: 'Body',
    });
    expect(result).toMatchObject({ id: null, status: 'failed', failure: 'outbox_record_failed' });
    expect(result.issueKey).toMatch(/^outbox:msg_/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes('INSERT INTO admin_audit_log'))).toBe(true);
  });

  it('retries the same stored message with the same provider idempotency key', async () => {
    const { db } = fakeDb();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('msg_original');
      return new Response(JSON.stringify({ id: 'resend_same' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const message: StoredEmailMessage = {
      id: 'msg_original',
      request_id: 'req_1',
      template: 'request_received',
      to_email: 'customer@example.com',
      subject: 'Subject',
      body_text: 'Body',
      status: 'failed',
      created_at: new Date().toISOString(),
    };
    const result = await retryStoredEmail(
      { RESEND_API_KEY: 'not-a-real-secret', EMAIL_FROM: 'notify@example.com' } as Env,
      db,
      message,
      'support@example.com',
    );
    expect(result).toEqual({ id: 'msg_original', status: 'sent' });
  });

  it('replaces an expired portal link in a deduplicated successor before retrying', async () => {
    const oldToken = 'expired_portal_token_1234567890';
    const { db, messages, sqlRuns } = retryDb({
      oldTokenHash: await sha256Hex(oldToken),
      oldExpiresAt: '2020-01-01T00:00:00.000Z',
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { text: string };
      expect(payload.text).toContain('https://example.com/ppi/portal/?t=');
      expect(payload.text).not.toContain(oldToken);
      return new Response(JSON.stringify({ id: 'resend_refreshed' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const message: StoredEmailMessage = {
      id: 'msg_old',
      request_id: 'req_1',
      template: 'quote_ready',
      to_email: 'customer@example.com',
      subject: 'Quote ready',
      body_text: `Review securely:\nhttps://example.com/ppi/portal/?t=${oldToken}`,
      status: 'failed',
      created_at: new Date().toISOString(),
    };
    const portalContext = {
      publicBaseUrl: 'https://example.com',
      config: { magicLinks: { ttlHours: 336 } } as PpiConfig,
    };

    const first = await retryStoredEmail(
      { RESEND_API_KEY: 'not-a-real-secret', EMAIL_FROM: 'notify@example.com' } as Env,
      db,
      message,
      'support@example.com',
      portalContext,
    );
    const second = await retryStoredEmail(
      { RESEND_API_KEY: 'not-a-real-secret', EMAIL_FROM: 'notify@example.com' } as Env,
      db,
      message,
      'support@example.com',
      portalContext,
    );

    expect(first.status).toBe('sent');
    expect(first.id).not.toBe(message.id);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    const successor = [...messages.values()].find((row) => row.dedupe_key === 'email_link_refresh:msg_old');
    expect(successor?.body_text).not.toContain(oldToken);
    expect(successor?.status).toBe('sent');
    expect(sqlRuns.some((sql) => sql.includes('WHERE request_id = ? AND revoked_at IS NULL'))).toBe(false);
  });

  it('fails closed when a stale-link replacement cannot enter the outbox', async () => {
    const oldToken = 'revoked_portal_token_1234567890';
    const { db } = retryDb({
      oldTokenHash: await sha256Hex(oldToken),
      oldExpiresAt: '2020-01-01T00:00:00.000Z',
      failMessageInsert: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await retryStoredEmail(
      { RESEND_API_KEY: 'not-a-real-secret', EMAIL_FROM: 'notify@example.com' } as Env,
      db,
      {
        id: 'msg_old',
        request_id: 'req_1',
        template: 'quote_ready',
        to_email: 'customer@example.com',
        subject: 'Quote ready',
        body_text: `Review securely:\nhttps://example.com/ppi/portal/?t=${oldToken}`,
        status: 'failed',
        created_at: new Date().toISOString(),
      },
      'support@example.com',
      {
        publicBaseUrl: 'https://example.com',
        config: { magicLinks: { ttlHours: 336 } } as PpiConfig,
      },
    );

    expect(result).toEqual({
      id: null,
      status: 'failed',
      failure: 'outbox_record_failed',
      issueKey: 'outbox:email_link_refresh:msg_old',
      issueDedupeKey: 'email_link_refresh:msg_old',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation after 24 hours and then creates one fresh outbox message', async () => {
    const token = 'active_portal_token_123456789012';
    const { db, messages } = retryDb({
      oldTokenHash: await sha256Hex(token),
      oldExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('idempotency-key')).not.toBe('msg_old_window');
      return new Response(JSON.stringify({ id: 'resend_manual_fresh' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const message: StoredEmailMessage = {
      id: 'msg_old_window',
      request_id: 'req_1',
      template: 'quote_ready',
      to_email: 'customer@example.com',
      subject: 'Quote ready',
      body_text: `Review securely:\nhttps://example.com/ppi/portal/?t=${token}`,
      status: 'failed',
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    const portalContext = {
      publicBaseUrl: 'https://example.com',
      config: { magicLinks: { ttlHours: 336 } } as PpiConfig,
    };
    const env = { RESEND_API_KEY: 'not-a-real-secret', EMAIL_FROM: 'notify@example.com' } as Env;

    const blocked = await retryStoredEmail(env, db, message, 'support@example.com', portalContext);
    expect(blocked).toEqual({ id: message.id, status: 'failed', failure: 'idempotency_window_expired' });
    expect(fetchMock).not.toHaveBeenCalled();

    const confirmedContext = { ...portalContext, confirmFreshAfterWindow: true };
    const first = await retryStoredEmail(env, db, message, 'support@example.com', confirmedContext);
    const doubleClick = await retryStoredEmail(env, db, message, 'support@example.com', confirmedContext);
    expect(first.status).toBe('sent');
    expect(first.id).not.toBe(message.id);
    expect(doubleClick).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect([...messages.values()].filter((row) => row.dedupe_key === `email_manual_fresh:${message.id}`)).toHaveLength(1);
  });
});
