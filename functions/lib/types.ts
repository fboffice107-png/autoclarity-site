/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  /** Pages static-asset binding — used to serve HTML shells at dynamic routes. */
  ASSETS: Fetcher;

  // Mode switches (plain vars)
  PPI_ENV?: string; // 'preview' | 'production'
  PPI_MODE?: string; // 'waitlist' | 'request' | 'live'
  PAYMENTS_ENABLED?: string; // 'true' | 'false'
  STRIPE_ENV?: string; // 'test' | 'live'
  BOOKING_ENABLED?: string;
  UPLOADS_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  PUBLIC_BASE_URL?: string;
  /** Comma-separated origins allowed to call the public form APIs cross-origin
   *  (the static marketing site while it is hosted on GitHub Pages). */
  PUBLIC_FORM_ORIGINS?: string;
  SUPPORT_EMAIL?: string;

  // Secrets
  TURNSTILE_SECRET_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Test-only Stripe API override; ignored when PPI_ENV=production. */
  STRIPE_API_BASE?: string;
  RESEND_API_KEY?: string;
  /** Test-only Resend endpoint override; ignored when PPI_ENV=production. */
  RESEND_API_BASE?: string;
  EMAIL_FROM?: string;
  ADMIN_NOTIFY_EMAIL?: string;
  ADMIN_DEV_KEY?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

export type Ctx = EventContext<Env, string, Record<string, unknown>>;

export interface ModeFlags {
  env: 'preview' | 'production';
  mode: 'waitlist' | 'request' | 'live';
  paymentsEnabled: boolean;
  stripeEnv: 'test' | 'live';
  bookingEnabled: boolean;
  uploadsEnabled: boolean;
}

export function modeFlags(env: Env): ModeFlags {
  const ppiEnv = env.PPI_ENV === 'production' ? 'production' : 'preview';
  const rawMode = env.PPI_MODE ?? 'request';
  const mode = rawMode === 'waitlist' || rawMode === 'live' ? rawMode : 'request';
  return {
    env: ppiEnv,
    mode,
    paymentsEnabled: env.PAYMENTS_ENABLED === 'true',
    stripeEnv: env.STRIPE_ENV === 'live' ? 'live' : 'test',
    bookingEnabled: env.BOOKING_ENABLED !== 'false',
    uploadsEnabled: env.UPLOADS_ENABLED !== 'false',
  };
}
