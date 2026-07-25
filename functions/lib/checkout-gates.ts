// The single place that decides whether a customer may reach Stripe Checkout.
//
// Business rule: submitting an inspection request is free and never touches
// payment. Checkout only becomes possible once the owner has reviewed the
// request, sent an exact quote, offered real appointment windows, the customer
// has held one of them, and the customer has accepted every current agreement
// document against THAT quote.
//
// The gates are a pure function of facts read from the database so that every
// refusal path is directly testable (tests/unit/checkout-gates.test.ts) —
// including the ones that are hard to reach through the HTTP API.

import type { Status } from './status.ts';
import { quoteExpired } from './pricing.ts';

export interface CheckoutQuoteFacts {
  id: string;
  status: string; // draft | sent | accepted | superseded | expired | cancelled
  expiresAt: string;
  totalCents: number;
}

export interface CheckoutFacts {
  /** Current request status (the review/quote/scheduling gate in one value). */
  status: Status;
  /** Highest-version quote for the request, whatever its status. */
  quote: CheckoutQuoteFacts | null;
  /** True when a payment for this request already succeeded (or was refunded
   *  or disputed) — the customer must never be charged a second time. */
  hasSettledPayment: boolean;
  /** Id of the slot currently held for this request, if any. */
  heldSlotId: string | null;
  /** Ids of every agreement document required right now. */
  requiredAgreementIds: string[];
  /** Agreement version ids this request has accepted (accepted = 1). */
  acceptedAgreementIds: string[];
  /** Agreement version ids accepted against the CURRENT quote id. */
  acceptedForQuoteIds: string[];
  now?: Date;
}

/** How the portal should recover the request so the customer is never stuck. */
export type CheckoutRecovery = 'time_selection' | 'agreement';

export type CheckoutGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string; httpStatus: number; recover?: CheckoutRecovery };

const CONFIRMED_OR_LATER: Status[] = ['confirmed', 'inspection_in_progress', 'report_in_progress', 'completed'];
const CLOSED: Status[] = ['customer_cancelled', 'admin_cancelled', 'expired', 'refunded', 'disputed'];

function missing(required: string[], have: string[]): string[] {
  const set = new Set(have);
  return required.filter((id) => !set.has(id));
}

/**
 * Evaluates every pre-payment gate in order. The first failure wins, so the
 * customer always sees the earliest thing that actually needs attention.
 */
export function evaluateCheckoutGates(facts: CheckoutFacts): CheckoutGateResult {
  const now = facts.now ?? new Date();

  // 1. State gate. Reaching 'awaiting_payment' is only possible via
  //    ready_for_review → quote_prepared → quote_sent → awaiting_time_selection
  //    → awaiting_agreement, so this single check also proves the request was
  //    reviewed, quoted, scheduled and agreed to.
  if (facts.status !== 'awaiting_payment') {
    if (CONFIRMED_OR_LATER.includes(facts.status)) {
      return {
        ok: false,
        code: 'already_confirmed',
        message: 'This appointment is already confirmed — there is nothing left to pay.',
        httpStatus: 409,
      };
    }
    if (CLOSED.includes(facts.status)) {
      return {
        ok: false,
        code: 'request_closed',
        message: 'This request is closed, so it cannot be paid for. Email support if you would like to book again.',
        httpStatus: 409,
      };
    }
    return {
      ok: false,
      code: 'wrong_state',
      message: 'Payment is not available for this request yet. AutoClarity will send your quote and appointment options first.',
      httpStatus: 409,
    };
  }

  // 2. Never charge twice. A request can return to 'awaiting_payment' after a
  //    payment already settled (for example a hold that lapsed while Stripe was
  //    confirming); the owner finishes those by hand, the customer does not pay
  //    again.
  if (facts.hasSettledPayment) {
    return {
      ok: false,
      code: 'already_paid',
      message: 'Your payment has already been received — nothing further is due. AutoClarity is confirming your appointment time with you directly.',
      httpStatus: 409,
    };
  }

  // 3. An owner-approved quote must exist and still be the sent one.
  if (!facts.quote) {
    return { ok: false, code: 'no_quote', message: 'There is no active quote for this request.', httpStatus: 409 };
  }
  if (facts.quote.status !== 'sent') {
    return {
      ok: false,
      code: 'no_quote',
      message: 'There is no active quote for this request. AutoClarity will send an updated quote.',
      httpStatus: 409,
    };
  }
  if (quoteExpired(facts.quote.expiresAt, now)) {
    return {
      ok: false,
      code: 'quote_expired',
      message: 'This quote has expired. AutoClarity will send you a refreshed quote.',
      httpStatus: 409,
    };
  }
  if (!Number.isInteger(facts.quote.totalCents) || facts.quote.totalCents <= 0) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: 'This quote needs to be corrected before it can be paid. Please contact AutoClarity.',
      httpStatus: 409,
    };
  }

  // 4. A real, currently-held appointment window.
  if (!facts.heldSlotId) {
    return {
      ok: false,
      code: 'hold_lapsed',
      message: 'Your held time lapsed, so it has been released. Please choose an appointment window again.',
      httpStatus: 409,
      recover: 'time_selection',
    };
  }

  // 5. Every CURRENT agreement document accepted — a count is not enough,
  //    because publishing a new document version changes which ids are required.
  if (missing(facts.requiredAgreementIds, facts.acceptedAgreementIds).length > 0) {
    return {
      ok: false,
      code: 'agreements_missing',
      message: 'Please review and accept the current service agreements before paying.',
      httpStatus: 409,
      recover: 'agreement',
    };
  }

  // 6. Those acceptances must belong to the quote being charged.
  if (missing(facts.requiredAgreementIds, facts.acceptedForQuoteIds).length > 0) {
    return {
      ok: false,
      code: 'quote_changed',
      message: 'Your quote changed after you accepted the agreements. Please review the new quote and accept the terms again.',
      httpStatus: 409,
      recover: 'agreement',
    };
  }

  return { ok: true };
}
