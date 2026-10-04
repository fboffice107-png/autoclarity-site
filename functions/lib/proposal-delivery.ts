// One proposal communication operation. Booking, quote and payment state are
// owned by the existing endpoint; this service only records/sends notifications.
import type { Env } from './types.ts';
import type { PpiConfig } from './config.ts';
import { EMAIL_TEMPLATES, sendEmail, storeEmail, retryStoredEmail, type EmailResult, type StoredEmailMessage } from './email.ts';
import { inspectMagicToken, issueMagicLink, portalUrl } from './magic.ts';
import { recordProposalNotification, type BookingProposalRow } from './booking-proposal.ts';
import { queueTransactionalSms, renderTransactionalSms } from './sms.ts';
import { redactProposalBookingLinks } from './proposal-email.ts';
import { formatCents, newId, nowIso } from './util.ts';

interface DeliveryRow {
  id: string; request_id: string; proposal_id: string; operation_key: string; parent_id: string | null;
  kind: string; state: string; created_at: string; completed_at: string | null;
  email_message_id: string | null; email_status: string; email_reason: string | null; email_sent_at: string | null; email_attempted: number;
  sms_to: string | null; sms_body: string | null; sms_status: string; sms_reason: string | null; sms_job_id: string | null; sms_attempted: number;
  owner_message_id: string | null; owner_status: string; owner_reason: string | null;
}
interface Message extends StoredEmailMessage { provider_id: string | null }
export class ProposalDeliveryError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const validEmail = (value: string): boolean => value.length <= 254 && !/[\r\n]/.test(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export function normalizedPhone(value: string): string | null {
  const stripped = value.trim().replace(/[().\s-]/g, '');
  if (/^\d{10}$/.test(stripped)) return '+1' + stripped;
  if (/^1\d{10}$/.test(stripped)) return '+' + stripped;
  return /^\+[1-9]\d{7,14}$/.test(stripped) ? stripped : null;
}
export function maskEmail(value: string | null): string {
  if (!value || !validEmail(value)) return 'Missing or invalid email';
  const [name, domain] = value.split('@');
  return `${(name ?? "").slice(0, 1)}***@${domain}`;
}
export const maskPhone = (value: string | null): string => value ? `(***) ***-${value.replace(/\D/g, '').slice(-4)}` : 'Missing or invalid phone';
const safeProviderId = (id: string | null): string | null => id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
const emailStatus = (result: EmailResult): string => result.status === 'sent' ? 'accepted' : result.status;
const emailReason = (result: EmailResult): string | null => result.status === 'recorded' ? 'Email provider is not configured; stored only.'
  : result.status === 'failed' ? (result.failure === 'idempotency_window_expired'
    ? 'Retry window expired. Review delivery history and explicitly confirm a fresh copy.'
    : 'Email acceptance was not confirmed. Use the recorded retry action; do not create another proposal.') : null;

async function message(db: D1Database, id: string | null): Promise<Message | null> {
  return id ? db.prepare('SELECT * FROM messages WHERE id = ? AND channel = \'email\' AND direction = \'outbound\'').bind(id).first<Message>() : null;
}
export async function latestProposalDelivery(db: D1Database, proposalId: string): Promise<DeliveryRow | null> {
  return db.prepare('SELECT * FROM proposal_deliveries WHERE proposal_id = ? ORDER BY rowid DESC LIMIT 1').bind(proposalId).first<DeliveryRow>();
}
export function canonicalBookingUrl(text: string, base: string): string | null {
  // Prefer the template's own CTA (last portal URL), not a URL typed into the
  // editable customer message. Only our configured origin is acceptable.
  const urls = [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map(m => m[0]).reverse();
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      if (u.origin === new URL(base).origin && u.pathname.replace(/\/+$/, '') === '/ppi/portal' && u.searchParams.get('t')) return raw;
    } catch { /* Not a booking link. */ }
  }
  return null;
}

export async function proposalDeliveryDetails(db: D1Database, proposalId: string): Promise<Record<string, unknown> | null> {
  const row = await latestProposalDelivery(db, proposalId);
  if (!row) return null; // No backfill and no sends while opening old proposals.
  const [email, owner] = await Promise.all([message(db, row.email_message_id), message(db, row.owner_message_id)]);
  return {
    id: row.id, kind: row.kind, state: row.state, attemptedAt: row.created_at, completedAt: row.completed_at,
    customerEmail: { attempted: !!row.email_attempted, status: row.email_status, destination: maskEmail(email?.to_email ?? null),
      sentAt: row.email_sent_at, messageId: row.email_message_id, providerId: safeProviderId(email?.provider_id ?? null), reason: row.email_reason },
    customerSms: { attempted: !!row.sms_attempted, status: row.sms_status, destination: maskPhone(row.sms_to),
      jobId: row.sms_job_id, providerId: null, reason: row.sms_reason, body: redactProposalBookingLinks(row.sms_body ?? '') },
    adminNotification: { status: owner ? (owner.status === 'sent' ? 'accepted' : owner.status) : row.owner_status,
      messageId: row.owner_message_id, reason: row.owner_reason },
  };
}

function fmtSlot(startsAt: string, timezone: string): string {
  return new Date(startsAt).toLocaleString('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
function groupSlotsByDay(startsAt: string[], timezone: string): string {
  const days = new Map<string, string[]>();
  for (const iso of startsAt) {
    const when = new Date(iso);
    const day = when.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' });
    const time = when.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true });
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(time);
  }
  return [...days.entries()].map(([day, times]) => `  ${day}: ${times.join(', ')}`).join('\n');
}

export interface ProposalDeliveryInput {
  requestId: string; proposalId: string; config: PpiConfig; base: string;
  mode?: 'initial' | 'retry' | 'resend'; expectedDeliveryId?: string; operationKey?: string;
  confirmResend?: boolean; confirmFresh?: boolean;
}

export async function sendBookingProposalDelivery(env: Env, db: D1Database, input: ProposalDeliveryInput): Promise<{
  email: EmailResult; delivery: Record<string, unknown> | null; duplicate?: boolean;
}> {
  const mode = input.mode ?? 'initial';
  const proposal = await db.prepare('SELECT * FROM booking_proposals WHERE id = ? AND request_id = ?')
    .bind(input.proposalId, input.requestId).first<BookingProposalRow>();
  const customer = await db.prepare(`SELECT r.ref, r.status, c.full_name, c.email, c.phone, c.transactional_consent, c.preferred_contact,
    v.year, v.make, v.model FROM ppi_requests r JOIN customers c ON c.id = r.customer_id
    JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = ? AND r.deleted_at IS NULL`)
    .bind(input.requestId).first<{ ref: string; status: string; full_name: string; email: string; phone: string; transactional_consent: number; preferred_contact: string; year: number; make: string; model: string }>();
  if (!proposal || !customer) throw new ProposalDeliveryError('not_found', 'The proposal or request was not found.');
  const prior = await latestProposalDelivery(db, proposal.id);
  const parentId = mode === 'initial' ? null : (input.expectedDeliveryId ?? 'legacy');
  // Retrying the exact HTTP operation returns its stored result. It never
  // silently begins a second delivery operation, even with different keys.
  const operationKey = mode === 'initial' ? 'initial' : mode === 'retry' ? `retry:${input.operationKey ?? parentId}` : `resend:${input.operationKey ?? ''}`;
  if (mode === 'resend' && (!input.confirmResend || !/^[A-Za-z0-9_-]{8,100}$/.test(input.operationKey ?? '') || !input.expectedDeliveryId)) {
    throw new ProposalDeliveryError('confirmation_required', 'Explicit confirmation and the current delivery ID are required to resend.');
  }
  const existing = await db.prepare('SELECT * FROM proposal_deliveries WHERE proposal_id = ? AND (operation_key = ? OR parent_id = ?)')
    .bind(proposal.id, operationKey, parentId).first<DeliveryRow>();
  if (existing) return { email: { id: existing.email_message_id, status: existing.email_status === 'accepted' ? 'sent' : existing.email_status === 'recorded' ? 'recorded' : 'failed' }, delivery: await proposalDeliveryDetails(db, proposal.id), duplicate: true };
  if (mode !== 'initial' && (parentId !== (prior?.id ?? 'legacy') || prior?.state === 'processing')) {
    throw new ProposalDeliveryError('delivery_changed', 'Delivery is still processing or has changed. Refresh and review its status first.');
  }
  const quote = await db.prepare('SELECT status, total_cents, expires_at, travel_cents FROM quotes WHERE id = ? AND request_id = ?')
    .bind(proposal.quote_id, input.requestId).first<{ status: string; total_cents: number; expires_at: string; travel_cents: number }>();
  if (!quote || quote.status !== 'sent' || Date.parse(quote.expires_at) <= Date.now()
    || !['quote_sent', 'awaiting_time_selection'].includes(customer.status)) {
    throw new ProposalDeliveryError('stale_proposal', 'This proposal is no longer open for booking. Review the current request; nothing was sent.');
  }
  const id = newId('pd');
  const now = nowIso();
  // This durable claim is the commit point for external work. A DB failure
  // before it results in no mail/queue calls. Unique parent prevents races
  // between retry and resend, including two tabs using different keys.
  const claim = await db.prepare(`INSERT INTO proposal_deliveries (id,request_id,proposal_id,operation_key,parent_id,kind,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(id, input.requestId, proposal.id, operationKey, parentId, mode, now).run();
  if (claim.meta.changes !== 1) return { email: { id: null, status: 'recorded' }, delivery: await proposalDeliveryDetails(db, proposal.id), duplicate: true };
  let result: EmailResult = { id: null, status: 'failed', failure: 'template_failed' };
  try {
    let original = await message(db, prior?.email_message_id ?? proposal.notification_message_id);
    const firstName = customer.full_name.trim().split(/\s+/)[0] || 'there';
    let url = original?.body_text ? canonicalBookingUrl(original.body_text, input.base) : null;
    if (!original || mode === 'resend') {
      if (!url || mode === 'resend') {
        const state = url ? await inspectMagicToken(db, new URL(url).searchParams.get('t')!) : null;
        if (!state?.ok || state.requestId !== input.requestId) {
          const link = await issueMagicLink(db, input.requestId, input.config, false);
          const nextUrl = portalUrl(input.base, link.token);
          if (original?.body_text && url) original = { ...original, body_text: original.body_text.split(url).join(nextUrl) };
          url = nextUrl;
        }
      }
      let rendered: { subject: string; text: string };
      if (original?.subject && original.body_text) rendered = { subject: original.subject, text: original.body_text };
      else {
        const lines = await db.prepare('SELECT kind, label, amount_cents FROM quote_line_items WHERE quote_id = ? ORDER BY sort')
          .bind(proposal.quote_id).all<{ kind: string; label: string; amount_cents: number }>();
        const priceLines = (lines.results ?? []).map(l => `  ${l.label}: ${l.kind === 'discount' ? '−' : ''}${formatCents(Math.abs(l.amount_cents))}`);
        // Zero travel is deliberately absent from quote_line_items but remains
        // visible in the existing customer email as Included.
        if (quote.travel_cents === 0) priceLines.splice(1, 0, '  Mobile-service charge: Included');
        const slotIds = JSON.parse(proposal.slot_ids_json) as string[];
        const slots = await db.prepare(`SELECT starts_at FROM appointment_slots WHERE request_id = ? AND id IN (${slotIds.map(() => '?').join(',')}) ORDER BY starts_at`)
          .bind(input.requestId, ...slotIds).all<{ starts_at: string }>();
        rendered = EMAIL_TEMPLATES.booking_proposal({ ref: customer.ref, portalUrl: url!, supportEmail: input.config.supportEmail,
          extra: { message: proposal.customer_message ?? '', priceLines: priceLines.join('\n'), total: formatCents(quote.total_cents),
            slots: groupSlotsByDay((slots.results ?? []).map(s => s.starts_at), input.config.scheduling.timezone), expires: fmtSlot(quote.expires_at, input.config.scheduling.timezone) } });
      }
      result = await storeEmail(db, input.requestId, 'booking_proposal', {
        to: customer.email.trim(), ...rendered, dedupeKey: mode === 'initial' ? `booking_proposal:${proposal.id}` : `booking_proposal:${id}`,
      });
      original = await message(db, result.id);
    }
    if (!original?.body_text || !url) throw new Error('snapshot_unavailable');
    // Save the actual persisted canonical URL/body before using either channel.
    url = canonicalBookingUrl(original.body_text, input.base);
    if (!url) throw new Error('canonical_link_unavailable');
    await db.prepare('UPDATE proposal_deliveries SET email_message_id = ? WHERE id = ?').bind(original.id, id).run();
    let emailAttempted = false;
    let reason: string | null = null;
    if (original.status === 'sent') {
      result = { id: original.id, status: 'sent' };
    } else if (!validEmail(customer.email.trim()) || original.to_email?.toLowerCase() !== customer.email.trim().toLowerCase()) {
      result = { id: original.id, status: 'failed', failure: 'invalid_stored_message' };
      reason = !validEmail(customer.email.trim()) ? 'Customer email is missing or invalid; no email attempted.' : 'Customer email changed since the stored proposal. Review and explicitly resend to the current contact.';
      await db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ? AND status <> 'sent'").bind(reason, original.id).run();
    } else {
      emailAttempted = !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
      try {
        result = await retryStoredEmail(env, db, original, input.config.supportEmail, {
          config: input.config, publicBaseUrl: input.base, confirmFreshAfterWindow: input.confirmFresh === true,
        });
      } catch { result = { id: original.id, status: 'failed', failure: 'provider_failed' }; }
      reason = emailReason(result);
    }
    // A safe email retry may create a fresh, non-rotating link. SMS must use
    // the actual resulting outbox snapshot, never a discarded generated URL.
    original = await message(db, result.id) ?? original;
    url = canonicalBookingUrl(original.body_text ?? '', input.base)!;
    const sentAt = result.status === 'sent' ? (emailAttempted ? nowIso() : prior?.email_sent_at ?? proposal.sent_at) : null;
    await db.prepare('UPDATE proposal_deliveries SET email_message_id = ?, email_status = ?, email_reason = ?, email_attempted = ?, email_sent_at = ? WHERE id = ?')
      .bind(original.id, emailStatus(result), reason, emailAttempted ? 1 : 0, sentAt, id).run();
    await recordProposalNotification(db, proposal.id, result.status === 'sent' ? 'sent' : result.status === 'recorded' ? 'queued' : 'failed', result.id, reason);

    const phone = normalizedPhone(customer.phone ?? '');
    const smsText = `Hello ${firstName.slice(0, 40)}! Your AutoClarity pre-purchase inspection proposal is ready. Review, choose a time and pay: ${url}`;
    let smsStatus: string;
    let smsReason: string | null = null;
    let smsAttempted = false;
    let smsBody = renderTransactionalSms(smsText);
    let jobId: string | null = null;
    let smsTo = phone;
    // Queue exceptions are ambiguous: do not blindly enqueue a second copy.
    // Only an explicitly confirmed resend may repeat a handed-off/unknown SMS.
    if (mode === 'retry' && prior && ['queued', 'unknown', 'sending'].includes(prior.sms_status)) {
      smsStatus = prior.sms_status === 'sending' ? 'unknown' : prior.sms_status;
      smsReason = 'Previous text handoff preserved; no second text attempted.';
      smsBody = prior.sms_body ?? ''; jobId = prior.sms_job_id; smsTo = prior.sms_to;
    } else if (!phone) { smsStatus = 'skipped'; smsReason = 'Customer phone is missing or invalid.'; }
    else if (env.SMS_ENABLED !== 'true' || !input.config.contact.smsEnabled) { smsStatus = 'disabled'; smsReason = 'Text messaging is disabled in configuration.'; }
    else if (!env.SMS_QUEUE) { smsStatus = 'unavailable'; smsReason = 'No text queue/sender is configured.'; }
    else if (customer.transactional_consent !== 1 || customer.preferred_contact !== 'text') {
      smsStatus = 'skipped'; smsReason = 'Text consent and text contact preference are required.';
    } else if (!url || !smsBody.includes(url)) { smsStatus = 'failed'; smsReason = 'A complete secure text link could not be prepared.'; }
    else {
      jobId = id; smsAttempted = true;
      await db.prepare("UPDATE proposal_deliveries SET sms_status = 'sending', sms_job_id = ?, sms_body = ?, sms_to = ?, sms_attempted = 1 WHERE id = ?")
        .bind(jobId, smsBody, phone, id).run();
      const queued = await queueTransactionalSms(env, { requestId: input.requestId, template: 'booking_proposal', to: phone, body: smsText,
        transactionalConsent: true, requestedByCustomer: true, jobId });
      smsStatus = queued === 'failed' ? 'unknown' : queued;
      smsReason = queued === 'queued' ? 'Accepted by the queue only; SMS provider acceptance/delivery is not confirmed.'
        : 'Text queue response unavailable. Handoff is unconfirmed; review before an intentional resend.';
    }
    await db.prepare('UPDATE proposal_deliveries SET sms_to = ?, sms_body = ?, sms_status = ?, sms_reason = ?, sms_job_id = ?, sms_attempted = ? WHERE id = ?')
      .bind(smsTo, smsBody, smsStatus, smsReason, jobId, smsAttempted ? 1 : 0, id).run();

    // One owner email carries both the delivery summary and the untouched
    // customer email body. It is independent even when customer mail failed.
    const owner = env.ADMIN_NOTIFY_EMAIL?.trim() ?? '';
    if (!validEmail(owner) || owner.toLowerCase() === customer.email.trim().toLowerCase()
      || owner.toLowerCase() === original.to_email?.toLowerCase()) {
      await db.prepare("UPDATE proposal_deliveries SET owner_status = 'failed', owner_reason = ? WHERE id = ?")
        .bind('Owner notification address is missing, invalid, or matches the customer; duplicate customer email prevented.', id).run();
    } else {
      const providerId = safeProviderId(original.provider_id);
      const summary = [
        'Booking proposal delivery summary', `Customer: ${customer.full_name}`, `Customer email: ${original.to_email || '(missing)'}`,
        `Customer phone: ${customer.phone || '(missing)'}`, `Vehicle: ${[customer.year, customer.make, customer.model].filter(Boolean).join(' ')}`,
        `Request: ${customer.ref} (${input.requestId})`, `Proposal: ${proposal.id}`, `Delivery operation: ${id} (${mode})`, `Attempted at: ${now}`,
        `Customer email: ${emailStatus(result).toUpperCase()}${result.status === 'sent' ? ' — provider accepted; mailbox delivery unconfirmed' : ''} (attempted this operation: ${emailAttempted ? 'yes' : 'no'})`,
        ...(reason ? [`Email reason: ${reason}`] : []), ...(providerId ? [`Email provider ID: ${providerId}`] : []),
        `Customer SMS: ${smsStatus.toUpperCase()} (attempted this operation: ${smsAttempted ? 'yes' : 'no'})`, ...(smsReason ? [`SMS reason: ${smsReason}`] : []),
        ...(jobId ? [`SMS queue job ID (not a provider ID): ${jobId}`] : []), '', 'Proposal URL:', url, '',
        smsAttempted || smsStatus === 'queued' || smsStatus === 'unknown' ? 'Exact SMS body submitted to queue:' : 'Prepared SMS body — NOT SENT:', smsBody, '',
        result.status === 'sent' ? `Owner copy — this booking proposal was sent to ${firstName}.` : `Customer email snapshot — send not confirmed for ${firstName}.`, '', original.body_text,
      ].join('\n');
      const copy = await sendEmail(env, db, input.requestId, 'owner_booking_proposal', {
        to: owner, subject: original.subject!, text: summary, replyTo: validEmail(customer.email) ? customer.email : undefined,
        dedupeKey: `owner_booking_proposal:${id}`,
      });
      await db.prepare('UPDATE proposal_deliveries SET owner_message_id = ?, owner_status = ?, owner_reason = ? WHERE id = ?')
        .bind(copy.id, emailStatus(copy), emailReason(copy), id).run();
    }
    await db.prepare("UPDATE proposal_deliveries SET state = 'complete', completed_at = ? WHERE id = ?").bind(nowIso(), id).run();
  } catch {
    // IDs only: DB/queue/provider exceptions may include personal data/tokens.
    console.error(JSON.stringify({ event: 'proposal_delivery_interrupted', deliveryId: id, proposalId: proposal.id }));
    try {
      await db.prepare("UPDATE proposal_deliveries SET state = 'interrupted', email_reason = COALESCE(email_reason, 'Operation interrupted; review stored channel results before retrying.'), completed_at = ? WHERE id = ?")
        .bind(nowIso(), id).run();
    } catch { /* No unsafe external work without a durable operation claim. */ }
  }
  return { email: result, delivery: await proposalDeliveryDetails(db, proposal.id) };
}
