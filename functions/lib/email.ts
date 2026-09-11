// Provider-neutral transactional email. Every message is recorded in D1
// before delivery. Resend receives the stable message id as its idempotency
// key, so an admin retry is safe even when the first network response was lost.

import type { Env } from './types.ts';
import type { PpiConfig } from './config.ts';
import { inspectMagicToken, issueMagicLink, portalUrl, revokeMagicLinkById } from './magic.ts';
import { persistNotificationIssue, resolveStoredNotificationIssue } from './notification-issues.ts';
import { newId, nowIso } from './util.ts';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  dedupeKey?: string;
}

export type EmailStatus = 'recorded' | 'sent' | 'failed';
export type EmailFailure =
  | 'outbox_record_failed'
  | 'provider_failed'
  | 'invalid_stored_message'
  | 'link_refresh_failed'
  | 'idempotency_window_expired'
  | 'template_failed';

export interface EmailResult {
  id: string | null;
  status: EmailStatus;
  failure?: EmailFailure;
  /** Internal key for enriching/deduplicating a durable recording-failure audit. */
  issueKey?: string;
  issueDedupeKey?: string;
}

/** Webhook state is not complete until its required notification is in D1. */
export function requireRecordedEmail(result: EmailResult, label: string): EmailResult {
  if (!result.id) throw new Error(`Required email outbox row was not recorded (${label}).`);
  return result;
}

interface RecordedEmail extends OutboundEmail {
  id: string;
  currentStatus: EmailStatus;
  createdAt: string;
}

interface RecordEmailResult {
  message: RecordedEmail | null;
  issueKey?: string;
  issueDedupeKey?: string;
}

export interface StoredEmailMessage {
  id: string;
  request_id: string | null;
  template: string | null;
  to_email: string | null;
  subject: string | null;
  body_text: string | null;
  status: EmailStatus;
  created_at: string;
  dedupe_key?: string | null;
}

export interface RetryPortalContext {
  publicBaseUrl: string;
  config: PpiConfig;
  confirmFreshAfterWindow?: boolean;
}

const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Resend retains idempotency keys for 24 hours; the boundary is exclusive. */
export function resendIdempotencyWindowOpen(createdAt: string, now = Date.now()): boolean {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age >= 0 && age < RESEND_IDEMPOTENCY_WINDOW_MS;
}

type WaitUntil = (promise: Promise<unknown>) => void;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeLinkedLine(line: string): string {
  const parts = line.split(/(https?:\/\/[^\s]+)/g);
  return parts
    .map((part) => {
      if (!/^https?:\/\//i.test(part)) return escapeHtml(part);
      try {
        const url = new URL(part);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return escapeHtml(part);
        const escaped = escapeHtml(url.toString());
        return `<a href="${escaped}" style="color:#176b57;text-decoration:underline;word-break:break-all;">${escaped}</a>`;
      } catch {
        return escapeHtml(part);
      }
    })
    .join('');
}

function validReplyTo(value: string | undefined): value is string {
  return Boolean(value && value.length <= 254 && !/[\r\n]/.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

/** Deterministic, escaped HTML derived only from the stored subject/body. */
export function renderBrandedEmailHtml(subject: string, text: string): string {
  const content = text
    .split('\n')
    .map((line) =>
      line.trim()
        ? `<p style="margin:0 0 12px;color:#24332f;font-size:16px;line-height:1.55;">${safeLinkedLine(line)}</p>`
        : '<div style="height:6px;line-height:6px;">&nbsp;</div>',
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f7f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dbe7e2;border-radius:14px;overflow:hidden;">
        <tr><td style="background:#143f36;padding:22px 28px;color:#ffffff;">
          <div style="font-size:24px;font-weight:700;letter-spacing:.2px;">AutoClarity</div>
          <div style="margin-top:4px;color:#c7e8dc;font-size:13px;">Las Vegas pre-purchase inspections</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 20px;color:#143f36;font-size:22px;line-height:1.3;">${escapeHtml(subject)}</h1>
          ${content}
        </td></tr>
        <tr><td style="padding:18px 28px;background:#edf5f2;color:#50645e;font-size:12px;line-height:1.5;">
          Transactional message about an AutoClarity inspection request. Please do not forward secure request links.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function updateMessageStatus(
  db: D1Database,
  id: string,
  status: EmailStatus,
  providerId: string | null,
  error: string | null,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE messages SET status = ?, provider_id = ?, error = ? WHERE id = ?`)
      .bind(status, providerId, error, id)
      .run();
  } catch (e) {
    console.error('email_status_update_failed', id, String(e).slice(0, 240));
  }
}

async function deliverRecordedEmail(env: Env, db: D1Database, msg: RecordedEmail): Promise<EmailResult> {
  if (!resendIdempotencyWindowOpen(msg.createdAt)) {
    const error = 'Provider idempotency window expired; manual review and a fresh outbox message are required.';
    await updateMessageStatus(db, msg.id, 'failed', null, error);
    return { id: msg.id, status: 'failed', failure: 'idempotency_window_expired' };
  }
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return { id: msg.id, status: 'recorded' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
        'Idempotency-Key': msg.id,
        'User-Agent': 'AutoClarity-PPI/1.0',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: renderBrandedEmailHtml(msg.subject, msg.text),
        ...(validReplyTo(msg.replyTo) ? { reply_to: msg.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      await updateMessageStatus(db, msg.id, 'sent', body.id ?? null, null);
      return { id: msg.id, status: 'sent' };
    }
    const error = `http ${res.status}: ${(await res.text()).slice(0, 500)}`;
    await updateMessageStatus(db, msg.id, 'failed', null, error);
    return { id: msg.id, status: 'failed', failure: 'provider_failed' };
  } catch (e) {
    await updateMessageStatus(db, msg.id, 'failed', null, String(e).slice(0, 500));
    console.error(JSON.stringify({ event: 'email_delivery_failed', messageId: msg.id, error: String(e).slice(0, 240) }));
    return { id: msg.id, status: 'failed', failure: 'provider_failed' };
  }
}

/** Records and best-effort delivers an email. This function never throws. */
async function recordEmail(
  db: D1Database,
  requestId: string | null,
  template: string,
  msg: OutboundEmail,
): Promise<RecordEmailResult> {
  const id = newId('msg');
  const createdAt = nowIso();
  const issueKey = `outbox:${msg.dedupeKey ?? id}`;
  try {
    const inserted = await db
      .prepare(
        `INSERT INTO messages (id, request_id, direction, channel, template, to_email, subject, body_text, status, created_at, dedupe_key)
         SELECT ?, ?, 'outbound', 'email', ?, ?, ?, ?, 'recorded', ?, ?
         WHERE ? IS NULL OR NOT EXISTS (SELECT 1 FROM messages WHERE dedupe_key = ?)
         ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      )
      .bind(id, requestId, template, msg.to, msg.subject, msg.text, createdAt, msg.dedupeKey ?? null, msg.dedupeKey ?? null, msg.dedupeKey ?? null)
      .run();
    if (msg.dedupeKey) {
      if ((inserted.meta?.changes ?? 0) === 1) {
        return { message: { id, ...msg, currentStatus: 'recorded', createdAt } };
      }
      const existing = await db
        .prepare(
          `SELECT id, to_email, subject, body_text, status, created_at FROM messages
           WHERE dedupe_key = ? AND direction = 'outbound' AND channel = 'email'`,
        )
        .bind(msg.dedupeKey)
        .first<{ id: string; to_email: string | null; subject: string | null; body_text: string | null; status: EmailStatus; created_at: string }>();
      if (!existing?.to_email || !existing.subject || !existing.body_text || !existing.created_at) {
        console.error(JSON.stringify({ event: 'email_dedupe_lookup_failed', requestId, template }));
        await persistNotificationIssue(db, {
          actor: 'system:email',
          requestId,
          issueKey,
          kind: 'record_failed',
          sourceAction: template,
          template,
          dedupeKey: msg.dedupeKey,
          error: 'The deduplicated outbox row could not be loaded after insertion lost the race.',
        });
        return { message: null, issueKey, issueDedupeKey: msg.dedupeKey };
      }
      return {
        message: {
          id: existing.id,
          to: existing.to_email,
          subject: existing.subject,
          text: existing.body_text,
          replyTo: msg.replyTo,
          dedupeKey: msg.dedupeKey,
          currentStatus: existing.status,
          createdAt: existing.created_at,
        },
      };
    }
  } catch (e) {
    console.error(JSON.stringify({
      event: 'email_record_failed',
      requestId,
      template,
      error: String(e).slice(0, 240),
    }));
    await persistNotificationIssue(db, {
      actor: 'system:email',
      requestId,
      issueKey,
      kind: 'record_failed',
      sourceAction: template,
      template,
      dedupeKey: msg.dedupeKey,
      error: String(e),
    });
    return { message: null, issueKey, issueDedupeKey: msg.dedupeKey };
  }

  return { message: { id, ...msg, currentStatus: 'recorded', createdAt } };
}

/** Records and best-effort delivers an email. This function never throws. */
export async function sendEmail(
  env: Env,
  db: D1Database,
  requestId: string | null,
  template: string,
  msg: OutboundEmail,
): Promise<EmailResult> {
  const recordedResult = await recordEmail(db, requestId, template, msg);
  const recorded = recordedResult.message;
  if (!recorded) {
    return {
      id: null,
      status: 'failed',
      failure: 'outbox_record_failed',
      issueKey: recordedResult.issueKey,
      issueDedupeKey: recordedResult.issueDedupeKey,
    };
  }
  if (recorded.currentStatus === 'sent') return { id: recorded.id, status: 'sent' };
  return deliverRecordedEmail(env, db, recorded);
}

/**
 * Records synchronously, then lets Pages finish provider delivery after the
 * response. The immediate result deliberately says `recorded`, never `sent`.
 */
export async function queueEmail(
  env: Env,
  db: D1Database,
  requestId: string | null,
  template: string,
  msg: OutboundEmail,
  waitUntil: WaitUntil,
): Promise<EmailResult> {
  const recordedResult = await recordEmail(db, requestId, template, msg);
  const recorded = recordedResult.message;
  if (!recorded) {
    return {
      id: null,
      status: 'failed',
      failure: 'outbox_record_failed',
      issueKey: recordedResult.issueKey,
      issueDedupeKey: recordedResult.issueDedupeKey,
    };
  }
  if (recorded.currentStatus === 'sent') return { id: recorded.id, status: 'sent' };
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    waitUntil(deliverRecordedEmail(env, db, recorded).then(() => undefined));
  }
  return { id: recorded.id, status: 'recorded' };
}

interface PortalLinkInText {
  token: string;
  start: number;
  end: number;
}

function findPortalLink(text: string): PortalLinkInText | null {
  const candidates = text.matchAll(/https?:\/\/[^\s<>]+/g);
  for (const match of candidates) {
    if (match.index === undefined) continue;
    const rawUrl = match[0];
    try {
      const parsed = new URL(rawUrl);
      if (parsed.pathname.replace(/\/+$/, '') !== '/ppi/portal') continue;
      const token = parsed.searchParams.get('t') ?? '';
      return { token, start: match.index, end: match.index + rawUrl.length };
    } catch {
      continue;
    }
  }
  return null;
}

async function storedRetrySuccessor(
  db: D1Database,
  messageId: string,
  kind: 'email_link_refresh' | 'email_manual_fresh',
): Promise<StoredEmailMessage | null> {
  return db
    .prepare(
      `SELECT id, request_id, template, to_email, subject, body_text, status, created_at, dedupe_key
       FROM messages
       WHERE dedupe_key = ? AND direction = 'outbound' AND channel = 'email'`,
    )
    .bind(`${kind}:${messageId}`)
    .first<StoredEmailMessage>();
}

async function createRetrySuccessor(
  env: Env,
  db: D1Database,
  message: StoredEmailMessage,
  replyTo: string | undefined,
  portalContext: RetryPortalContext | undefined,
  kind: 'email_link_refresh' | 'email_manual_fresh',
  embeddedLink: PortalLinkInText | null,
  refreshPortalLink: boolean,
  depth: number,
): Promise<EmailResult> {
  if (!message.request_id || !message.to_email || !message.subject || !message.body_text) {
    return { id: message.id, status: 'failed', failure: 'invalid_stored_message' };
  }
  if (depth >= 8) {
    console.error(JSON.stringify({ event: 'email_retry_successor_depth_exceeded', messageId: message.id, kind }));
    return { id: message.id, status: 'failed', failure: 'link_refresh_failed' };
  }

  // A stable parent→successor key makes concurrent/repeated confirmations
  // converge on one outbox row. An expired successor can form the next link in
  // the chain only after the same explicit manual-confirmation path is used.
  const successor = await storedRetrySuccessor(db, message.id, kind);
  if (successor) {
    const result = await retryStoredEmailInternal(env, db, successor, replyTo, portalContext, depth + 1);
    if (result.status === 'sent' && result.id) {
      await resolveStoredNotificationIssue(db, message.id, result.id);
    }
    return result;
  }

  let text = message.body_text;
  let fresh: Awaited<ReturnType<typeof issueMagicLink>> | null = null;
  let freshUrl: string | null = null;
  if (refreshPortalLink) {
    if (!embeddedLink || !portalContext) {
      return { id: message.id, status: 'failed', failure: 'link_refresh_failed' };
    }
    try {
      fresh = await issueMagicLink(db, message.request_id, portalContext.config, false);
    } catch (e) {
      console.error(JSON.stringify({
        event: 'email_link_refresh_magic_failed',
        messageId: message.id,
        error: String(e).slice(0, 240),
      }));
      return { id: message.id, status: 'failed', failure: 'link_refresh_failed' };
    }
    freshUrl = portalUrl(portalContext.publicBaseUrl, fresh.token);
    text = `${message.body_text.slice(0, embeddedLink.start)}${freshUrl}${message.body_text.slice(embeddedLink.end)}`;
  }

  const result = await sendEmail(env, db, message.request_id, message.template ?? 'manual_fresh', {
    to: message.to_email,
    subject: message.subject,
    text,
    replyTo,
    dedupeKey: `${kind}:${message.id}`,
  });

  // A concurrent retry may have won the dedupe race with another fresh token.
  // Revoke only this newly-created, unreferenced token in that case.
  if (result.id && fresh && freshUrl) {
    try {
      const stored = await db
        .prepare(`SELECT body_text FROM messages WHERE id = ?`)
        .bind(result.id)
        .first<{ body_text: string | null }>();
      if (stored?.body_text && !stored.body_text.includes(freshUrl)) {
        await revokeMagicLinkById(db, fresh.id);
      }
    } catch (e) {
      console.error(JSON.stringify({
        event: 'email_link_refresh_cleanup_failed',
        messageId: message.id,
        linkId: fresh.id,
        error: String(e).slice(0, 240),
      }));
    }
  }
  if (result.status === 'sent' && result.id) {
    await resolveStoredNotificationIssue(db, message.id, result.id);
  }
  return result;
}

async function retryStoredEmailInternal(
  env: Env,
  db: D1Database,
  message: StoredEmailMessage,
  replyTo?: string,
  portalContext?: RetryPortalContext,
  depth = 0,
): Promise<EmailResult> {
  if (!message.to_email || !message.subject || !message.body_text) {
    return { id: message.id, status: 'failed', failure: 'invalid_stored_message' };
  }
  if (message.status === 'sent') return { id: message.id, status: 'sent' };

  const retryWindowOpen = resendIdempotencyWindowOpen(message.created_at);
  if (!retryWindowOpen && !portalContext?.confirmFreshAfterWindow) {
    return { id: message.id, status: 'failed', failure: 'idempotency_window_expired' };
  }

  const embeddedLink = findPortalLink(message.body_text);
  let linkNeedsRefresh = false;
  if (embeddedLink && portalContext) {
    if (!message.request_id) {
      return { id: message.id, status: 'failed', failure: 'invalid_stored_message' };
    }
    let state: Awaited<ReturnType<typeof inspectMagicToken>>;
    try {
      state = await inspectMagicToken(db, embeddedLink.token);
    } catch (e) {
      console.error(JSON.stringify({
        event: 'email_link_validation_failed',
        messageId: message.id,
        error: String(e).slice(0, 240),
      }));
      return { id: message.id, status: 'failed', failure: 'link_refresh_failed' };
    }
    linkNeedsRefresh = !state.ok || state.requestId !== message.request_id;
  } else if (embeddedLink && !portalContext) {
    // Generic callers can safely retry only inside the provider window. Admin
    // supplies portal context so linked messages receive full validation.
    if (!retryWindowOpen) return { id: message.id, status: 'failed', failure: 'link_refresh_failed' };
  }

  if (!retryWindowOpen) {
    return createRetrySuccessor(
      env,
      db,
      message,
      replyTo,
      portalContext,
      'email_manual_fresh',
      embeddedLink,
      linkNeedsRefresh,
      depth,
    );
  }

  if (linkNeedsRefresh) {
    return createRetrySuccessor(
      env,
      db,
      message,
      replyTo,
      portalContext,
      'email_link_refresh',
      embeddedLink,
      true,
      depth,
    );
  }

  return deliverRecordedEmail(env, db, {
    id: message.id,
    to: message.to_email,
    subject: message.subject,
    text: message.body_text,
    replyTo,
    currentStatus: message.status,
    createdAt: message.created_at,
  });
}

/**
 * Re-deliver an outbox row. When a stored portal link is no longer usable,
 * create a deduplicated successor message with a fresh non-rotating link.
 */
export async function retryStoredEmail(
  env: Env,
  db: D1Database,
  message: StoredEmailMessage,
  replyTo?: string,
  portalContext?: RetryPortalContext,
): Promise<EmailResult> {
  return retryStoredEmailInternal(env, db, message, replyTo, portalContext);
}

// ------------------------------------------------------------------ templates

export interface TemplateCtx {
  ref: string;
  portalUrl?: string;
  supportEmail: string;
  extra?: Record<string, string>;
}

function footer(ctx: TemplateCtx): string {
  return [
    '',
    '—',
    'AutoClarity — Las Vegas Pre-Purchase Inspections',
    `Questions? ${ctx.supportEmail}`,
    'https://getautoclarity.com/las-vegas-pre-purchase-inspection/',
  ].join('\n');
}

function optionalDetail(label: string, value: string | undefined): string {
  return value ? `${label}: ${value}` : '';
}

export const EMAIL_TEMPLATES = {
  request_received: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — inspection request received (${ctx.ref})`,
    text: [
      `Hi ${ctx.extra?.['name'] || 'there'},`,
      '',
      'Thanks for trusting AutoClarity. Your pre-purchase inspection request is safely in our system.',
      '',
      `Reference: ${ctx.ref}`,
      optionalDetail('Vehicle', ctx.extra?.['vehicle']),
      optionalDetail('VIN', ctx.extra?.['vin']),
      optionalDetail('Email', ctx.extra?.['email']),
      optionalDetail('Phone', ctx.extra?.['phone']),
      optionalDetail('Preferred contact', ctx.extra?.['preferredContact']),
      optionalDetail('Inspection location', ctx.extra?.['location']),
      optionalDetail('Seller', ctx.extra?.['seller']),
      optionalDetail('Requested timing', ctx.extra?.['timing']),
      optionalDetail('Your notes', ctx.extra?.['concerns']),
      optionalDetail('Access / restrictions', ctx.extra?.['access']),
      '',
      'AutoClarity will review the vehicle, location, access, and requested timing, then follow up by email with next steps.',
      'Reply to this email if any of the details above need to be corrected.',
      '',
      ctx.portalUrl
        ? `Track your request securely here:\n${ctx.portalUrl}`
        : `A secure request link could not be included. Contact ${ctx.supportEmail} for help accessing your stored request.`,
      footer(ctx),
    ].filter((line) => line !== '').join('\n'),
  }),
  needs_info: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — a quick question about your request (${ctx.ref})`,
    text: ['We need a little more information before your inspection request can move forward.', '', ctx.extra?.['note'] ?? '', '', ctx.portalUrl ? `Reply from your secure request page:\n${ctx.portalUrl}` : '', footer(ctx)].join('\n'),
  }),
  seller_access: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — seller access needed (${ctx.ref})`,
    text: ['Your inspection request is on hold until the seller confirms access to the vehicle.', '', ctx.extra?.['note'] ?? '', '', ctx.portalUrl ? `Details and status:\n${ctx.portalUrl}` : '', footer(ctx)].join('\n'),
  }),
  quote_ready: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — your inspection quote is ready (${ctx.ref})`,
    text: ['Your exact price is ready to review.', '', ctx.extra?.['summary'] ?? '', '', 'Review your quote and pick a time securely here:', ctx.portalUrl ?? '', '', `This quote expires ${ctx.extra?.['expires'] ?? 'as shown on your quote page'}.`, footer(ctx)].join('\n'),
  }),
  slots_offered: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — appointment times available (${ctx.ref})`,
    text: ['Appointment windows are ready for you to choose from.', '', ctx.extra?.['slots'] ?? '', '', 'Choose your time here:', ctx.portalUrl ?? '', footer(ctx)].join('\n'),
  }),
  hold_created: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — your time is being held (${ctx.ref})`,
    text: [`Your selected time is temporarily held: ${ctx.extra?.['slot'] ?? ''}`, '', 'Complete the agreement and payment to confirm the appointment.', `The hold releases automatically after ${ctx.extra?.['holdMinutes'] ?? '60'} minutes.`, '', ctx.portalUrl ?? '', footer(ctx)].join('\n'),
  }),
  payment_received: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — payment received (${ctx.ref})`,
    text: [`Payment received: ${ctx.extra?.['amount'] ?? ''}`, '', 'Your appointment confirmation follows in a separate message.', footer(ctx)].join('\n'),
  }),
  appointment_confirmed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — appointment confirmed (${ctx.ref})`,
    text: [
      'Your pre-purchase inspection appointment is confirmed.',
      '',
      `When: ${ctx.extra?.['slot'] ?? ''}`,
      '',
      ctx.portalUrl
        ? `Open your secure request page to review the booking or add it to your calendar:\n${ctx.portalUrl}`
        : `A secure request link could not be included. Contact ${ctx.supportEmail} for help accessing the booking.`,
      footer(ctx),
    ].join('\n'),
  }),
  payment_slot_lapsed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — payment received; choose another time (${ctx.ref})`,
    text: [
      `Payment received: ${ctx.extra?.['amount'] ?? ''}`,
      '',
      'Your payment is secure, but the appointment time was not booked because its temporary hold had ended.',
      'You will not be asked to pay again for this request.',
      '',
      ctx.portalUrl
        ? `Choose another available time on your secure request page:\n${ctx.portalUrl}`
        : `Contact ${ctx.supportEmail} to choose another appointment time.`,
      footer(ctx),
    ].join('\n'),
  }),
  reschedule_confirmed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — appointment updated (${ctx.ref})`,
    text: ['Your appointment has been rescheduled.', '', `New time: ${ctx.extra?.['slot'] ?? ''}`, '', ctx.portalUrl ?? '', footer(ctx)].join('\n'),
  }),
  cancellation_confirmed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — cancellation confirmed (${ctx.ref})`,
    text: ['Your inspection has been cancelled.', '', ctx.extra?.['note'] ?? '', '', ctx.portalUrl ?? '', footer(ctx)].join('\n'),
  }),
  refund_issued: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — refund issued (${ctx.ref})`,
    text: [`A refund has been issued: ${ctx.extra?.['amount'] ?? ''}`, '', 'Your bank or payment provider controls when the credit appears on your account.', footer(ctx)].join('\n'),
  }),
  refund_reconciliation_needed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — refund status update (${ctx.ref})`,
    text: [
      'Stripe reported that a previously completed refund did not remain successful.',
      '',
      `The currently confirmed refunded amount is ${ctx.extra?.['amount'] ?? '$0.00'}.`,
      'Your original appointment has not been restored or rebooked. AutoClarity is reviewing the payment record and will contact you with the next step.',
      '',
      `You do not need to submit another payment. Questions? Contact ${ctx.supportEmail}.`,
      footer(ctx),
    ].join('\n'),
  }),
  report_ready: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — your inspection results are ready (${ctx.ref})`,
    text: ['Your written inspection results and recommendation are ready.', optionalDetail('Vehicle', ctx.extra?.['vehicle']), '', 'View them securely in your existing AutoClarity customer portal:', ctx.portalUrl ?? '', '', `Questions? ${ctx.supportEmail}`, 'AutoClarity — Las Vegas Pre-Purchase Inspections'].filter(Boolean).join('\n'),
  }),
  owner_new_request: (ctx: TemplateCtx) => ({
    subject: `New PPI request — ${ctx.ref}`,
    text: [
      'A new inspection request is ready for review.',
      '',
      `Request: ${ctx.ref}`,
      optionalDetail('Customer', ctx.extra?.['name']),
      optionalDetail('Email', ctx.extra?.['email']),
      optionalDetail('Phone', ctx.extra?.['phone']),
      optionalDetail('Preferred contact', ctx.extra?.['preferredContact']),
      optionalDetail('Vehicle', ctx.extra?.['vehicle']),
      optionalDetail('VIN', ctx.extra?.['vin']),
      optionalDetail('Inspection location', ctx.extra?.['location']),
      optionalDetail('Seller', ctx.extra?.['seller']),
      optionalDetail('Requested timing', ctx.extra?.['timing']),
      optionalDetail('Customer notes', ctx.extra?.['concerns']),
      optionalDetail('Access / restrictions', ctx.extra?.['access']),
      optionalDetail('Suggested tier', ctx.extra?.['tier']),
      '',
      `Open this request directly: ${ctx.extra?.['adminUrl'] ?? ''}`,
    ].filter((line) => line !== '').join('\n'),
  }),
  owner_notify: (ctx: TemplateCtx) => ({
    subject: `PPI ${ctx.extra?.['kind'] ?? 'update'} — ${ctx.ref}`,
    text: [`Event: ${ctx.extra?.['kind'] ?? 'update'}`, `Request: ${ctx.ref}`, ctx.extra?.['detail'] ?? '', '', `Admin: ${ctx.extra?.['adminUrl'] ?? ''}`].join('\n'),
  }),
  owner_dispute_update: (ctx: TemplateCtx) => ({
    subject: `PPI payment dispute update — ${ctx.ref}`,
    text: [
      `Event: ${ctx.extra?.['kind'] ?? 'PAYMENT DISPUTE UPDATE'}`,
      `Request: ${ctx.ref}`,
      `Stripe dispute: ${ctx.extra?.['disputeId'] ?? 'unknown'}`,
      `Amount: ${ctx.extra?.['amount'] ?? 'unknown'}`,
      `Provider status: ${ctx.extra?.['status'] ?? 'unknown'}`,
      `Funds state: ${ctx.extra?.['fundsState'] ?? 'unknown'}`,
      `Local payment status: ${ctx.extra?.['paymentStatus'] ?? 'unknown'}`,
      '',
      'The request, booking, and capacity remain closed even if Stripe reports a win or reinstated funds. Review the ledger and decide any customer or scheduling follow-up manually.',
      '',
      `Admin: ${ctx.extra?.['adminUrl'] ?? ''}`,
    ].join('\n'),
  }),
} as const;

export type EmailTemplateKey = keyof typeof EMAIL_TEMPLATES;

export async function sendTemplate(
  env: Env,
  db: D1Database,
  requestId: string | null,
  template: EmailTemplateKey,
  to: string,
  ctx: TemplateCtx,
  replyTo?: string,
  dedupeKey?: string,
): Promise<EmailResult> {
  try {
    const { subject, text } = EMAIL_TEMPLATES[template](ctx);
    const effectiveReplyTo = replyTo ?? (template.startsWith('owner_') ? undefined : ctx.supportEmail);
    return await sendEmail(env, db, requestId, template, { to, subject, text, replyTo: effectiveReplyTo, dedupeKey });
  } catch (e) {
    console.error('email_template_failed', requestId ?? 'none', template, String(e).slice(0, 240));
    return { id: null, status: 'failed', failure: 'template_failed' };
  }
}

export async function queueTemplate(
  env: Env,
  db: D1Database,
  requestId: string | null,
  template: EmailTemplateKey,
  to: string,
  ctx: TemplateCtx,
  waitUntil: WaitUntil,
  replyTo?: string,
  dedupeKey?: string,
): Promise<EmailResult> {
  try {
    const { subject, text } = EMAIL_TEMPLATES[template](ctx);
    const effectiveReplyTo = replyTo ?? (template.startsWith('owner_') ? undefined : ctx.supportEmail);
    return await queueEmail(env, db, requestId, template, { to, subject, text, replyTo: effectiveReplyTo, dedupeKey }, waitUntil);
  } catch (e) {
    console.error('email_queue_failed', requestId ?? 'none', template, String(e).slice(0, 240));
    return { id: null, status: 'failed', failure: 'template_failed' };
  }
}
