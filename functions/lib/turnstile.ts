// Cloudflare Turnstile server-side verification — mandatory on public forms.
// Fail-closed in production; in preview/local, missing secret falls back to
// Cloudflare's official always-pass TEST secret so local dev works without
// real keys (documented in docs/PPI_CLOUDFLARE_SETUP.md).

const TEST_SECRET_ALWAYS_PASS = '1x0000000000000000000000000000000AA';

export interface TurnstileResult {
  ok: boolean;
  errorCodes: string[];
}

export async function verifyTurnstile(
  secret: string | undefined,
  isProduction: boolean,
  token: string,
  remoteIp: string,
): Promise<TurnstileResult> {
  let effectiveSecret = secret;
  if (!effectiveSecret) {
    if (isProduction) return { ok: false, errorCodes: ['server-misconfigured'] };
    effectiveSecret = TEST_SECRET_ALWAYS_PASS;
  }
  if (!token) return { ok: false, errorCodes: ['missing-input-response'] };
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: effectiveSecret, response: token, remoteip: remoteIp }),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return { ok: false, errorCodes: [`http-${res.status}`] };
    const body = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    return { ok: body.success === true, errorCodes: body['error-codes'] ?? [] };
  } catch {
    return { ok: false, errorCodes: ['verification-unreachable'] };
  }
}
