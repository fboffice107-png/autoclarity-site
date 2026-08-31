import { canTransition, isStatus, type Status } from './status.ts';
import { nowIso } from './util.ts';

export type TerminalLifecycleStatus = 'customer_cancelled' | 'admin_cancelled' | 'expired' | 'refunded' | 'disputed';

interface TerminalLifecycleInput {
  requestId: string;
  to: TerminalLifecycleStatus;
  actor: string;
  reason: string;
  relatedId: string;
}

export interface TerminalLifecycleResult {
  ok: boolean;
  alreadyApplied: boolean;
  from: Status | null;
  blockedByOpenPaymentClaim: boolean;
}

/**
 * Reconcile a terminal/expired request status, booking, and every active slot
 * in one D1 batch. Each dependent statement is gated on the request reaching
 * `to`, so a lost compare-and-swap cannot cancel a different lifecycle.
 */
export async function applyTerminalLifecycle(
  db: D1Database,
  input: TerminalLifecycleInput,
): Promise<TerminalLifecycleResult> {
  const current = await db
    .prepare(
      `SELECT status,
              EXISTS (
                SELECT 1 FROM payments
                WHERE request_id = ppi_requests.id AND status IN ('created','pending')
              ) AS has_open_payment
       FROM ppi_requests WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(input.requestId)
    .first<{ status: string; has_open_payment: number }>();
  if (!current || !isStatus(current.status)) {
    return { ok: false, alreadyApplied: false, from: null, blockedByOpenPaymentClaim: false };
  }

  const from = current.status as Status;
  const alreadyApplied = from === input.to;
  if (!alreadyApplied && !canTransition(from, input.to)) {
    return { ok: false, alreadyApplied: false, from, blockedByOpenPaymentClaim: false };
  }

  // Refund/dispute lifecycle follows a completed payment. Cancellation and
  // expiry, however, must never commit while a Checkout claim can still become
  // payable. The request update below repeats this predicate inside the same D1
  // transaction, closing the gap between provider expiry and this transition.
  const blocksOpenPayments = input.to === 'customer_cancelled'
    || input.to === 'admin_cancelled'
    || input.to === 'expired';
  if (blocksOpenPayments && current.has_open_payment && alreadyApplied) {
    return { ok: false, alreadyApplied, from, blockedByOpenPaymentClaim: true };
  }

  const now = nowIso();
  const bookingStatus = input.to === 'refunded' ? 'refunded' : 'cancelled';
  const requestUpdate = db
    .prepare(
      `UPDATE ppi_requests SET status = ?, updated_at = ?
       WHERE id = ? AND status = ? AND deleted_at IS NULL
         ${blocksOpenPayments
           ? "AND NOT EXISTS (SELECT 1 FROM payments WHERE request_id = ? AND status IN ('created','pending'))"
           : ''}`,
    )
    .bind(...(
      blocksOpenPayments
        ? [input.to, now, input.requestId, from, input.requestId]
        : [input.to, now, input.requestId, from]
    ));
  const statements: D1PreparedStatement[] = [];
  if (!alreadyApplied) statements.push(requestUpdate);
  statements.push(
    db
      .prepare(
        `UPDATE bookings
         SET status = ?,
             cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, ?) ELSE cancelled_at END,
             cancellation_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE cancellation_reason END,
             updated_at = ?
         WHERE request_id = ?
           AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = ?)`,
      )
      .bind(
        bookingStatus,
        bookingStatus,
        now,
        bookingStatus,
        input.reason,
        now,
        input.requestId,
        input.requestId,
        input.to,
      ),
    db
      .prepare(
        `UPDATE appointment_slots
         SET status = 'released', hold_expires_at = NULL, updated_at = ?
         WHERE request_id = ? AND status IN ('offered','held','confirmed')
           AND EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = ?)`,
      )
      .bind(now, input.requestId, input.requestId, input.to),
    db
      .prepare(
        `INSERT OR IGNORE INTO status_history
           (id, request_id, from_status, to_status, actor, reason, related_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM ppi_requests WHERE id = ? AND status = ?)`,
      )
      .bind(
        `sh_lifecycle_${input.relatedId}_${input.to}`,
        input.requestId,
        from,
        input.to,
        input.actor,
        input.reason,
        input.relatedId,
        now,
        input.requestId,
        input.to,
      ),
  );

  const results = await db.batch(statements);
  if (!alreadyApplied && (results[0]?.meta?.changes ?? 0) !== 1) {
    const openPayment = blocksOpenPayments
      ? await db
          .prepare(
            `SELECT 1 AS open FROM payments
             WHERE request_id = ? AND status IN ('created','pending') LIMIT 1`,
          )
          .bind(input.requestId)
          .first<{ open: number }>()
      : null;
    return {
      ok: false,
      alreadyApplied: false,
      from,
      blockedByOpenPaymentClaim: Boolean(openPayment),
    };
  }
  return { ok: true, alreadyApplied, from, blockedByOpenPaymentClaim: false };
}
