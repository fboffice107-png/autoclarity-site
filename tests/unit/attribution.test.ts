import { describe, expect, it } from 'vitest';
import { normalizeAttributionSource, parseIntake } from '../../functions/lib/validate.ts';

describe('privacy-minimized request attribution', () => {
  it('keeps only allowlisted source categories', () => {
    expect(normalizeAttributionSource('ppi_google_cpc')).toBe('ppi_google_cpc');
    expect(normalizeAttributionSource('PPI_SEARCH_ORGANIC')).toBe('ppi_search_organic');
    expect(normalizeAttributionSource('ppi_direct')).toBe('ppi_direct');
  });

  it('leaves missing, raw, and fabricated AI attribution unknown', () => {
    for (const value of [undefined, '', 'chatgpt', 'ppi_chatgpt', 'https://example.com/path?q=vin', 'utm_source=google']) {
      expect(normalizeAttributionSource(value)).toBe('ppi_unknown');
    }
  });

  it('normalizes the category as part of server-side intake parsing', () => {
    const parsed = parseIntake({ attributionSource: 'ppi_bing_organic' });
    expect(parsed.payload.attributionSource).toBe('ppi_bing_organic');
  });
});
