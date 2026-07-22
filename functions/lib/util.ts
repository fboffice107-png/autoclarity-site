export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

// Human-friendly reference, e.g. PPI-260721-K4TQ. Alphabet omits 0/O/1/I.
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newRef(date = new Date()): string {
  const ymd =
    String(date.getUTCFullYear()).slice(2) +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0');
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let suffix = '';
  for (const b of bytes) suffix += REF_ALPHABET[b % REF_ALPHABET.length];
  return `PPI-${ymd}-${suffix}`;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorJson(code: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code, message, ...extra } }, status);
}

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(raw);
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// Constant-time comparison for equal-length strings (hex/base64url tokens).
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function clampStr(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

export function toCents(dollars: unknown): number | null {
  const cleaned = String(dollars ?? '').replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return null;
  return Math.round(n * 100);
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? '0.0.0.0';
}

/** Reject cross-origin mutations. Same-origin or configured base URL only. */
export function originAllowed(request: Request, publicBaseUrl: string | undefined): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients (tests, curl) — auth still applies
  const requestOrigin = new URL(request.url).origin;
  if (origin === requestOrigin) return true;
  if (publicBaseUrl) {
    try {
      if (origin === new URL(publicBaseUrl).origin) return true;
    } catch {
      /* invalid configured URL — fall through */
    }
  }
  return false;
}
