import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../functions/lib/config.ts';
import { appointmentDateError, appointmentDays, sundayEligible, type SellerLocation } from '../../functions/lib/appointment-eligibility.ts';
import { validateSlotTimes } from '../../functions/lib/booking-proposal.ts';
import { DISCOVERY_OPTIONS, parseDiscovery, saveMissingDiscovery } from '../../functions/lib/discovery.ts';
import { parseIntake } from '../../functions/lib/validate.ts';
import { EMAIL_TEMPLATES } from '../../functions/lib/email.ts';

const privateHome = { seller_type: 'private', inspection_location_type: 'private_residence', perm_inspection: 1 };
const sunday = new Date('2026-10-04T20:00:00Z'); // 1 PM in Los Angeles
const config = () => structuredClone(DEFAULT_CONFIG);

describe('one explicit Sunday eligibility rule', () => {
  it('requires private seller, residence, and inspection permission independently', () => {
    expect(sundayEligible(privateHome)).toBe(true);
    for (const request of [{}, { ...privateHome, seller_type: null }, { ...privateHome, seller_type: 'unknown' },
      { ...privateHome, seller_type: 'dealership', dealership_name: '' }, { ...privateHome, seller_type: 'other' },
      { ...privateHome, inspection_location_type: null }, { ...privateHome, inspection_location_type: 'other' },
      { ...privateHome, inspection_location_type: 'unknown' }, { ...privateHome, perm_inspection: 0 }]) {
      expect(sundayEligible(request)).toBe(false);
      expect(appointmentDateError(sunday, config(), request)).toContain('Sunday');
    }
    expect(sundayEligible({ ...privateHome, dealership_name: 'stale name' } as SellerLocation)).toBe(true);
  });
  it('never opens dealership Sundays even if Sunday is in global operating days', () => {
    const c = config(); c.scheduling.daysOfOperation = [0, 1, 3, 4, 5, 6];
    expect(appointmentDays(c, { seller_type: 'dealership' })).toEqual([1, 3, 4, 5, 6]);
    expect(appointmentDays(c, privateHome)).toEqual([0, 1, 3, 4, 5, 6]);
    expect(appointmentDateError(new Date('2026-10-06T20:00:00Z'), c, privateHome)).toContain('operating');
    expect(appointmentDateError(new Date('2026-10-05T20:00:00Z'), c, privateHome)).toBeNull();
    expect(appointmentDateError(new Date('2026-10-06T20:00:00Z'), config(), privateHome)).toBeNull();
  });
  it('uses the business-local Sunday across UTC Monday and both DST boundaries', () => {
    for (const iso of ['2026-10-05T00:00:00Z', '2026-11-02T00:00:00Z', '2027-03-15T00:00:00Z']) {
      expect(appointmentDateError(new Date(iso), config(), privateHome)).toBeNull();
      expect(appointmentDateError(new Date(iso), config(), { seller_type: 'dealership' })).toContain('Sunday');
    }
    expect(appointmentDateError(new Date('2026-10-05T07:00:00Z'), config(), { seller_type: 'dealership' })).toBeNull();
  });
  it('keeps blackouts on eligible Sundays', () => {
    const c = config(); c.scheduling.blackoutDates = ['2026-10-04'];
    expect(appointmentDateError(sunday, c, privateHome)).toContain('blacked out');
  });
  it('preserves lead time, window, duration, occupancy and buffers in shared offer validation', async () => {
    let occupied = false; const bounds: unknown[][] = [];
    const db = { prepare(sql: string) { return { bind(...values: unknown[]) {
      if (sql.includes('appointment_slots')) bounds.push(values);
      return { async first() { return sql.includes('FROM ppi_requests') ? privateHome : occupied ? { id: 'busy' } : null; } };
    } }; } } as unknown as D1Database;
    const c = config(); c.scheduling.minLeadHours = 2;
    const now = Date.parse('2026-10-03T19:00:00Z');
    const result = await validateSlotTimes(db, 'old-request', [sunday.toISOString()], c, now);
    expect(result.valid).toEqual([{ startsAt: '2026-10-04T20:00:00.000Z', endsAt: '2026-10-04T22:00:00.000Z', blockedStartsAt: '2026-10-04T19:15:00.000Z', blockedEndsAt: '2026-10-04T23:00:00.000Z' }]);
    expect(bounds[0]).toEqual(['2026-10-04T23:00:00.000Z', '2026-10-04T19:15:00.000Z']);
    occupied = true;
    expect((await validateSlotTimes(db, 'old-request', [sunday.toISOString()], c, now)).skipped[0]).toContain('buffers');
    occupied = false;
    expect((await validateSlotTimes(db, 'old-request', ['2026-10-03T20:00:00Z', '2026-12-06T20:00:00Z'], c, now)).valid).toHaveLength(0);
    c.scheduling.blackoutDates = ['2026-10-04'];
    expect((await validateSlotTimes(db, 'old-request', [sunday.toISOString()], c, now)).valid).toHaveLength(0);
  });
});

describe('optional customer-reported discovery', () => {
  it('does not fabricate blank or unknown answers and ignores irrelevant details', () => {
    for (const value of [undefined, null, '', 'search', '<script>', {}, ['google_search']]) expect(parseDiscovery(value, 'text')).toEqual({ source: null, detail: null });
    expect(parseDiscovery('google_search', 'hidden old detail')).toEqual({ source: 'google_search', detail: null });
    expect(parseDiscovery('instagram', '  a video\nby @creator  ')).toEqual({ source: 'instagram', detail: 'a video by @creator' });
    expect(parseDiscovery('other', 'x'.repeat(900)).detail).toHaveLength(500);
    for (const option of DISCOVERY_OPTIONS) expect(parseDiscovery(option.value, '').source).toBe(option.value);
  });
  it('requires explicit seller choice without requiring dealership name or discovery', () => {
    expect(parseIntake({}).errors.sellerType).toBeTruthy();
    expect(parseIntake({ sellerType: 'invented' }).errors.sellerType).toBeTruthy();
    for (const sellerType of ['dealership', 'private', 'unknown']) {
      const p = parseIntake({ sellerType, dealershipName: 'hidden name', discoverySource: '' });
      expect(p.errors.sellerType).toBeUndefined();
      expect(p.payload.discoverySource).toBeNull();
      expect(p.payload.dealershipName).toBe(sellerType === 'dealership' ? 'hidden name' : '');
    }
    expect(parseIntake({ sellerType: 'private' }).payload.inspectionLocationType).toBeNull();
  });
  it('skips blank writes and atomically protects an already saved answer', async () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const db = { prepare(sql: string) { return { bind(...args: unknown[]) { return { async run() { writes.push({ sql, args }); } }; } }; } } as unknown as D1Database;
    await saveMissingDiscovery(db, 'old-request', '', ''); expect(writes).toHaveLength(0);
    await saveMissingDiscovery(db, 'old-request', 'other', '<img onerror="x">');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("discovery_source IS NULL OR discovery_source = ''");
    expect(writes[0]?.args[1]).toBe('<img onerror="x">');
  });
  it('adds supplied information only to the existing owner notification', () => {
    const ctx = { ref: 'TEST', supportEmail: 'support@example.com', extra: { dealership: 'Example Motors', discovery: 'Instagram video or post — @creator' } };
    expect(EMAIL_TEMPLATES.owner_new_request(ctx).text).toContain('Discovery (customer-reported): Instagram video or post — @creator');
    expect(EMAIL_TEMPLATES.owner_new_request(ctx).text).toContain('Dealership name: Example Motors');
    expect(EMAIL_TEMPLATES.owner_new_request({ ...ctx, extra: {} }).text).not.toContain('Discovery');
    expect(EMAIL_TEMPLATES.request_received(ctx).text).not.toContain('Discovery');
  });
});
