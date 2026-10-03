// Optional owner confirmation and a read-only view of the original outbox.
// Customer delivery, rendering, and booking state remain the existing flow.
import type { Env } from './types.ts';
import { queueEmail, type EmailResult, type StoredEmailMessage } from './email.ts';
import { persistNotificationIssue } from './notification-issues.ts';

export const ownerProposalKey = (proposalId: string): string => `owner_booking_proposal:${proposalId}`;

async function customerProposalEmail(db: D1Database, requestId: string, messageId: string | null): Promise<StoredEmailMessage | null> {
  if (!messageId) return null;
  return db.prepare(`SELECT id, request_id, template, to_email, subject, body_text, status, created_at
    FROM messages WHERE id = ? AND request_id = ? AND template = 'booking_proposal'
    AND direction = 'outbound' AND channel = 'email'`).bind(messageId, requestId).first<StoredEmailMessage>();
}

/** Never sends to the customer, never throws, and never changes proposal status. */
export async function queueProposalOwnerCopy(
  env: Env, db: D1Database,
  input: { requestId: string; proposalId: string; customerFirstName: string; customerEmail: EmailResult },
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<EmailResult | null> {
  if (input.customerEmail.status !== 'sent') return null;
  const dedupeKey = ownerProposalKey(input.proposalId);
  try {
    const owner = env.ADMIN_NOTIFY_EMAIL?.trim();
    if (!owner || owner.length > 254 || /[\r\n]/.test(owner) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) {
      throw new Error('Owner notification email is not configured correctly.');
    }
    const original = await customerProposalEmail(db, input.requestId, input.customerEmail.id);
    if (!original?.to_email || !original.subject || !original.body_text) throw new Error('Stored customer proposal email is unavailable.');
    if (owner.toLowerCase() === original.to_email.trim().toLowerCase()) throw new Error('Owner and customer recipients match; a duplicate customer email was prevented.');
    const firstName = input.customerFirstName.trim().split(/\s+/)[0] || 'the customer';
    // The original subject and body are copied from the outbox, not regenerated
    // from mutable request, quote, appointment, or configuration data.
    return await queueEmail(env, db, input.requestId, 'owner_booking_proposal', {
      to: owner,
      subject: original.subject,
      text: `Owner copy — this booking proposal was sent to ${firstName}.\n\n${original.body_text}`,
      replyTo: original.to_email,
      dedupeKey,
    }, waitUntil);
  } catch (error) {
    console.error(JSON.stringify({ event: 'proposal_owner_copy_failed', proposalId: input.proposalId, error: String(error).slice(0, 240) }));
    await persistNotificationIssue(db, {
      actor: 'system:email', requestId: input.requestId, issueKey: `outbox:${dedupeKey}`,
      kind: 'record_failed', sourceAction: 'owner_booking_proposal', template: 'owner_booking_proposal', dedupeKey, error: String(error),
    });
    return { id: null, status: 'failed', failure: 'outbox_record_failed' };
  }
}

/** Keep the stored text verbatim except for bearer links, which stay private. */
export function redactProposalBookingLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s<>]+/gi, raw => {
    try {
      const url = new URL(raw);
      if (url.pathname.replace(/\/+$/, '') === '/ppi/portal' && url.searchParams.has('t')) {
        return '[Open your secure booking page — link hidden in this admin preview]';
      }
    } catch { /* Preserve ordinary text. */ }
    return raw;
  });
}

/** Read-only; opening an old proposal never creates or sends an owner copy. */
export async function proposalEmailDetails(db: D1Database, input: {
  requestId: string; proposalId: string; messageId: string | null; sentAt: string | null;
}): Promise<Record<string, unknown>> {
  const original = await customerProposalEmail(db, input.requestId, input.messageId);
  const owner = await db.prepare(`SELECT id, status, created_at FROM messages
    WHERE request_id = ? AND dedupe_key = ? AND template = 'owner_booking_proposal'
    AND direction = 'outbound' AND channel = 'email'`)
    .bind(input.requestId, ownerProposalKey(input.proposalId))
    .first<{ id: string; status: string; created_at: string }>();
  const issue = !owner ? await db.prepare(`SELECT id FROM admin_audit_log
    WHERE entity_id = ? AND action = 'notification_record_failed'
    AND json_extract(details_json, '$.dedupeKey') = ? LIMIT 1`)
    .bind(input.requestId, ownerProposalKey(input.proposalId)).first<{ id: string }>() : null;
  return {
    emailSnapshot: original ? {
      messageId: original.id, subject: original.subject, recipient: original.to_email,
      bodyText: redactProposalBookingLinks(original.body_text ?? ''),
      recordedAt: original.created_at, sentAt: input.sentAt, status: original.status,
    } : null,
    ownerCopy: owner ? { status: owner.status, messageId: owner.id, recordedAt: owner.created_at } : { status: issue ? 'failed' : 'not_recorded' },
  };
}
