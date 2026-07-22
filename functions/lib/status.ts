// PPI request lifecycle state machine. Every change goes through applyStatus,
// which enforces the transition table and writes status_history.

export const STATUSES = [
  'draft',
  'submitted',
  'needs_info',
  'seller_access_pending',
  'ready_for_review',
  'quote_prepared',
  'quote_sent',
  'awaiting_time_selection',
  'awaiting_agreement',
  'awaiting_payment',
  'confirmed',
  'inspection_in_progress',
  'report_in_progress',
  'completed',
  'customer_cancelled',
  'admin_cancelled',
  'expired',
  'refunded',
  'disputed',
] as const;

export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  needs_info: 'Needs More Information',
  seller_access_pending: 'Seller Access Pending',
  ready_for_review: 'Ready for Review',
  quote_prepared: 'Quote Prepared',
  quote_sent: 'Quote Sent',
  awaiting_time_selection: 'Awaiting Time Selection',
  awaiting_agreement: 'Awaiting Agreement',
  awaiting_payment: 'Awaiting Payment',
  confirmed: 'Confirmed',
  inspection_in_progress: 'Inspection In Progress',
  report_in_progress: 'Report In Progress',
  completed: 'Completed',
  customer_cancelled: 'Customer Cancelled',
  admin_cancelled: 'Admin Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
  disputed: 'Disputed',
};

const CANCELS: Status[] = ['customer_cancelled', 'admin_cancelled'];

const TRANSITIONS: Record<Status, Status[]> = {
  draft: ['submitted', ...CANCELS, 'expired'],
  submitted: ['needs_info', 'seller_access_pending', 'ready_for_review', ...CANCELS, 'expired'],
  needs_info: ['submitted', 'seller_access_pending', 'ready_for_review', ...CANCELS, 'expired'],
  seller_access_pending: ['needs_info', 'ready_for_review', ...CANCELS, 'expired'],
  ready_for_review: ['needs_info', 'seller_access_pending', 'quote_prepared', ...CANCELS],
  quote_prepared: ['quote_sent', 'ready_for_review', ...CANCELS],
  quote_sent: ['awaiting_time_selection', 'quote_prepared', ...CANCELS, 'expired'],
  awaiting_time_selection: ['awaiting_agreement', 'quote_sent', 'quote_prepared', ...CANCELS, 'expired'],
  awaiting_agreement: ['awaiting_payment', 'awaiting_time_selection', ...CANCELS, 'expired'],
  awaiting_payment: ['confirmed', 'awaiting_agreement', 'awaiting_time_selection', ...CANCELS, 'expired'],
  confirmed: ['inspection_in_progress', ...CANCELS, 'refunded'],
  inspection_in_progress: ['report_in_progress', 'completed', 'admin_cancelled'],
  report_in_progress: ['completed', 'admin_cancelled'],
  completed: ['refunded', 'disputed'],
  customer_cancelled: ['refunded', 'disputed'],
  admin_cancelled: ['refunded', 'disputed'],
  expired: ['ready_for_review'], // admin may reopen
  refunded: ['disputed'],
  disputed: ['refunded'],
};

export function isStatus(v: string): v is Status {
  return (STATUSES as readonly string[]).includes(v);
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public from: string,
    public to: string,
  ) {
    super(`Invalid status transition: ${from} -> ${to}`);
  }
}

/**
 * Atomically move a request from its current status to `to`, recording history.
 * Fails (returns false) if the row is not currently in `expectedFrom` — this is
 * the guard against concurrent double-transitions.
 */
export async function applyStatus(
  db: D1Database,
  requestId: string,
  expectedFrom: Status,
  to: Status,
  actor: string,
  reason?: string,
  relatedId?: string,
): Promise<boolean> {
  if (!canTransition(expectedFrom, to)) throw new InvalidTransitionError(expectedFrom, to);
  const now = new Date().toISOString();
  const upd = await db
    .prepare(`UPDATE ppi_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND deleted_at IS NULL`)
    .bind(to, now, requestId, expectedFrom)
    .run();
  if (!upd.meta || upd.meta.changes !== 1) return false;
  await db
    .prepare(
      `INSERT INTO status_history (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(`sh_${crypto.randomUUID().replaceAll('-', '')}`, requestId, expectedFrom, to, actor, reason ?? null, relatedId ?? null, now)
    .run();
  return true;
}
