// Optional owner confirmation and a read-only view of the original outbox.
// Customer delivery, rendering, and booking state remain the existing flow.
import type { StoredEmailMessage } from './email.ts';

export const ownerProposalKey = (proposalId: string): string => `owner_booking_proposal:${proposalId}`;

async function customerProposalEmail(db: D1Database, requestId: string, messageId: string | null): Promise<StoredEmailMessage | null> {
  if (!messageId) return null;
  return db.prepare(`SELECT id, request_id, template, to_email, subject, body_text, status, created_at
    FROM messages WHERE id = ? AND request_id = ? AND template = 'booking_proposal'
    AND direction = 'outbound' AND channel = 'email'`).bind(messageId, requestId).first<StoredEmailMessage>();
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
  const delivery = await db.prepare('SELECT owner_message_id, owner_status FROM proposal_deliveries WHERE proposal_id = ? ORDER BY rowid DESC LIMIT 1')
    .bind(input.proposalId).first<{ owner_message_id: string | null; owner_status: string }>();
  const accepted = original ? await db.prepare("SELECT email_sent_at FROM proposal_deliveries WHERE proposal_id = ? AND email_message_id = ? AND email_status = 'accepted' ORDER BY rowid LIMIT 1")
    .bind(input.proposalId, original.id).first<{ email_sent_at: string | null }>() : null;
  const owner = delivery ? await db.prepare('SELECT id, status, created_at FROM messages WHERE id = ?').bind(delivery.owner_message_id).first<{ id: string; status: string; created_at: string }>() : await db.prepare(`SELECT id, status, created_at FROM messages
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
      recordedAt: original.created_at, sentAt: original.status === 'sent' ? accepted?.email_sent_at ?? input.sentAt : null, status: original.status,
    } : null,
    ownerCopy: owner ? { status: owner.status, messageId: owner.id, recordedAt: owner.created_at } : { status: delivery?.owner_status ?? (issue ? 'failed' : 'not_recorded') },
  };
}
