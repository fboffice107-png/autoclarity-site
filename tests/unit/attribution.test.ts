import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_SOURCES, normalizeAttributionSource, parseIntake } from '../../functions/lib/validate.ts';

describe('privacy-minimized request attribution', () => {
  it('keeps only allowlisted source categories', () => {
    expect(normalizeAttributionSource('ppi_google_cpc')).toBe('ppi_google_cpc');
    expect(normalizeAttributionSource('PPI_SEARCH_ORGANIC')).toBe('ppi_search_organic');
    expect(normalizeAttributionSource('ppi_google_business_profile')).toBe('ppi_google_business_profile');
    expect(normalizeAttributionSource('ppi_ios_app')).toBe('ppi_ios_app');
    expect(normalizeAttributionSource('ppi_chatgpt_search')).toBe('ppi_chatgpt_search');
    expect(normalizeAttributionSource('ppi_direct')).toBe('ppi_direct');
  });

  it('leaves missing, raw, and fabricated attribution unknown', () => {
    for (const value of [undefined, '', 'chatgpt', 'ppi_chatgpt', 'ios_app', 'utm_source=ios_app&utm_medium=owned', 'ppi_google_social', 'ppi_fabricated_agent_paid<script>', 'https://example.com/path?q=vin', 'utm_source=google']) {
      expect(normalizeAttributionSource(value)).toBe('ppi_unknown');
    }
  });

  it('keeps a small explicit enum rather than a prefix pattern', () => {
    expect(new Set(ATTRIBUTION_SOURCES).size).toBe(ATTRIBUTION_SOURCES.length);
    expect(ATTRIBUTION_SOURCES.every((value) => /^ppi_[a-z_]+$/u.test(value))).toBe(true);
  });

  it('normalizes the category as part of server-side intake parsing', () => {
    const parsed = parseIntake({ attributionSource: 'ppi_bing_organic' });
    expect(parsed.payload.attributionSource).toBe('ppi_bing_organic');
  });

  it('fails closed on scan permission from a stale or crafted client', () => {
    const parsed = parseIntake({ permScan: true });
    expect(parsed.payload.permScan).toBe(false);
    expect(parsed.errors.permScan).toContain('not part');
  });
});
