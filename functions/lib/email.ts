// Provider-neutral transactional email. Every message is recorded in the
// `messages` table first; if RESEND_API_KEY is configured the Resend adapter
// sends it and updates status. Email failure never breaks the booking flow.
// Subjects carry the request ref only — no names, VINs or addresses.

import type { Env } from './types.ts';
import { newId, nowIso } from './util.ts';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  /** Idempotency key: the same dedupe_key can only ever be recorded/sent once. */
  dedupeKey?: string;
}

export type EmailStatus = 'recorded' | 'sent' | 'failed' | 'duplicate';

export async function sendEmail(
  env: Env,
  db: D1Database,
  requestId: string | null,
  template: string,
  msg: OutboundEmail,
): Promise<{ id: string; status: EmailStatus }> {
  const id = newId('msg');
  try {
    await db
      .prepare(
        `INSERT INTO messages (id, request_id, direction, channel, template, to_email, subject, body_text, status, dedupe_key, created_at)
         VALUES (?, ?, 'outbound', 'email', ?, ?, ?, ?, 'recorded', ?, ?)`,
      )
      .bind(id, requestId, template, msg.to, msg.subject, msg.text, msg.dedupeKey ?? null, nowIso())
      .run();
  } catch (e) {
    // Unique dedupe_key violation → this event was already recorded/sent.
    if (msg.dedupeKey && /UNIQUE|constraint/i.test(String(e))) return { id, status: 'duplicate' };
    throw e;
  }

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return { id, status: 'recorded' }; // no provider configured — recorded only
  }

  // Test-only endpoint override (mock provider in the integration suite);
  // production always talks to the real Resend API.
  const apiBase =
    env.PPI_ENV !== 'production' && env.RESEND_API_BASE ? env.RESEND_API_BASE : 'https://api.resend.com';

  try {
    const res = await fetch(`${apiBase}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      await db.prepare(`UPDATE messages SET status = 'sent', provider_id = ? WHERE id = ?`).bind(body.id ?? null, id).run();
      return { id, status: 'sent' };
    }
    const errText = (await res.text()).slice(0, 500);
    await db.prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`).bind(`http ${res.status}: ${errText}`, id).run();
    return { id, status: 'failed' };
  } catch (e) {
    await db.prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`).bind(String(e).slice(0, 500), id).run();
    return { id, status: 'failed' };
  }
}

// ------------------------------------------------------------------ templates

interface TemplateCtx {
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
    'https://getautoclarity.com/las-vegas-pre-purchase-inspection',
  ].join('\n');
}

export const EMAIL_TEMPLATES = {
  request_received: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — inspection request received (${ctx.ref})`,
    text: [
      'Your pre-purchase inspection request has been received.',
      '',
      `Reference: ${ctx.ref}`,
      ctx.extra?.['vehicle'] ? `Vehicle: ${ctx.extra['vehicle']}` : '',
      '',
      'AutoClarity will review the vehicle, location and requested timing.',
      'You will normally receive a response the same day and no later than 24 hours.',
      '',
      ctx.portalUrl ? `Track your request securely here:\n${ctx.portalUrl}` : '',
      footer(ctx),
    ].join('\n'),
  }),
  needs_info: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — a quick question about your request (${ctx.ref})`,
    text: [
      'We need a little more information before your inspection request can move forward.',
      '',
      ctx.extra?.['note'] ?? '',
      '',
      ctx.portalUrl ? `Reply from your secure request page:\n${ctx.portalUrl}` : '',
      footer(ctx),
    ].join('\n'),
  }),
  seller_access: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — seller access needed (${ctx.ref})`,
    text: [
      'Your inspection request is on hold until the seller confirms access to the vehicle.',
      '',
      ctx.extra?.['note'] ?? '',
      '',
      ctx.portalUrl ? `Details and status:\n${ctx.portalUrl}` : '',
      footer(ctx),
    ].join('\n'),
  }),
  quote_ready: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — your inspection quote is ready (${ctx.ref})`,
    text: [
      'Your exact price is ready to review.',
      '',
      ctx.extra?.['summary'] ?? '',
      '',
      `Review your quote and pick a time securely here:`,
      ctx.portalUrl ?? '',
      '',
      `This quote expires ${ctx.extra?.['expires'] ?? 'as shown on your quote page'}.`,
      footer(ctx),
    ].join('\n'),
  }),
  slots_offered: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — appointment times available (${ctx.ref})`,
    text: [
      'Appointment windows are ready for you to choose from.',
      '',
      ctx.extra?.['slots'] ?? '',
      '',
      `Choose your time here:`,
      ctx.portalUrl ?? '',
      footer(ctx),
    ].join('\n'),
  }),
  hold_created: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — your time is being held (${ctx.ref})`,
    text: [
      `Your selected time is temporarily held: ${ctx.extra?.['slot'] ?? ''}`,
      '',
      'Complete the agreement and payment to confirm the appointment.',
      `The hold releases automatically after ${ctx.extra?.['holdMinutes'] ?? '60'} minutes.`,
      '',
      ctx.portalUrl ?? '',
      footer(ctx),
    ].join('\n'),
  }),
  payment_received: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — payment received (${ctx.ref})`,
    text: [
      `Payment received: ${ctx.extra?.['amount'] ?? ''}`,
      '',
      'Your appointment confirmation follows in a separate message.',
      footer(ctx),
    ].join('\n'),
  }),
  appointment_confirmed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — appointment confirmed (${ctx.ref})`,
    text: [
      'Your pre-purchase inspection appointment is confirmed.',
      '',
      `When: ${ctx.extra?.['slot'] ?? ''}`,
      '',
      'An "Add to Calendar" link is available on your request page:',
      ctx.portalUrl ?? '',
      footer(ctx),
    ].join('\n'),
  }),
  reschedule_confirmed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — appointment updated (${ctx.ref})`,
    text: [
      'Your appointment has been rescheduled.',
      '',
      `New time: ${ctx.extra?.['slot'] ?? ''}`,
      '',
      ctx.portalUrl ?? '',
      footer(ctx),
    ].join('\n'),
  }),
  cancellation_confirmed: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — cancellation confirmed (${ctx.ref})`,
    text: [
      'Your inspection has been cancelled.',
      '',
      ctx.extra?.['note'] ?? '',
      '',
      ctx.portalUrl ?? '',
      footer(ctx),
    ].join('\n'),
  }),
  refund_issued: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — refund issued (${ctx.ref})`,
    text: [
      `A refund has been issued: ${ctx.extra?.['amount'] ?? ''}`,
      '',
      'Refunds typically appear within 5–10 business days depending on your bank.',
      footer(ctx),
    ].join('\n'),
  }),
  report_ready: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — your inspection report is ready (${ctx.ref})`,
    text: [
      'Your written inspection report and recommendation are ready.',
      '',
      'View it securely (and download the PDF) here:',
      ctx.portalUrl ?? '',
      footer(ctx),
    ].join('\n'),
  }),
  report_amended: (ctx: TemplateCtx) => ({
    subject: `AutoClarity — your inspection report was updated (${ctx.ref})`,
    text: [
      `An updated version of your inspection report has been published (version ${ctx.extra?.['version'] ?? ''}).`,
      'It replaces the earlier version.',
      '',
      'View the updated report securely here:',
      ctx.portalUrl ?? '',
      footer(ctx),
    ].join('\n'),
  }),
  owner_notify: (ctx: TemplateCtx) => ({
    subject: `PPI ${ctx.extra?.['kind'] ?? 'update'} — ${ctx.ref}`,
    text: [
      `Event: ${ctx.extra?.['kind'] ?? 'update'}`,
      `Request: ${ctx.ref}`,
      ctx.extra?.['detail'] ?? '',
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
): Promise<{ id: string; status: EmailStatus }> {
  const { subject, text } = EMAIL_TEMPLATES[template](ctx);
  return sendEmail(env, db, requestId, template, { to, subject, text, replyTo, dedupeKey });
}
