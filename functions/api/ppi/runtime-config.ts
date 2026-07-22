// Public runtime configuration for the landing page and form:
// mode flags, Turnstile site key, customer-facing pricing display, scan scope,
// and the (config-gated) urgent contact path. Nothing sensitive here, ever.

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { getConfig, tierDisplayPrice, launchActive } from '../../lib/config.ts';
import { json } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const flags = modeFlags(context.env);
  const config = await getConfig(context.env.DB);
  const tierKeys = ['standard', 'euro_luxury_performance', 'exotic_collector'] as const;

  // Only surface a phone number if it is actually configured — never invent one.
  const phone = config.contact.businessPhone;
  const contactConfigured = typeof phone === 'string' && phone.trim().length >= 10;

  return json(
    {
      mode: flags.mode,
      bookingEnabled: flags.bookingEnabled,
      uploadsEnabled: flags.uploadsEnabled,
      paymentsEnabled: flags.paymentsEnabled,
      turnstileSiteKey: context.env.TURNSTILE_SITE_KEY ?? '1x00000000000000000000AA',
      supportEmail: config.supportEmail,
      scanIncluded: config.scan.included,
      reviews: config.reviews.enabled && config.reviews.items.length > 0
        ? config.reviews.items.slice(0, 12)
        : [],
      launchActive: launchActive(config),
      pricing: {
        tiers: tierKeys.map((key) => {
          const t = config.pricing.tiers[key];
          const disp = tierDisplayPrice(config, key);
          return {
            key,
            label: t.label,
            priceCents: disp.priceCents,
            wasCents: disp.wasCents,
            startingAt: disp.startingAt,
            blurb: t.blurb,
          };
        }),
      },
      fees: {
        sameDayPriorityCents: config.fees.sameDayPriorityCents,
        liftFacilityCents: config.fees.liftFacilityCents,
      },
      travel: {
        bands: config.travel.bands,
        customBeyondMiles: config.travel.customBeyondMiles,
      },
      uploads: { maxFiles: config.uploads.maxFiles, maxBytes: config.uploads.maxBytes, allowedTypes: config.uploads.allowedTypes },
      contact: contactConfigured
        ? {
            configured: true,
            phone: phone,
            callEnabled: config.contact.callEnabled,
            smsEnabled: config.contact.smsEnabled,
            urgentCtaEnabled: config.contact.urgentCtaEnabled,
          }
        : { configured: false },
    },
    200,
    { 'cache-control': 'no-store' },
  );
};
