// CORS allowlist for the public form APIs (GitHub Pages interim): only the
// configured marketing-site origins ever receive access-control headers, and
// preflights from anywhere else are refused.
import { describe, expect, it } from 'vitest';
import { corsHeaders, corsPreflight, formOrigins } from '../../functions/lib/cors.ts';
import { originAllowed } from '../../functions/lib/util.ts';
import type { Env } from '../../functions/lib/types.ts';

const env = {
  PUBLIC_BASE_URL: 'https://autoclarity-site.pages.dev',
  PUBLIC_FORM_ORIGINS: 'https://getautoclarity.com, https://www.getautoclarity.com',
} as Env;

const req = (origin: string | null, url = 'https://autoclarity-site.pages.dev/api/ppi/requests') =>
  new Request(url, { method: 'OPTIONS', headers: origin ? { origin } : {} });

describe('formOrigins', () => {
  it('parses and normalizes the comma-separated allowlist', () => {
    expect(formOrigins(env)).toEqual(['https://getautoclarity.com', 'https://www.getautoclarity.com']);
  });
  it('ignores malformed entries and empty config', () => {
    expect(formOrigins({ PUBLIC_FORM_ORIGINS: 'not a url,, ,https://ok.example' } as Env)).toEqual(['https://ok.example']);
    expect(formOrigins({} as Env)).toEqual([]);
  });
});

describe('corsHeaders', () => {
  it('echoes an allowlisted cross-origin caller', () => {
    const h = corsHeaders(req('https://getautoclarity.com'), env);
    expect(h['access-control-allow-origin']).toBe('https://getautoclarity.com');
    expect(h['vary']).toBe('origin');
  });
  it('emits nothing for same-origin, absent or foreign origins', () => {
    expect(corsHeaders(req(null), env)).toEqual({});
    expect(corsHeaders(req('https://autoclarity-site.pages.dev'), env)).toEqual({});
    expect(corsHeaders(req('https://evil.example'), env)).toEqual({});
  });
});

describe('corsPreflight', () => {
  it('answers 204 with methods/headers for an allowlisted origin', () => {
    const res = corsPreflight(req('https://www.getautoclarity.com'), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.getautoclarity.com');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });
  it('refuses foreign and missing origins', () => {
    expect(corsPreflight(req('https://evil.example'), env).status).toBe(403);
    expect(corsPreflight(req(null), env).status).toBe(403);
  });
});

describe('originAllowed with the form allowlist', () => {
  const postReq = (origin: string) =>
    new Request('https://autoclarity-site.pages.dev/api/ppi/requests', { method: 'POST', headers: { origin } });
  it('accepts the marketing-site origins for public submissions', () => {
    expect(originAllowed(postReq('https://getautoclarity.com'), env.PUBLIC_BASE_URL, formOrigins(env))).toBe(true);
    expect(originAllowed(postReq('https://www.getautoclarity.com'), env.PUBLIC_BASE_URL, formOrigins(env))).toBe(true);
  });
  it('still rejects anything not allowlisted', () => {
    expect(originAllowed(postReq('https://evil.example'), env.PUBLIC_BASE_URL, formOrigins(env))).toBe(false);
  });
});
