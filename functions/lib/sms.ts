// Provider-neutral transactional SMS seam. This module only places a
// consented job on an optional Cloudflare Queue. It does not integrate with or
// configure a paid SMS provider, and is disabled by default.

import type { Env } from './types.ts';
import { newId, nowIso } from './util.ts';

export type TransactionalSmsTemplate = 'request_received' | 'appointment_confirmed' | 'report_ready';

export interface TransactionalSmsJob {
  version: 1;
  id: string;
  requestId: string;
  template: TransactionalSmsTemplate;
  to: string;
  body: string;
  queuedAt: string;
}

export type SmsQueueStatus = 'disabled' | 'not_consented' | 'not_requested' | 'unavailable' | 'queued' | 'failed';

export interface TransactionalSmsInput {
  requestId: string;
  template: TransactionalSmsTemplate;
  to: string;
  body: string;
  transactionalConsent: boolean;
  requestedByCustomer: boolean;
}

/** Consent and preference checks always run before the feature/config checks. */
export async function queueTransactionalSms(env: Env, input: TransactionalSmsInput): Promise<SmsQueueStatus> {
  if (!input.transactionalConsent) return 'not_consented';
  if (!input.requestedByCustomer) return 'not_requested';
  if (env.SMS_ENABLED !== 'true') return 'disabled';
  if (!env.SMS_QUEUE) return 'unavailable';

  const compliance = 'Reply STOP to opt out; HELP for help. Msg/data rates may apply.';
  const branded = /AutoClarity/i.test(input.body) ? input.body : `AutoClarity: ${input.body}`;
  const room = Math.max(0, 480 - compliance.length - 1);
  const job: TransactionalSmsJob = {
    version: 1,
    id: newId('sms'),
    requestId: input.requestId,
    template: input.template,
    to: input.to,
    body: `${branded.slice(0, room).trim()} ${compliance}`.trim(),
    queuedAt: nowIso(),
  };
  try {
    await env.SMS_QUEUE.send(job);
    return 'queued';
  } catch (e) {
    console.error('sms_queue_failed', input.requestId, input.template, String(e).slice(0, 240));
    return 'failed';
  }
}
