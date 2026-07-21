// Public runtime configuration for the landing page and form:
// mode flags, Turnstile site key, and customer-facing pricing display.
// Nothing sensitive belongs in this response, ever.

import type { Env } from '../../lib/types.ts';
import { modeFlags } from '../../lib/types.ts';
import { getConfig, promoActive } from '../../lib/config.ts';
import { json } from '../../lib/util.ts';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const flags = modeFlags(context.env);
  const config = await getConfig(context.env.DB);
  const promo = promoActive(config);

  return json(
    {
      mode: flags.mode,
      bookingEnabled: flags.bookingEnabled,
      uploadsEnabled: flags.uploadsEnabled,
      paymentsEnabled: flags.paymentsEnabled,
      turnstileSiteKey: context.env.TURNSTILE_SITE_KEY ?? '1x00000000000000000000AA',
      supportEmail: config.supportEmail,
      pricing: {
        tiers: Object.values(config.pricing.tiers).map((t) => ({
          key: t.key,
          label: t.label,
          priceCents: t.priceCents,
          blurb: t.blurb,
        })),
        promo: promo
          ? { label: config.pricing.promo.label, priceCents: config.pricing.promo.priceCents, endsAt: config.pricing.promo.endsAt }
          : null,
      },
      travel: {
        bands: config.travel.bands,
        customBeyondMiles: config.travel.customBeyondMiles,
      },
      uploads: { maxFiles: config.uploads.maxFiles, maxBytes: config.uploads.maxBytes, allowedTypes: config.uploads.allowedTypes },
    },
    200,
    { 'cache-control': 'no-store' },
  );
};
