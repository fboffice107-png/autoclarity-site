// Single-domain canonicalization: www permanently redirects to the apex with
// path + query intact, and only the canonical production host is indexable —
// pages.dev (and any deployment alias) stays noindex even in production.
import { describe, expect, it } from 'vitest';
import { CANONICAL_HOST, canonicalHostRedirect, inspectionAliasRedirect, isNonCanonicalProductionHost } from '../../functions/lib/canonical.ts';

describe('canonicalHostRedirect', () => {
  it('301s www to the apex preserving path and query (incl. UTM + portal tokens)', () => {
    const res = canonicalHostRedirect(
      new URL('https://www.getautoclarity.com/ppi/portal/?t=abc123&utm_source=sms&utm_campaign=launch')
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(301);
    expect(res!.headers.get('location')).toBe(
      'https://getautoclarity.com/ppi/portal/?t=abc123&utm_source=sms&utm_campaign=launch'
    );
  });

  it('301s the www root to the apex root', () => {
    const res = canonicalHostRedirect(new URL('https://www.getautoclarity.com/'));
    expect(res!.status).toBe(301);
    expect(res!.headers.get('location')).toBe('https://getautoclarity.com/');
  });

  it('upgrades a www hit to https on the apex', () => {
    const res = canonicalHostRedirect(new URL('http://www.getautoclarity.com/las-vegas-pre-purchase-inspection/'));
    expect(res!.headers.get('location')).toBe('https://getautoclarity.com/las-vegas-pre-purchase-inspection/');
  });

  it('never matches the apex itself — no redirect loop is possible', () => {
    expect(canonicalHostRedirect(new URL(`https://${CANONICAL_HOST}/`))).toBeNull();
    expect(canonicalHostRedirect(new URL(`https://${CANONICAL_HOST}/ppi/?t=x`))).toBeNull();
  });

  it('leaves localhost dev and pages.dev untouched', () => {
    expect(canonicalHostRedirect(new URL('http://localhost:8788/'))).toBeNull();
    expect(canonicalHostRedirect(new URL('https://autoclarity-site.pages.dev/'))).toBeNull();
    expect(canonicalHostRedirect(new URL('https://bd27679d.autoclarity-site.pages.dev/'))).toBeNull();
  });

  it('does not touch unrelated hosts that merely contain www', () => {
    expect(canonicalHostRedirect(new URL('https://www.example.com/'))).toBeNull();
  });
});

describe('isNonCanonicalProductionHost', () => {
  it('treats only the apex as canonical', () => {
    expect(isNonCanonicalProductionHost(CANONICAL_HOST)).toBe(false);
  });
  it('flags pages.dev, deployment aliases, www and local dev as non-canonical', () => {
    expect(isNonCanonicalProductionHost('autoclarity-site.pages.dev')).toBe(true);
    expect(isNonCanonicalProductionHost('bd27679d.autoclarity-site.pages.dev')).toBe(true);
    expect(isNonCanonicalProductionHost('www.getautoclarity.com')).toBe(true);
    expect(isNonCanonicalProductionHost('localhost')).toBe(true);
  });
});

describe('inspectionAliasRedirect', () => {
  it('301s uppercase and mixed-case short aliases to the canonical inspection page', () => {
    for (const p of ['/PPI', '/Ppi/', '/PRE-PURCHASE-INSPECTION', '/Pre-Purchase-Inspection/']) {
      const res = inspectionAliasRedirect(new URL(`https://getautoclarity.com${p}`));
      expect(res, p).not.toBeNull();
      expect(res!.status).toBe(301);
      expect(res!.headers.get('location')).toBe('https://getautoclarity.com/las-vegas-pre-purchase-inspection/');
    }
  });

  it('preserves the query string', () => {
    const res = inspectionAliasRedirect(new URL('https://getautoclarity.com/PPI?utm_source=flyer&x=1'));
    expect(res!.headers.get('location')).toBe(
      'https://getautoclarity.com/las-vegas-pre-purchase-inspection/?utm_source=flyer&x=1'
    );
  });

  it('leaves lowercase forms to the static _redirects file', () => {
    expect(inspectionAliasRedirect(new URL('https://getautoclarity.com/ppi'))).toBeNull();
    expect(inspectionAliasRedirect(new URL('https://getautoclarity.com/pre-purchase-inspection/'))).toBeNull();
  });

  it('never touches the real /ppi/* routes in any casing', () => {
    for (const p of ['/ppi/admin/', '/PPI/admin/', '/ppi/portal/?t=x', '/PPI/PORTAL/', '/api/ppi/requests']) {
      expect(inspectionAliasRedirect(new URL(`https://getautoclarity.com${p}`)), p).toBeNull();
    }
  });
});
