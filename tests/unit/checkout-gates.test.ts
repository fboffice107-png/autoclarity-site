// The pre-payment gate matrix. Every refusal path is exercised here, including
// the ones that are unreachable through the HTTP API by design — those are
// exactly the ones that must stay closed if the API ever changes.
import { describe, expect, it } from 'vitest';
import { evaluateCheckoutGates, type CheckoutFacts } from '../../functions/lib/checkout-gates.ts';
import { STATUSES, type Status } from '../../functions/lib/status.ts';

const REQUIRED = ['ag_service_agreement_v1', 'ag_cancellation_policy_v1', 'ag_privacy_notice_v1'];
const FUTURE = new Date(Date.now() + 48 * 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();
const QUOTE_ID = 'qot_current';

/** A request that has passed every gate — each test breaks exactly one thing. */
function facts(overrides: Partial<CheckoutFacts> = {}): CheckoutFacts {
  return {
    status: 'awaiting_payment',
    quote: { id: QUOTE_ID, status: 'sent', expiresAt: FUTURE, totalCents: 24900 },
    hasSettledPayment: false,
    heldSlotId: 'slt_1',
    requiredAgreementIds: [...REQUIRED],
    acceptedAgreementIds: [...REQUIRED],
    acceptedForQuoteIds: [...REQUIRED],
    ...overrides,
  };
}

describe('checkout gates — the happy path', () => {
  it('allows checkout only when every gate is satisfied', () => {
    expect(evaluateCheckoutGates(facts())).toEqual({ ok: true });
  });
});

describe('checkout gates — request state', () => {
  it('refuses every status except awaiting_payment', () => {
    const allowed: Status[] = ['awaiting_payment'];
    for (const status of STATUSES) {
      const result = evaluateCheckoutGates(facts({ status }));
      if (allowed.includes(status)) {
        expect(result.ok, status).toBe(true);
      } else {
        expect(result.ok, status).toBe(false);
      }
    }
  });

  it('refuses a freshly submitted request (no review, no quote yet)', () => {
    const r = evaluateCheckoutGates(facts({ status: 'submitted', quote: null, heldSlotId: null, acceptedAgreementIds: [], acceptedForQuoteIds: [] }));
    expect(r).toMatchObject({ ok: false, code: 'wrong_state', httpStatus: 409 });
  });

  it('refuses a request the owner has reviewed but not yet quoted', () => {
    expect(evaluateCheckoutGates(facts({ status: 'ready_for_review' }))).toMatchObject({ code: 'wrong_state' });
  });

  it('refuses while the quote is only prepared or sent (no time chosen yet)', () => {
    expect(evaluateCheckoutGates(facts({ status: 'quote_prepared' }))).toMatchObject({ code: 'wrong_state' });
    expect(evaluateCheckoutGates(facts({ status: 'quote_sent' }))).toMatchObject({ code: 'wrong_state' });
    expect(evaluateCheckoutGates(facts({ status: 'awaiting_time_selection' }))).toMatchObject({ code: 'wrong_state' });
  });

  it('refuses while agreements are still outstanding', () => {
    expect(evaluateCheckoutGates(facts({ status: 'awaiting_agreement' }))).toMatchObject({ code: 'wrong_state' });
  });

  it('refuses cancelled, expired, refunded and disputed requests', () => {
    for (const status of ['customer_cancelled', 'admin_cancelled', 'expired', 'refunded', 'disputed'] as Status[]) {
      expect(evaluateCheckoutGates(facts({ status })), status).toMatchObject({ code: 'request_closed', httpStatus: 409 });
    }
  });

  it('refuses a second payment once the appointment is confirmed', () => {
    for (const status of ['confirmed', 'inspection_in_progress', 'report_in_progress', 'completed'] as Status[]) {
      expect(evaluateCheckoutGates(facts({ status })), status).toMatchObject({ code: 'already_confirmed' });
    }
  });
});

describe('checkout gates — never charge twice', () => {
  it('refuses when a payment for this request already succeeded', () => {
    expect(evaluateCheckoutGates(facts({ hasSettledPayment: true }))).toMatchObject({
      ok: false,
      code: 'already_paid',
      httpStatus: 409,
    });
  });

  it('refuses before looking at the quote or the slot', () => {
    const r = evaluateCheckoutGates(facts({ hasSettledPayment: true, quote: null, heldSlotId: null, acceptedAgreementIds: [] }));
    expect(r).toMatchObject({ code: 'already_paid' });
  });

  it('does not offer a recovery step — the owner finishes these by hand', () => {
    const r = evaluateCheckoutGates(facts({ hasSettledPayment: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recover).toBeUndefined();
  });
});

describe('checkout gates — quote', () => {
  it('refuses when no quote exists at all', () => {
    expect(evaluateCheckoutGates(facts({ quote: null }))).toMatchObject({ code: 'no_quote', httpStatus: 409 });
  });

  it('refuses a draft quote the owner has not sent', () => {
    expect(evaluateCheckoutGates(facts({ quote: { id: QUOTE_ID, status: 'draft', expiresAt: FUTURE, totalCents: 24900 } }))).toMatchObject({
      code: 'no_quote',
    });
  });

  it('refuses a superseded or cancelled quote', () => {
    for (const status of ['superseded', 'cancelled', 'expired']) {
      expect(
        evaluateCheckoutGates(facts({ quote: { id: QUOTE_ID, status, expiresAt: FUTURE, totalCents: 24900 } })),
        status,
      ).toMatchObject({ code: 'no_quote' });
    }
  });

  it('refuses an expired quote', () => {
    expect(evaluateCheckoutGates(facts({ quote: { id: QUOTE_ID, status: 'sent', expiresAt: PAST, totalCents: 24900 } }))).toMatchObject({
      code: 'quote_expired',
    });
  });

  it('honours the injected clock (a quote expiring in the future is fine)', () => {
    const r = evaluateCheckoutGates(facts({ now: new Date(Date.now() + 1000) }));
    expect(r.ok).toBe(true);
  });

  it('refuses a zero, negative or non-integer total', () => {
    for (const totalCents of [0, -1, 1.5, Number.NaN]) {
      expect(
        evaluateCheckoutGates(facts({ quote: { id: QUOTE_ID, status: 'sent', expiresAt: FUTURE, totalCents } })),
        String(totalCents),
      ).toMatchObject({ code: 'invalid_amount' });
    }
  });
});

describe('checkout gates — appointment window', () => {
  it('refuses when no slot is held and asks for a new selection', () => {
    expect(evaluateCheckoutGates(facts({ heldSlotId: null }))).toMatchObject({
      code: 'hold_lapsed',
      recover: 'time_selection',
      httpStatus: 409,
    });
  });
});

describe('checkout gates — agreements', () => {
  it('refuses when no agreement was accepted', () => {
    expect(evaluateCheckoutGates(facts({ acceptedAgreementIds: [], acceptedForQuoteIds: [] }))).toMatchObject({
      code: 'agreements_missing',
      recover: 'agreement',
    });
  });

  it('refuses when one required document is missing', () => {
    const partial = REQUIRED.slice(1);
    expect(evaluateCheckoutGates(facts({ acceptedAgreementIds: partial, acceptedForQuoteIds: partial }))).toMatchObject({
      code: 'agreements_missing',
    });
  });

  // The defect this replaced: the old gate compared COUNTS, so accepting three
  // superseded documents satisfied a requirement for three current ones.
  it('refuses stale document versions even when the count matches', () => {
    const stale = ['ag_service_agreement_v1', 'ag_cancellation_policy_v1', 'ag_privacy_notice_v1'];
    const nowRequired = ['ag_service_agreement_v2', 'ag_cancellation_policy_v1', 'ag_privacy_notice_v1'];
    const r = evaluateCheckoutGates(
      facts({ requiredAgreementIds: nowRequired, acceptedAgreementIds: stale, acceptedForQuoteIds: stale }),
    );
    expect(r).toMatchObject({ code: 'agreements_missing', recover: 'agreement' });
  });

  it('ignores extra acceptances of retired documents', () => {
    const withExtras = [...REQUIRED, 'ag_retired_doc_v1'];
    expect(evaluateCheckoutGates(facts({ acceptedAgreementIds: withExtras, acceptedForQuoteIds: withExtras }))).toEqual({ ok: true });
  });
});

describe('checkout gates — quote version stability', () => {
  it('refuses when the acceptances belong to an earlier quote', () => {
    expect(evaluateCheckoutGates(facts({ acceptedForQuoteIds: [] }))).toMatchObject({
      code: 'quote_changed',
      recover: 'agreement',
      httpStatus: 409,
    });
  });

  it('refuses when only some documents were re-accepted against the new quote', () => {
    expect(evaluateCheckoutGates(facts({ acceptedForQuoteIds: REQUIRED.slice(1) }))).toMatchObject({ code: 'quote_changed' });
  });

  it('allows once every document is re-accepted against the current quote', () => {
    expect(evaluateCheckoutGates(facts({ acceptedForQuoteIds: [...REQUIRED] }))).toEqual({ ok: true });
  });
});

describe('checkout gates — ordering', () => {
  // The customer should always be told the earliest thing that needs doing.
  it('reports the state problem before the quote problem', () => {
    expect(evaluateCheckoutGates(facts({ status: 'submitted', quote: null }))).toMatchObject({ code: 'wrong_state' });
  });

  it('reports the quote problem before the slot problem', () => {
    expect(evaluateCheckoutGates(facts({ quote: null, heldSlotId: null }))).toMatchObject({ code: 'no_quote' });
  });

  it('reports the slot problem before the agreement problem', () => {
    expect(evaluateCheckoutGates(facts({ heldSlotId: null, acceptedAgreementIds: [] }))).toMatchObject({ code: 'hold_lapsed' });
  });
});
