// The booking proposal: one owner action that produces one customer decision.
//
// Before this existed the owner had to run create_quote → send_quote →
// propose_slots → send_message, each with its own email and its own portal
// link. Skipping propose_slots — easy to do, nothing warned you — left the
// customer looking at a price with no way to accept it. This module makes the
// price and the times a single saved object with a single notification.

import type { PpiConfig } from './config.ts';
import { nowIso, newId } from './util.ts';

export interface SlotCandidate {
  startsAt: string;
  endsAt: string;
  blockedStartsAt: string;
  blockedEndsAt: string;
}

export interface SlotValidation {
  valid: SlotCandidate[];
  /** Human-readable reason per rejected time; shown to the owner, not stored. */
  skipped: string[];
}

/**
 * Shared slot preflight. The partial unique index from 0001 and the overlap
 * triggers from 0014 remain the concurrency-safe authority — this exists so
 * the owner gets a sentence instead of a database error, and so the same
 * lead-time and buffer rules apply wherever times are offered.
 */
export async function validateSlotTimes(
  db: D1Database,
  requestId: string,
  rawStarts: unknown[],
  config: PpiConfig,
  now = Date.now(),
): Promise<SlotValidation> {
  const valid: SlotCandidate[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawStarts.slice(0, 5)) {
    const label = String(raw);
    const start = new Date(label);
    if (Number.isNaN(start.getTime())) {
      skipped.push(`${label} — not a valid date and time`);
      continue;
    }
    const startIso = start.toISOString();
    if (seen.has(startIso)) {
      skipped.push(`${label} — duplicate of another option`);
      continue;
    }
    seen.add(startIso);

    if (start.getTime() < now + config.scheduling.minLeadHours * 3600_000 - 60_000) {
      skipped.push(`${label} — in the past or inside the ${config.scheduling.minLeadHours}-hour lead time`);
      continue;
    }
    if (start.getTime() > now + config.scheduling.maxAdvanceDays * 86_400_000 + 60_000) {
      skipped.push(`${label} — beyond the ${config.scheduling.maxAdvanceDays}-day scheduling window`);
      continue;
    }

    const end = new Date(start.getTime() + config.scheduling.durationMin * 60_000);
    const blockedStartsAt = new Date(start.getTime() - config.scheduling.travelBufferMin * 60_000).toISOString();
    const blockedEndsAt = new Date(end.getTime() + config.scheduling.reportBufferMin * 60_000).toISOString();

    // Options offered on the SAME request are alternatives for one inspection,
    // so they are allowed to overlap each other's buffers. Anything belonging
    // to a different request is a real conflict.
    const clash = await db
      .prepare(
        `SELECT id FROM appointment_slots
         WHERE status IN ('offered','held','confirmed')
           AND NOT (request_id = ? AND status = 'offered')
           AND COALESCE(blocked_starts_at, starts_at) < ?
           AND COALESCE(blocked_ends_at, ends_at) > ? LIMIT 1`,
      )
      .bind(requestId, blockedEndsAt, blockedStartsAt)
      .first<{ id: string }>();
    if (clash) {
      skipped.push(`${label} — conflicts with another confirmed or offered appointment (including travel and report buffers)`);
      continue;
    }

    valid.push({ startsAt: startIso, endsAt: end.toISOString(), blockedStartsAt, blockedEndsAt });
  }

  valid.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { valid, skipped };
}

export type ProposalNotificationStatus = 'saved' | 'queued' | 'sent' | 'failed';

export interface BookingProposalRow {
  id: string;
  request_id: string;
  quote_id: string;
  slot_ids_json: string;
  total_cents: number;
  customer_message: string | null;
  notification_status: ProposalNotificationStatus;
  notification_message_id: string | null;
  notification_error: string | null;
  idempotency_key: string;
  created_by: string;
  created_at: string;
  sent_at: string | null;
  updated_at: string;
}

export async function findProposalByKey(
  db: D1Database,
  requestId: string,
  idempotencyKey: string,
): Promise<BookingProposalRow | null> {
  return db
    .prepare(`SELECT * FROM booking_proposals WHERE request_id = ? AND idempotency_key = ?`)
    .bind(requestId, idempotencyKey)
    .first<BookingProposalRow>();
}

export async function latestProposal(db: D1Database, requestId: string): Promise<BookingProposalRow | null> {
  return db
    .prepare(`SELECT * FROM booking_proposals WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(requestId)
    .first<BookingProposalRow>();
}

export function newProposalId(): string {
  return newId('bpr');
}

/**
 * Record what actually happened to the notification. "sent" is written only
 * when the provider accepted the message; everything else stays visibly
 * unproven so the dashboard never claims a delivery it cannot support.
 */
export async function recordProposalNotification(
  db: D1Database,
  proposalId: string,
  status: ProposalNotificationStatus,
  messageId: string | null,
  error: string | null,
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE booking_proposals
       SET notification_status = ?, notification_message_id = ?, notification_error = ?,
           sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(status, messageId, error, status, now, now, proposalId)
    .run();
}

/** The customer-facing message preview the owner reviews before sending. */
export function defaultProposalMessage(input: {
  customerFirstName: string;
  vehicle: string;
  totalLabel: string;
  travelSentence: string;
}): string {
  const vehicle = input.vehicle.trim() || 'your vehicle';
  return [
    `Hi ${input.customerFirstName || 'there'},`,
    '',
    `Your pre-purchase inspection for ${vehicle} is ready to book.`,
    `Total: ${input.totalLabel}. ${input.travelSentence}`,
    '',
    'Pick whichever time works, accept the service agreements, and pay — all on one page.',
  ].join('\n');
}

export function travelSentence(feeCents: number | null, miles: number | null): string {
  if (feeCents === null) return 'Travel for this location is quoted individually and is shown in your total.';
  if (feeCents === 0) {
    if (miles === null || miles < 1) return 'Travel to the vehicle is included.';
    return `Travel is included — the vehicle is about ${miles} miles from AutoClarity.`;
  }
  const amount = (feeCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return miles === null
    ? `A ${amount} mobile-service charge applies and is already in your total.`
    : `The vehicle is about ${miles} miles out, so a ${amount} mobile-service charge is included in your total.`;
}
