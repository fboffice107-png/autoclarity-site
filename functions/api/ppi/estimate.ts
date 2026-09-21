// POST /api/ppi/estimate — what will this cost, before I submit anything?
//
// Deliberately server-side: the intake page could add up three numbers itself,
// but then the price a customer reads would come from different code than the
// price Stripe charges. This endpoint runs the SAME classifier and the SAME
// price math as the admin proposal and the checkout revalidation, so the $199
// on the form is the $199 on the invoice.
//
// It stores nothing, creates nothing, and is explicitly labelled an estimate —
// not an offer. Only a quote the owner sends is an offer.

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { getConfig } from '../../lib/config.ts';
import { suggestTier, isTier, tierMismatch, type Tier } from '../../lib/vehicle-class.ts';
import { estimateTravel } from '../../lib/pricing.ts';
import { buildPriceBreakdown } from '../../lib/quote-math.ts';
import { rateLimit } from '../../lib/ratelimit.ts';
import { clampStr, clientIp, errorJson, json, originAllowed } from '../../lib/util.ts';
import { readJsonBody, requestBodyErrorResponse } from '../../lib/request-body.ts';
import { oneOf, intInRange } from '../../lib/validate.ts';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  if (!originAllowed(request, env.PUBLIC_BASE_URL)) {
    return errorJson('bad_origin', 'Cross-origin requests are not accepted.', 403);
  }
  if (modeFlags(env).mode === 'waitlist') {
    return errorJson('waitlist_mode', 'Inspection requests are not open yet.', 409);
  }

  // Generous: this fires as the customer types a ZIP. It is read-only and
  // stores nothing, so the limit only needs to stop automated scraping.
  const limited = await rateLimit(env.DB, clientIp(request), 'ppi_estimate', 120, 3600);
  if (!limited.allowed) {
    return errorJson('rate_limited', 'Too many price checks from this connection. Please try again shortly.', 429);
  }

  let raw: Record<string, unknown>;
  try {
    raw = await readJsonBody<Record<string, unknown>>(request);
  } catch (error) {
    return requestBodyErrorResponse(error);
  }

  const config = await getConfig(env.DB);

  const suggestion = suggestTier({
    year: intInRange(raw['year'], 1920, new Date().getFullYear() + 2),
    make: clampStr(raw['make'], 60),
    model: clampStr(raw['model'], 80),
    trim: clampStr(raw['trim'], 80),
    modStatus: oneOf(raw['modStatus'], ['stock', 'light', 'heavy'] as const, 'stock'),
    modDetails: clampStr(raw['modDetails'], 600),
    titleStatus: oneOf(raw['titleStatus'], ['clean', 'salvage_rebuilt', 'unknown'] as const, 'unknown'),
    startsDrives: oneOf(raw['startsDrives'], ['yes', 'no', 'unknown'] as const, 'unknown'),
  });

  const requestedTier = raw['selectedTier'];
  const chosenTier: Tier = isTier(requestedTier) ? requestedTier : suggestion.tier;
  const mismatch = tierMismatch(suggestion.tier, chosenTier);

  const zip = clampStr(raw['locZip'], 10);
  const travelKnown = /^\d{5}$/u.test(zip);
  const travel = travelKnown ? estimateTravel(zip, config) : null;

  const breakdown = buildPriceBreakdown({
    tier: chosenTier,
    config,
    travelMiles: travel?.miles ?? null,
    travelBasis: travel?.basis ?? 'unknown',
  });

  return json({
    ok: true,
    // Said plainly, and repeated in the UI: this is not a price we are bound to.
    kind: 'estimate',
    disclaimer: 'This is an estimate based on what you have entered. AutoClarity confirms the exact price in your booking proposal before you accept or pay.',
    suggestedTier: suggestion.tier,
    selectedTier: chosenTier,
    customerReason: suggestion.customerReason,
    customerNotes: suggestion.customerNotes,
    needsReview: suggestion.manualReview || Boolean(mismatch),
    mismatch: mismatch ? { direction: mismatch.direction } : null,
    tiers: (['standard', 'euro_luxury_performance', 'exotic_collector'] as const).map((key) => ({
      key,
      label: config.pricing.tiers[key].label,
      blurb: config.pricing.tiers[key].blurb,
      priceCents: buildPriceBreakdown({ tier: key, config, travelMiles: travel?.miles ?? null, travelBasis: travel?.basis ?? 'unknown' }).baseCents,
    })),
    travel: travelKnown
      ? {
          miles: breakdown.travel.miles,
          feeCents: breakdown.travel.feeCents,
          bandLabel: breakdown.travel.bandLabel,
          basisLabel: breakdown.travel.basisLabel,
          included: breakdown.travel.included,
          customReviewRequired: breakdown.travel.customReviewRequired,
        }
      : null,
    lines: breakdown.lines.map((line) => ({ kind: line.kind, label: line.label, display: line.display, amountCents: line.amountCents })),
    totalCents: breakdown.totalCents,
  });
};
