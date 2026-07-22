import { describe, expect, it } from 'vitest';
import { timingSafeEqual, toCents, formatCents, newRef, originAllowed, clampStr } from '../../functions/lib/util.ts';
import { buildIcs } from '../../functions/lib/ics.ts';
import { haversineMiles, estimateMilesFromZip, knownZip } from '../../functions/lib/zips.ts';
import { normalizePhone, validEmail, oneOf, intInRange } from '../../functions/lib/validate.ts';

describe('timingSafeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });
});

describe('money parsing', () => {
  it('parses dollars into cents defensively', () => {
    expect(toCents('$12,500')).toBe(1250000);
    expect(toCents('199.99')).toBe(19999);
    expect(toCents('')).toBeNull();
    expect(toCents('abc')).toBeNull();
    expect(toCents('-5')).toBeNull();
    expect(toCents('99999999999')).toBeNull();
  });
  it('formats cents', () => {
    expect(formatCents(19900)).toBe('$199.00');
  });
});

describe('request references', () => {
  it('generates the PPI-YYMMDD-XXXX shape without ambiguous characters', () => {
    const ref = newRef(new Date('2026-07-21T00:00:00Z'));
    expect(ref).toMatch(/^PPI-260721-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  });
});

describe('originAllowed', () => {
  const req = (origin: string | null, url = 'https://preview.pages.dev/api/x') =>
    new Request(url, { headers: origin ? { origin } : {} });

  it('allows same-origin and configured base URL', () => {
    expect(originAllowed(req('https://preview.pages.dev'), undefined)).toBe(true);
    expect(originAllowed(req('https://getautoclarity.com'), 'https://getautoclarity.com')).toBe(true);
  });
  it('allows non-browser clients (no Origin header)', () => {
    expect(originAllowed(req(null), undefined)).toBe(true);
  });
  it('rejects foreign origins', () => {
    expect(originAllowed(req('https://evil.example'), 'https://getautoclarity.com')).toBe(false);
  });
});

describe('clampStr', () => {
  it('trims and truncates', () => {
    expect(clampStr('  hello  ', 3)).toBe('hel');
    expect(clampStr(null, 5)).toBe('');
  });
});

describe('ics generation', () => {
  it('escapes and formats an event', () => {
    const ics = buildIcs({
      uid: 'PPI-260721-TEST',
      startsAtIso: '2026-07-24T16:00:00.000Z',
      endsAtIso: '2026-07-24T18:00:00.000Z',
      summary: 'AutoClarity PPI; test, event',
      description: 'Line1\nLine2',
      location: '123 Main St, Las Vegas, NV',
    });
    expect(ics).toContain('DTSTART:20260724T160000Z');
    expect(ics).toContain('SUMMARY:AutoClarity PPI\\; test\\, event');
    expect(ics).toContain('DESCRIPTION:Line1\\nLine2');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
  });
});

describe('zips', () => {
  it('haversine sanity: LV to Henderson ~10-16 straight-line miles', () => {
    const d = haversineMiles(36.1147, -115.1728, 36.0397, -114.9819);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(20);
  });
  it('knows core ZIPs and rejects unknowns', () => {
    expect(knownZip('89109')).toBe(true);
    expect(knownZip('10001')).toBe(false);
    expect(estimateMilesFromZip('10001', 36.1147, -115.1728)).toBeNull();
  });
});

describe('validate primitives', () => {
  it('normalizes US phones', () => {
    expect(normalizePhone('(702) 555-0100')).toBe('7025550100');
    expect(normalizePhone('1-702-555-0100')).toBe('7025550100');
    expect(normalizePhone('555-0100')).toBeNull();
  });
  it('validates emails', () => {
    expect(validEmail('a@b.co')).toBe(true);
    expect(validEmail('nope')).toBe(false);
  });
  it('enum + int guards', () => {
    expect(oneOf('phone', ['email', 'phone'] as const, 'email')).toBe('phone');
    expect(oneOf('hack', ['email', 'phone'] as const, 'email')).toBe('email');
    expect(intInRange('2020', 1920, 2030)).toBe(2020);
    expect(intInRange('1900', 1920, 2030)).toBeNull();
    expect(intInRange('2.5', 1, 10)).toBeNull();
  });
});
