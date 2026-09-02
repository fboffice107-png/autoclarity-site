/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;

  // Mode switches (plain vars)
  PPI_ENV?: string; // 'preview' | 'production'
  PPI_MODE?: string; // 'waitlist' | 'request' | 'live'
  PAYMENTS_ENABLED?: string; // 'true' | 'false'
  STRIPE_ENV?: string; // 'test' | 'live'
  BOOKING_ENABLED?: string;
  UPLOADS_ENABLED?: string;
  SMS_ENABLED?: string; // disabled unless explicitly true and a queue is bound
  TURNSTILE_SITE_KEY?: string;
  PUBLIC_BASE_URL?: string;
  SUPPORT_EMAIL?: string;

  // Secrets
  TURNSTILE_SECRET_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Test-only Stripe API override; ignored when PPI_ENV=production. */
  STRIPE_API_BASE?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ADMIN_NOTIFY_EMAIL?: string;
  ADMIN_DEV_KEY?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;

  // Optional provider-neutral transactional SMS handoff. No consumer/provider
  // is shipped; production remains email-only unless this is later bound.
  SMS_QUEUE?: Queue<import('./sms.ts').TransactionalSmsJob>;
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
  const stripeEnv = env.STRIPE_ENV === 'live' ? 'live' : 'test';
  const requestedPayments = env.PAYMENTS_ENABLED === 'true';
  const keyMatchesEnvironment = stripeEnv === 'live'
    ? env.STRIPE_SECRET_KEY?.startsWith('sk_live_') === true
    : env.STRIPE_SECRET_KEY?.startsWith('sk_test_') === true;

  // Production Checkout is exposed only when every launch control agrees.
  // Preview remains able to exercise test-mode Checkout in request/live modes,
  // but a live key is never effective outside the explicit production tuple.
  const paymentsEnabled = requestedPayments && keyMatchesEnvironment && (
    ppiEnv === 'production'
      ? mode === 'live' && stripeEnv === 'live'
      : stripeEnv === 'test'
  );
  return {
    env: ppiEnv,
    mode,
    paymentsEnabled,
    stripeEnv,
    bookingEnabled: env.BOOKING_ENABLED !== 'false',
    uploadsEnabled: env.UPLOADS_ENABLED !== 'false',
  };
}
