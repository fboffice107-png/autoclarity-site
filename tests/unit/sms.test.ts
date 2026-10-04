import { describe, expect, it, vi } from 'vitest';
import { queueTransactionalSms } from '../../functions/lib/sms.ts';
import type { Env } from '../../functions/lib/types.ts';

const input = {
  requestId: 'req_123',
  template: 'request_received' as const,
  to: '7025550111',
  body: 'AutoClarity received your request.',
  transactionalConsent: true,
  requestedByCustomer: true,
};

describe('transactional SMS queue seam', () => {
  it('gates on explicit transactional consent before configuration', async () => {
    const send = vi.fn();
    const env = { SMS_ENABLED: 'true', SMS_QUEUE: { send } } as unknown as Env;
    expect(await queueTransactionalSms(env, { ...input, transactionalConsent: false })).toBe('not_consented');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not queue when the customer did not request text contact', async () => {
    const send = vi.fn();
    const env = { SMS_ENABLED: 'true', SMS_QUEUE: { send } } as unknown as Env;
    expect(await queueTransactionalSms(env, { ...input, requestedByCustomer: false })).toBe('not_requested');
    expect(send).not.toHaveBeenCalled();
  });

  it('is disabled by default and reports a missing binding explicitly', async () => {
    expect(await queueTransactionalSms({} as Env, input)).toBe('disabled');
    expect(await queueTransactionalSms({ SMS_ENABLED: 'true' } as Env, input)).toBe('unavailable');
  });

  it('queues a provider-neutral job only when enabled, consented and requested', async () => {
    const send = vi.fn(async () => undefined);
    const env = { SMS_ENABLED: 'true', SMS_QUEUE: { send } } as unknown as Env;
    expect(await queueTransactionalSms(env, input)).toBe('queued');
    expect(send).toHaveBeenCalledOnce();
    const job = send.mock.calls.at(0)?.at(0) as unknown as Record<string, unknown>;
    expect(job).toMatchObject({
      version: 1,
      requestId: 'req_123',
      template: 'request_received',
      to: '7025550111',
    });
    expect(String(job['body'])).toContain('AutoClarity');
    expect(String(job['body'])).toContain('Reply STOP to opt out');
  });
});

describe('bounded SMS queue handoff', () => {
  it('reports a timeout without treating it as sent or enqueueing a duplicate', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const send = vi.fn((_job: unknown) => new Promise<void>(() => {}));
      const pending = queueTransactionalSms({ SMS_ENABLED: 'true', SMS_QUEUE: { send } } as unknown as Env, { ...input, jobId: 'stable_operation_id' });
      await vi.advanceTimersByTimeAsync(10001);
      expect(await pending).toBe('failed');
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toMatchObject({ id: 'stable_operation_id' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); log.mockRestore(); }
  });
});
