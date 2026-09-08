/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import sourceRaw from '../../scripts/public-facts.json?raw';
import catalogRaw from '../../autoclarity-services.json?raw';
import llms from '../../llms.txt?raw';
import home from '../../index.html?raw';
import ppi from '../../las-vegas-pre-purchase-inspection/index.html?raw';
import robots from '../../robots.txt?raw';
import sitemap from '../../sitemap.xml?raw';
import headers from '../../_headers?raw';
import indexNowKey from '../../170f59a6dd75523c8f9318a7ae04ae2e.txt?raw';
import indexNowScript from '../../scripts/submit-indexnow.mjs?raw';
import { DEFAULT_CONFIG } from '../../functions/lib/config.ts';

type Json = Record<string, any>;

function jsonLd(page: string): Json[] {
  return [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)]
    .map((match) => JSON.parse(match[1]!) as Json);
}

function publicText(): string {
  return [home, ppi, catalogRaw, llms].join('\n');
}

describe('reviewed public fact projection', () => {
  const source = JSON.parse(sourceRaw) as Json;
  const catalog = JSON.parse(catalogRaw) as Json;

  it('publishes exactly two clearly separated offerings from one dated source', () => {
    expect(source.lastReviewedAt).toBe('2026-09-07');
    expect(catalog.lastReviewedAt).toBe(source.lastReviewedAt);
    expect(catalog).not.toHaveProperty('verifiedAt');
    expect(catalog.offerings).toHaveLength(2);
    expect(catalog.offerings.map((item: Json) => item.type)).toEqual(['mobile_application', 'service']);
    expect(catalog.relationship).toContain('separate products');
    expect(catalog.relationship).toContain('does not include a physical inspection');
  });

  it('answers the app acceptance questions without expanding the verified storefront', () => {
    const app = catalog.offerings.find((item: Json) => item.id === 'autoclarity-app');
    expect(app.bestFor).toContain('Drivers');
    expect(app.summary).toContain('possible causes');
    expect(app.summary).toContain('urgency and safety');
    expect(app.summary).toContain('shareable report');
    expect(app.summary).toContain('without requiring an OBD scanner');
    expect(app.pricing.includedCompletedReports).toBe(1);
    expect(app.pricing.introductoryPrice).toBe(9.99);
    expect(app.pricing.renewalPrice).toBe(29.99);
    expect(app.pricing).not.toHaveProperty('introductoryOfferStarts');
    expect(app.pricing).not.toHaveProperty('introductoryOfferEnds');
    expect(app.pricing.introductoryEligibility).toContain('Eligible new subscribers in the United States');
    expect(app.limitations.join(' ')).toContain('Only the United States App Store listing was verified');
    expect(app.nextStep).toContain('App Store listing');
  });

  it('answers the inspection acceptance questions with exact qualified prices and travel bands', () => {
    const service = catalog.offerings.find((item: Json) => item.id === 'las-vegas-pre-purchase-inspection');
    expect(service.bestFor).toContain('Used-car buyers');
    expect(service.pricing.startingPrices.map((tier: Json) => tier.amount)).toEqual([199, 299, 399]);
    expect(service.pricing.startingPrices.every((tier: Json) => tier.qualification.includes('Starting price'))).toBe(true);
    expect(service.serviceArea.places).toEqual([
      'Las Vegas', 'North Las Vegas', 'Henderson', 'Boulder City',
    ]);
    expect(service.serviceArea.travelBands.map((band: Json) => [band.distance, band.fee])).toEqual([
      ['0–15 miles', 0], ['16–25 miles', 25], ['26–40 miles', 50], ['Beyond 40 miles', null],
    ]);
    expect(service.limitations.join(' ')).toContain('A submitted request is not an appointment');
    expect(service.limitations.join(' ')).toContain('not a warranty');
    expect(service.limitations.join(' ')).toContain('app subscription does not include this physical inspection');
    expect(service.nextStep).toContain('Submit the inspection request form');
  });

  it('matches the public inspection snapshot to the application defaults verified during the audit', () => {
    expect(source.ppi.startingPrices.map((tier: Json) => tier.amount * 100)).toEqual([
      DEFAULT_CONFIG.pricing.tiers.standard.priceCents,
      DEFAULT_CONFIG.pricing.tiers.euro_luxury_performance.priceCents,
      DEFAULT_CONFIG.pricing.tiers.exotic_collector.priceCents,
    ]);
    expect(source.ppi.serviceArea.travelBands.slice(0, 3).map((band: Json) => band.fee * 100)).toEqual(
      DEFAULT_CONFIG.travel.bands.map((band) => band.feeCents),
    );
    expect(source.ppi.serviceArea.travelBands.at(-1).distance).toContain(String(DEFAULT_CONFIG.travel.customBeyondMiles));
  });

  it('keeps visible copy, JSON-LD, JSON, and llms.txt aligned', () => {
    expect(home).toContain('One successfully completed report is free');
    expect(home).toContain('$9.99 for the first year, then $29.99/year unless canceled');
    expect(ppi).toContain('0–15 miles is included, 16–25 miles adds $25, 26–40 miles adds $50');
    expect(ppi).toContain('app subscription include an in-person inspection');

    const homeGraph = jsonLd(home)[0]!['@graph'] as Json[];
    expect(homeGraph.map((node) => node['@type'])).toEqual(['Organization', 'MobileApplication']);
    const app = homeGraph.find((node) => node['@type'] === 'MobileApplication')!;
    expect(app.offers.map((item: Json) => Number(item.price))).toEqual([0, 9.99, 29.99]);
    expect(app.offers.every((item: Json) => !('priceValidUntil' in item))).toBe(true);
    const ppiBlocks = jsonLd(ppi);
    expect(ppiBlocks).toHaveLength(3);
    const service = ppiBlocks[0]!['@graph'].find((node: Json) => node['@type'] === 'Service');
    expect(service.offers.map((item: Json) => Number(item.priceSpecification.price))).toEqual([199, 299, 399]);
    expect(service.offers.every((item: Json) => item.description.includes('Starting price'))).toBe(true);
    expect(service.provider['@id']).toBe('https://getautoclarity.com/#organization');
    expect(ppiBlocks[1]!['@type']).toBe('FAQPage');
    expect(ppiBlocks[2]!['@type']).toBe('BreadcrumbList');
  });

  it('does not publish fabricated capabilities, private paths, or unsupported entity claims', () => {
    const text = publicText();
    expect(text).not.toMatch(/available everywhere|worldwide|android|image diagnosis/iu);
    expect(catalogRaw).not.toMatch(/\/api\/|\/ppi\/portal|\/ppi\/admin|utm_|customer[_ -]?(name|email|phone)/iu);
    expect(llms).not.toMatch(/\/api\/|\/ppi\/portal|\/ppi\/admin|utm_/iu);
    expect(text).not.toMatch(/aggregateRating|reviewCount|LocalBusiness|AutoRepair/iu);
  });

  it('tracks every App Store outbound link as a click, not an install or purchase', () => {
    for (const page of [home, ppi]) {
      const links = [...page.matchAll(/<a\b[^>]*href="https:\/\/apps\.apple\.com\/us\/app\/autoclarity\/id6761438602"[^>]*>/gu)];
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((link) => link[0].includes('data-analytics="app_store_outbound_click"'))).toBe(true);
    }
  });
});

describe('crawler and sitemap policy', () => {
  it('allows named search crawlers and user fetchers on public pages while preserving private exclusions', () => {
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    for (const path of ['/ppi/portal/', '/ppi/admin/', '/api/']) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
    for (const agent of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'ChatGPT-User', 'Claude-User', 'Perplexity-User']) {
      // There is no narrower group that overrides the wildcard policy.
      expect(robots).not.toMatch(new RegExp(`User-agent:\\s*${agent}`, 'iu'));
    }
  });

  it('lists canonical public HTML routes and no private or transactional route', () => {
    expect(sitemap).toContain('https://getautoclarity.com/');
    expect(sitemap).toContain('https://getautoclarity.com/las-vegas-pre-purchase-inspection/');
    expect(sitemap).toContain('https://getautoclarity.com/privacy');
    expect(sitemap).toContain('https://getautoclarity.com/terms');
    expect(sitemap).not.toMatch(/\/api\/|\/ppi\/portal|\/ppi\/admin/iu);
  });

  it('stages a preflighted IndexNow submission without pretending it has run', () => {
    expect(indexNowKey.trim()).toMatch(/^[a-f0-9]{32}$/u);
    expect(indexNowScript).toContain('if (!process.argv.includes(\'--submit\'))');
    expect(indexNowScript).toContain('IndexNow preflight failed');
    expect(indexNowScript).toContain('https://api.indexnow.org/indexnow');
    expect(indexNowScript).toContain('/autoclarity-services.json');
    expect(indexNowScript).toContain('catalog?.canonicalUrl !== url');
    expect(indexNowScript).toContain("offering?.id === 'las-vegas-pre-purchase-inspection'");
    expect(indexNowScript).toContain("ppiOffering?.officialPage !== 'https://getautoclarity.com/las-vegas-pre-purchase-inspection/'");
    expect(indexNowScript).not.toContain("catalog?.canonicalUrl !== 'https://getautoclarity.com/las-vegas-pre-purchase-inspection/'");
    expect(indexNowScript).toContain('const expectedCanonical = `<link rel="canonical" href="${url}"`;');
    expect(indexNowScript).toContain('!body.includes(expectedCanonical)');
    expect(indexNowScript).toContain("const expectedBuild = 'ac-ai-20260907-r2'");
    expect(indexNowScript).toContain("response.headers.get('x-autoclarity-build') !== expectedBuild");
    expect(indexNowScript).toContain("response.headers.get('x-robots-tag') ?? ''");
    expect(headers).toContain('X-AutoClarity-Build: ac-ai-20260907-r2');
    expect(indexNowScript).not.toContain('/ppi/portal');
  });

});
