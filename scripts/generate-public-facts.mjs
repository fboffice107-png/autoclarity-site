import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const factsPath = path.join(root, 'scripts', 'public-facts.json');
const facts = JSON.parse(await readFile(factsPath, 'utf8'));
const checkOnly = process.argv.includes('--check');

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function offer(tier) {
  return {
    '@type': 'Offer',
    name: tier.name,
    description: `${tier.qualification} The exact total is confirmed before payment.`,
    priceSpecification: {
      '@type': 'PriceSpecification',
      price: String(tier.amount),
      priceCurrency: facts.ppi.currency,
    },
  };
}

const organization = {
  '@type': 'Organization',
  '@id': facts.organization.entityId,
  name: facts.organization.name,
  url: facts.organization.canonicalUrl,
  email: facts.organization.supportEmail,
  sameAs: facts.organization.sameAs,
};

const appJsonLd = {
  '@type': 'MobileApplication',
  '@id': facts.app.entityId,
  name: 'AutoClarity',
  operatingSystem: 'iOS',
  applicationCategory: facts.app.category,
  description: facts.app.summary,
  url: facts.app.canonicalUrl,
  installUrl: facts.app.purchaseUrl,
  publisher: { '@id': facts.organization.entityId },
  offers: [
    {
      '@type': 'Offer',
      name: 'Free download and one successfully completed report',
      price: String(facts.app.pricing.downloadPrice),
      priceCurrency: facts.app.pricing.currency,
      description: 'The app is free to download and one successfully completed diagnostic report is included at no charge.',
    },
    {
      '@type': 'Offer',
      name: 'AutoClarity Annual — introductory first year',
      price: String(facts.app.pricing.introductoryPrice),
      priceCurrency: facts.app.pricing.currency,
      eligibleRegion: { '@type': 'Country', name: 'United States' },
      description: facts.app.pricing.introductoryEligibility,
    },
    {
      '@type': 'Offer',
      name: 'AutoClarity Annual — standard annual price and renewal',
      price: String(facts.app.pricing.renewalPrice),
      priceCurrency: facts.app.pricing.currency,
      description: facts.app.pricing.renewalQualification,
    },
  ],
};

const serviceJsonLd = {
  '@type': 'Service',
  '@id': facts.ppi.entityId,
  name: facts.ppi.name,
  serviceType: 'Pre-purchase vehicle inspection',
  url: facts.ppi.canonicalUrl,
  description: facts.ppi.summary,
  provider: { '@id': facts.organization.entityId },
  areaServed: facts.ppi.serviceArea.places.map((name) => ({
    '@type': 'City',
    name,
    containedInPlace: { '@type': 'State', name: 'Nevada' },
  })),
  offers: facts.ppi.startingPrices.map(offer),
};

const homeJsonLd = {
  '@context': 'https://schema.org',
  // Keep page-level structured data scoped to visible homepage facts. The
  // fully priced service entity belongs on its dedicated landing page.
  '@graph': [organization, appJsonLd],
};

const ppiServiceJsonLd = {
  '@context': 'https://schema.org',
  '@graph': [organization, serviceJsonLd],
};

const ppiFaqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Does the AutoClarity app subscription include an in-person inspection?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. The AutoClarity iPhone app is a separately priced informational symptom-guidance product. A Las Vegas pre-purchase inspection is a separately requested, quoted, scheduled, and paid physical service.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does the inspection guarantee the vehicle?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. A pre-purchase inspection is a professional opinion about the vehicle’s observable condition at the time of inspection, not a warranty. Hidden or intermittent problems may not be detectable.',
      },
    },
    {
      '@type': 'Question',
      name: 'When do I pay?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Submitting is free and is not an appointment. After review, AutoClarity sends an exact quote and available timing. The customer selects a time, accepts the required agreements, and successful payment confirms the booking.',
      },
    },
    {
      '@type': 'Question',
      name: 'What areas do you serve?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Las Vegas, North Las Vegas, Henderson, and Boulder City requests are each subject to review. From the central Las Vegas service area, 0–15 miles is included, 16–25 miles adds $25, 26–40 miles adds $50, and locations beyond 40 miles are individually reviewed.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is the service available outside Las Vegas?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The in-person inspection service currently covers the listed Las Vegas-area locations only, subject to review. The symptom-guidance product is a separate iPhone app; Apple controls App Store availability for each storefront.',
      },
    },
  ],
};

const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'AutoClarity', item: facts.organization.canonicalUrl },
    { '@type': 'ListItem', position: 2, name: 'Las Vegas Pre-Purchase Inspection', item: facts.ppi.canonicalUrl },
  ],
};

const catalog = {
  documentType: 'AutoClarity public offerings catalog',
  schemaVersion: facts.schemaVersion,
  lastReviewedAt: facts.lastReviewedAt,
  canonicalUrl: 'https://getautoclarity.com/autoclarity-services.json',
  notice: 'This is a static informational document, not a booking, availability, quote, or checkout API.',
  organization: {
    name: facts.organization.name,
    canonicalUrl: facts.organization.canonicalUrl,
    supportEmail: facts.organization.supportEmail,
  },
  offerings: [
    {
      id: facts.app.id,
      type: 'mobile_application',
      name: facts.app.name,
      summary: facts.app.summary,
      bestFor: facts.app.bestFor,
      platform: facts.app.platform,
      officialPage: facts.app.canonicalUrl,
      purchaseUrl: facts.app.purchaseUrl,
      pricing: facts.app.pricing,
      limitations: facts.app.limitations,
      nextStep: facts.app.nextStep,
      sourceReferences: facts.app.publicSources.map((url) => ({ url, reviewedAt: facts.lastReviewedAt })),
    },
    {
      id: facts.ppi.id,
      type: 'service',
      name: facts.ppi.name,
      summary: facts.ppi.summary,
      bestFor: facts.ppi.bestFor,
      officialPage: facts.ppi.canonicalUrl,
      requestUrl: facts.ppi.requestUrl,
      pricing: {
        currency: facts.ppi.currency,
        startingPrices: facts.ppi.startingPrices,
        qualification: 'Every final price requires review of the vehicle, location, access, and confirmed inspection scope.',
      },
      serviceArea: facts.ppi.serviceArea,
      limitations: facts.ppi.limitations,
      nextStep: facts.ppi.nextStep,
      sourceReferences: facts.ppi.publicSources.map((url) => ({ url, reviewedAt: facts.lastReviewedAt })),
    },
  ],
  relationship: 'The iPhone app and Las Vegas inspection are separate products. Buying the app subscription does not include a physical inspection, and the app is not required to request one.',
};

const llms = `# AutoClarity

> AutoClarity has two separate offerings: an informational iPhone symptom-guidance app and a founder-performed mobile pre-purchase vehicle inspection service for reviewed Las Vegas-area locations.

Facts on this page were reviewed for source consistency ${facts.lastReviewedAt}. This does not replace owner verification of operating facts. Availability, eligibility, quotes, and prices remain subject to the linked official pages.

## Official pages

- [AutoClarity iPhone app](${facts.app.canonicalUrl}): possible causes, urgency and safety information, repair-cost direction, next steps, and a shareable report without an OBD scanner.
- [Download on the U.S. App Store](${facts.app.purchaseUrl}): Apple displays the applicable eligibility, storefront availability, and localized price before purchase.
- [Las Vegas pre-purchase inspection](${facts.ppi.canonicalUrl}): separately requested, quoted, scheduled, and paid mobile inspection service.
- [Public offerings catalog](https://getautoclarity.com/autoclarity-services.json): synchronized read-only JSON facts for both offerings.

## App pricing and limits

- One successfully completed diagnostic report is free.
- Eligible new U.S. subscribers may pay $${facts.app.pricing.introductoryPrice.toFixed(2)} for the first year. The subscription renews at $${facts.app.pricing.renewalPrice.toFixed(2)} per year unless canceled.
- Apple determines introductory-offer eligibility and displays the applicable localized price. The verified public storefront is the U.S. App Store listing.
- The app provides informational symptom guidance. It is not hands-on inspection, scan-tool testing, or diagnosis by a qualified technician.

## Las Vegas inspection pricing, area, and limits

- Standard Vehicle PPI: starting at $199.
- European, Luxury or Performance PPI: starting at $299.
- Exotic, Collector or Heavily Modified PPI: starting at $399.
- Las Vegas, North Las Vegas, Henderson, and Boulder City requests are each subject to review.
- From the central Las Vegas service area: 0–15 miles is included, 16–25 miles adds $25, 26–40 miles adds $50, and locations beyond 40 miles are individually reviewed.
- A request is not an appointment. The exact quote and available times follow review; successful payment after agreement acceptance confirms the booking.
- Scope depends on vehicle and access. Road tests require permission and safe, lawful conditions. An inspection is not a warranty and cannot identify every defect.

## Product relationship

- An app subscription does not include a physical inspection.
- The app is not required to request a Las Vegas inspection.
`;

function scripts(blocks) {
  return blocks.map((block) => `  <script type="application/ld+json">\n${json(block).trimEnd().split('\n').map((line) => `  ${line}`).join('\n')}\n  </script>`).join('\n');
}

async function replaceGeneratedBlock(file, name, content) {
  const target = path.join(root, file);
  const before = await readFile(target, 'utf8');
  const start = `  <!-- PUBLIC_FACTS:${name}:START -->`;
  const end = `  <!-- PUBLIC_FACTS:${name}:END -->`;
  const startAt = before.indexOf(start);
  const endAt = before.indexOf(end);
  if (startAt < 0 || endAt < startAt) throw new Error(`${file} is missing ${name} generation markers`);
  const after = before.slice(0, startAt) + start + '\n' + content + '\n' + before.slice(endAt);
  await emit(file, after);
}

async function emit(file, content) {
  const target = path.join(root, file);
  let existing = '';
  try { existing = await readFile(target, 'utf8'); } catch {}
  if (existing === content) return;
  if (checkOnly) throw new Error(`${file} is out of date; run npm run facts:generate`);
  await writeFile(target, content);
  process.stdout.write(`generated ${file}\n`);
}

await emit('autoclarity-services.json', json(catalog));
await emit('llms.txt', llms);
await replaceGeneratedBlock('index.html', 'HOME_JSONLD', scripts([homeJsonLd]));
await replaceGeneratedBlock('las-vegas-pre-purchase-inspection/index.html', 'PPI_JSONLD', scripts([
  ppiServiceJsonLd,
  ppiFaqJsonLd,
  breadcrumbJsonLd,
]));
