/// <reference types="vite/client" />

// The words on screen are part of the contract here: the owner asked for
// specific plain-language stage labels, one obvious primary action per stage,
// and a customer page that never dead-ends. These assertions pin that
// vocabulary so a later refactor cannot quietly reintroduce raw status names.

import { describe, expect, it } from 'vitest';
import adminScript from '../../assets/js/ppi-admin.js?raw';
import portalScript from '../../assets/js/ppi-portal.js?raw';
import formScript from '../../assets/js/ppi-form.js?raw';
// @ts-expect-error Node builtins are supplied by the test runtime.
import { readFileSync } from 'node:fs';

// Vite transforms `.css?raw`, so read the stylesheet from disk instead.
const portalCss = readFileSync(new URL('../../assets/css/ppi.css', import.meta.url), 'utf8');

describe('admin — the request answers "who acts next"', () => {
  it('uses the owner’s plain-language stage labels', () => {
    for (const label of [
      'Needs your review',
      'Waiting for customer to choose a time',
      'Time selected — awaiting payment',
      'Paid — appointment confirmed',
    ]) expect(adminScript).toContain(label);
  });

  it('derives every stage from saved state, never from a guess', () => {
    const start = adminScript.indexOf('var STAGE_BY_STATUS = {');
    const end = adminScript.indexOf('var TIER_SHORT', start);
    const section = adminScript.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // Every state the request machine can be in has a sentence.
    for (const status of [
      'submitted', 'needs_info', 'seller_access_pending', 'ready_for_review',
      'quote_prepared', 'quote_sent', 'awaiting_time_selection', 'awaiting_agreement',
      'awaiting_payment', 'confirmed', 'inspection_in_progress', 'report_in_progress',
      'completed', 'customer_cancelled', 'admin_cancelled', 'expired', 'refunded',
      'refund_reconciliation_needed', 'disputed',
    ]) expect(section).toContain(`${status}:`);
  });

  it('treats an offer the customer cannot act on as the owner\u2019s move', () => {
    // Saying "waiting for customer" on a lapsed offer is what let a real
    // quote sit until the customer gave up and cancelled it.
    expect(adminScript).toContain('Offer expired — re-send to continue');
    expect(adminScript).toContain('Offer has no times left — re-send');
    expect(adminScript).toContain('current_quote_expires_at');
    expect(adminScript).toContain('held_slot_count');
  });

  it('shouts about the two states that cost the owner money', () => {
    // A price with no times is what stranded a real customer.
    expect(adminScript).toContain('Proposal sent without times — customer cannot book');
    // A payment whose slot lapsed must never look routine.
    expect(adminScript).toContain('Paid — scheduling needs attention');
    expect(adminScript).toContain('email not delivered');
  });

  it('shows the whole request on the list card without opening it', () => {
    for (const key of ['Customer', 'Where', 'Price', 'Appointment', 'Payment', 'Next move']) {
      expect(adminScript).toContain(`<span class="job-k">${key}</span>`);
    }
  });
});

describe('admin — one primary action before booking', () => {
  it('leads with the booking proposal and its total', () => {
    expect(adminScript).toContain('Booking proposal');
    expect(adminScript).toContain('Send booking proposal');
    expect(adminScript).toContain('send_booking_proposal');
    expect(adminScript).toContain("id=\"sendProposal\"");
  });

  it('gets its price from the server, never by adding up line items itself', () => {
    expect(adminScript).toContain('"price_preview"');
    expect(adminScript).not.toMatch(/baseCents\s*\+\s*travelCents/u);
  });

  it('keeps advanced pricing available but out of the way', () => {
    expect(adminScript).toContain('<details class="advanced-pricing"');
    expect(adminScript).toContain('>Advanced pricing</summary>');
    for (const id of ['pBase', 'pTravel', 'pAddonLabel', 'pAddon', 'pDiscount', 'pDiscountLabel', 'pExpires', 'pInternal']) {
      expect(adminScript).toContain(`id="${id}"`);
    }
    // The internal note is labelled as never reaching the customer.
    expect(adminScript).toContain('Internal note — never shown to the customer');
  });

  it('demotes the old quote and scheduling tools to secondary panels', () => {
    expect(adminScript).toContain('Quotes &amp; manual quote builder</summary>');
    expect(adminScript).toContain('Advanced scheduling tools</summary>');
  });

  it('refuses to send without times and retains an unsent draft', () => {
    expect(adminScript).toContain('a proposal without times leaves the customer unable to book');
    expect(adminScript).toContain('Choose a date and at least one start time for that date');
    expect(adminScript).toContain('Your unsent booking proposal draft was kept');
    expect(adminScript).toContain('function proposalKeyFor(form, slots)');
  });

  it('never claims a delivery it cannot support', () => {
    expect(adminScript).toContain('Saved and queued — provider acceptance is not confirmed yet');
    expect(adminScript).toContain('Saved, but the provider did not confirm the email send');
    expect(adminScript).toContain('Reuses the same proposal — it cannot create a second one.');
    expect(adminScript).toContain('retry_proposal_notification');
  });

  it('shows Las Vegas dates with an explicit AM/PM on the owner side too', () => {
    expect(adminScript).toContain('function whenLong(iso)');
    expect(adminScript).toContain('hour12: true');
    expect(adminScript).toContain("timeZone: \"America/Los_Angeles\"");
    // Slate instants are built from a Las Vegas wall clock, DST included.
    expect(adminScript).toContain('function vegasInstant(dateStr, hhmm)');
    expect(adminScript).toContain('function vegasOffsetMinutes(atUtcMs)');
  });

  it('offers a whole slate of days and hours, not three fixed boxes', () => {
    expect(adminScript).toContain('function offerableDays(draftCfg)');
    expect(adminScript).toContain('function slateInstants(section, draftCfg)');
    expect(adminScript).toContain('var OFFER_HOURS =');
    expect(adminScript).toContain('data-slate="workday"');
    expect(adminScript).toContain('data-slate="afternoons"');
    // The old three-input picker is gone.
    expect(adminScript).not.toContain('pSlot');
    expect(adminScript).not.toContain('data-quickfill');
  });

  it('only offers days the business actually operates, past the notice period', () => {
    const start = adminScript.indexOf('function offerableDays(draftCfg)');
    const body = adminScript.slice(start, adminScript.indexOf('function slateInstants', start));
    expect(body).toContain('daysOfOperation');
    expect(body).toContain('leadHours(draftCfg)');
    expect(body).toContain('maxAdvanceDays');
  });

  it('treats a configured zero notice period as real, not as unset', () => {
    // `cfg.minLeadHours || 18` would silently restore an 18-hour rule the
    // owner had deliberately removed.
    expect(adminScript).toContain('function leadHours(draftCfg)');
    expect(adminScript).toContain('Number.isFinite(v) && v >= 0 ? v : 18');
    expect(adminScript).not.toMatch(/minLeadHours \|\| 18/u);
  });

  it('drops a slate time that stops clearing the notice period before Send', () => {
    const start = adminScript.indexOf('function slateInstants(section, draftCfg)');
    const body = adminScript.slice(start, start + 900);
    expect(body).toContain('floor');
    expect(body).toContain('lead * 3600000');
  });

  it('tells the owner exactly how many times will go out', () => {
    expect(adminScript).toContain(' will be offered.');
    expect(adminScript).toContain('No times selected yet');
  });
});

describe('customer portal — one journey, no dead end', () => {
  it('names the three booking steps', () => {
    expect(portalScript).toContain('var BOOKING_STEPS = ["Choose a time", "Review & accept", "Pay & confirm"]');
    expect(portalScript).toContain('function bookingStep(v)');
    expect(portalCss).toContain('.booking-step');
  });

  it('explains a quote that has no appointment times yet', () => {
    // This is the exact state the reported customer was stuck in.
    expect(portalScript).toContain('var awaitingTimes = step === 1 && offered.length === 0');
    expect(portalScript).toContain('Appointment times for this request haven’t been published yet.');
    expect(portalScript).toContain('Ask AutoClarity for times');
    expect(portalScript).toContain('Your price above is already confirmed and will not change.');
  });

  it('offers "none of these work" inside the existing message flow', () => {
    expect(portalScript).toContain('id="requestNewTimes"');
    expect(portalScript).toContain('could you send other appointment options?');
    expect(portalScript).toContain('action: "message"');
  });

  it('states travel as "Included" instead of hiding a missing line', () => {
    expect(portalScript).toContain('<tr><td>Mobile-service charge</td><td>Included</td></tr>');
    expect(portalScript).toContain('This is the exact amount you will be charged.');
  });

  it('shows weekday, date and an unmistakable AM/PM in Las Vegas time', () => {
    expect(portalScript).toContain('function fmtSlotLong(iso)');
    expect(portalScript).toContain('hour12: true');
    expect(portalScript).toContain('All times are Las Vegas time.');
  });

  it('binds the time buttons by data attribute, not by their class name', () => {
    // A rename once detached this handler and clicking a time did nothing.
    expect(portalScript).toContain('elContent.querySelectorAll("[data-slot]")');
    expect(portalScript).not.toContain('querySelectorAll(".slot-btn")');
    // Whatever the markup renders must carry the attribute the handler needs.
    const markup = portalScript.match(/<button type="button" class="slot-chip"[^']*/u)?.[0] ?? '';
    expect(markup).toContain('data-slot=');
  });

  it('groups a long slate of times by day instead of listing timestamps', () => {
    expect(portalScript).toContain('var byDay = []');
    expect(portalScript).toContain('slot-day-head');
    expect(portalScript).toContain('slot-chip');
    expect(portalScript).toContain('Only one of these becomes your appointment');
    expect(portalCss).toContain('.slot-day-group');
    expect(portalCss).toContain('.slot-chip');
  });

  it('never prechecks consent and keeps cancelling secondary', () => {
    expect(portalScript).toContain('<input type="checkbox" id="agree_');
    expect(portalScript).not.toMatch(/id="agree_[^"]*"\s+checked/u);
    expect(portalScript).toContain('<details class="portal-card portal-secondary"><summary>Need to cancel or reschedule?</summary>');
  });

  it('gives an expired offer a way forward instead of a dead page', () => {
    expect(portalScript).toContain('var offerStale = step === 1 && Boolean(v.quote && v.quote.expired) && !paidReselection');
    expect(portalScript).toContain('<h2>This offer has expired</h2>');
    expect(portalScript).toContain('Ask AutoClarity for a refreshed quote');
    expect(portalScript).toContain('Nothing has been charged');
  });

  it('tells the customer what happens after payment', () => {
    expect(portalScript).toContain('<dt>Amount paid</dt>');
    expect(portalScript).toContain('What happens next: AutoClarity arrives at the vehicle');
  });
});

describe('intake — package choice and price before submitting', () => {
  it('asks the server for the estimate rather than pricing in the browser', () => {
    expect(formScript).toContain('estimate: "/api/ppi/estimate"');
    expect(formScript).toContain('function refreshPackage()');
    expect(formScript).not.toMatch(/19900|29900|39900/u);
  });

  it('lets the customer correct the suggestion and explains a disagreement', () => {
    expect(formScript).toContain('Suggested for your vehicle');
    expect(formScript).toContain("input[name=\"packageTier\"]");
    expect(formScript).toContain('You picked a package below our suggestion.');
    expect(formScript).toContain('You picked a package above our suggestion.');
  });

  it('labels the number an estimate, not an offer', () => {
    expect(formScript).toContain('Estimated total');
    expect(formScript).toContain('data.disclaimer');
    expect(formScript).toContain('Submitting is free and charges nothing.');
  });

  it('asks what was modified only when it is relevant', () => {
    expect(formScript).toContain('function setupModDetails()');
    expect(formScript).toContain('Tell us briefly what was modified');
  });

  it('degrades honestly when the estimate cannot be fetched', () => {
    expect(formScript).toContain('function renderPackageFallback()');
    expect(formScript).toContain('Submitting still works');
  });
});

// A checkbox row is a two-column grid: the 22px box, then the content. Any
// third child lands under the checkbox in a 22px column and wraps one word
// per line. The error message already carried the fix; the $25 same-day hint
// shipped without it and rendered as a vertical column of single words on the
// live page. Anything placed in that row needs the same rule.
describe('checkbox rows keep their supporting text readable', () => {
  const css = readFileSync(new URL('../../assets/css/ppi.css', import.meta.url), 'utf8');

  it('puts every element after the label back in the content column', () => {
    const block = css.slice(css.indexOf('.field-check {'), css.indexOf('.vin-row'));
    expect(block).toMatch(/\.field-check\s*\{[^}]*grid-template-columns:\s*22px\s+1fr/u);
    for (const child of ['.field-error', '.field-hint']) {
      const rule = new RegExp(`\\.field-check\\s+\\${child}[^{]*\\{[^}]*grid-column:\\s*2`, 'u');
      const grouped = new RegExp(`\\.field-check\\s+\\${child},[\\s\\S]{0,80}?grid-column:\\s*2`, 'u');
      expect(rule.test(block) || grouped.test(block), `${child} must sit in column 2`).toBe(true);
    }
  });

  it('the same-day fee hint is inside a checkbox row, so the rule matters', () => {
    const page = readFileSync(new URL('../../las-vegas-pre-purchase-inspection/index.html', import.meta.url), 'utf8');
    const row = page.slice(page.indexOf('id="sameDayPriority"'));
    const end = row.indexOf('</div>');
    expect(row.slice(0, end)).toContain('class="field-hint"');
    expect(row.slice(0, end)).toContain('$25');
  });
});
