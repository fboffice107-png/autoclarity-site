import { describe, expect, it } from 'vitest';
import { normalizeVin, validateVin } from '../../functions/lib/vin.ts';

describe('VIN normalization', () => {
  it('uppercases and strips separators', () => {
    expect(normalizeVin(' 1m8gd-m9a xkp042788 ')).toBe('1M8GDM9AXKP042788');
  });
});

describe('VIN validation', () => {
  it('accepts a canonical valid VIN with correct check digit', () => {
    const v = validateVin('1M8GDM9AXKP042788');
    expect(v.ok).toBe(true);
    expect(v.checkDigitValid).toBe(true);
  });

  it('accepts the all-ones test VIN (check digit 1)', () => {
    const v = validateVin('11111111111111111');
    expect(v.ok).toBe(true);
    expect(v.checkDigitValid).toBe(true);
  });

  it('flags a wrong check digit but does not hard-fail (non-NA VINs exist)', () => {
    const v = validateVin('1M8GDM9A1KP042788');
    expect(v.ok).toBe(true);
    expect(v.checkDigitValid).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(validateVin('ABC123').ok).toBe(false);
    expect(validateVin('1M8GDM9AXKP0427888').ok).toBe(false);
  });

  it('rejects I, O and Q', () => {
    expect(validateVin('1M8GDM9AXKP04278O').ok).toBe(false);
    expect(validateVin('IM8GDM9AXKP042788').ok).toBe(false);
    expect(validateVin('QM8GDM9AXKP042788').ok).toBe(false);
  });
});
