# AI discovery, search indexing, and revenue attribution audit

Audited 2026-09-07 against source revision `3025bcd`, the live site, the U.S.
App Store listing, and current first-party crawler documentation. Work is on
`agent/ai-discovery-indexing-2026-09-07`; the pre-existing dirty checkout was
not modified.

## Executive result

The site already had sound canonical URLs, crawlable server-rendered HTML,
public sitemap and robots files, private-route exclusions, useful local-service
copy, and first-party interaction counters. Its largest correctness gaps were:

1. no synchronized public source for the app and inspection facts;
2. no `llms.txt` or public service catalog;
3. an unsupported “app is available everywhere” claim;
4. app pricing and eligibility were absent from visible page copy;
5. documented payment/booking/completion analytics were not written by the
   authoritative server paths; and
6. the admin labeled one net-like number simply “Revenue” and could not connect
   a request's acquisition category to payment or completion.

This change adds one dated fact source and generator, precise visible copy,
conservative JSON-LD, `/llms.txt`, `/autoclarity-services.json`, an IndexNow
submission preflight, privacy-minimized request attribution, server-side
milestone events, and separate gross/refund/net/dispute reporting. It adds no
ads, training-crawler exception, public customer data, checkout API, MCP server,
or automated agent transaction surface.

## Verified public facts

The canonical maintained source is `scripts/public-facts.json`. Generated
outputs are checked by `npm run facts:check` and acceptance tests.

### AutoClarity iPhone app

- iPhone symptom guidance: possible causes, urgency and safety information,
  repair-cost direction, recommended next steps, and a shareable report.
- No OBD scanner is required. It is not hands-on inspection, scan-tool testing,
  or diagnosis by a qualified automotive technician.
- The U.S. listing says one successfully completed report is free.
- For eligible new U.S. subscribers, the first year is $9.99; the listing says
  renewal is $29.99/year unless canceled. Apple determines eligibility and
  shows the applicable localized price. No worldwide or Android claim is made.

### Las Vegas mobile pre-purchase inspection

- Separate founder-performed physical service for reviewed locations in Las
  Vegas, North Las Vegas, Henderson, Boulder City, and surrounding Clark County.
- Starting tiers are $199, $299, and $399. They are not represented as flat or
  guaranteed totals.
- From the central Las Vegas service area: 0–15 miles included; 16–25 +$25;
  26–40 +$50; beyond 40 miles individually reviewed.
- A request is not an appointment. Vehicle, location, access, scope, exact quote,
  agreement, and payment conditions still apply. A PPI is not a warranty.
- The app subscription and physical inspection are separately priced products.

Sources checked 2026-09-07:

- [AutoClarity U.S. App Store listing](https://apps.apple.com/us/app/autoclarity/id6761438602)
- [Live homepage](https://getautoclarity.com/)
- [Live Las Vegas PPI page](https://getautoclarity.com/las-vegas-pre-purchase-inspection/)
- [Live privacy policy](https://getautoclarity.com/privacy)
- [Live terms](https://getautoclarity.com/terms)
- runtime configuration at `/api/ppi/runtime-config`

The live privacy policy and terms, both dated 2026-09-01, contain app and PPI
sections. Publication alone does not prove owner, counsel, licensing, or
insurance approval, so the production checklist keeps those approvals open.

## Live technical baseline

Observed 2026-09-07 before any deployment from this branch:

| Surface | Result | Notes |
|---|---:|---|
| `/` | 200 HTML | canonical apex, public |
| `/las-vegas-pre-purchase-inspection/` | 200 HTML | canonical public service page |
| sample report HTML/PDF | 200 | correct HTML/PDF content types |
| `/privacy`, `/terms` | redirect then 200 HTML | clean canonical paths |
| `/robots.txt` | 200 text | wildcard public allow; private paths disallowed |
| `/sitemap.xml` | 200 XML | canonical public HTML routes only |
| `/llms.txt` | 404 HTML | implemented in this branch, not deployed |
| `/autoclarity-services.json` | 404 HTML | implemented in this branch, not deployed |
| `/ppi/portal/` | 200 HTML | `X-Robots-Tag: noindex, nofollow` |
| `/ppi/admin/` | Access redirect | Cloudflare Access protected |
| runtime config | 200 JSON | `no-store`, `noindex`; live/booking/uploads/payments true |
| `www` host | redirect to apex | canonical consolidation |

Public static pages returned `Cache-Control: public, max-age=0,
must-revalidate`. APIs returned `no-store`. The new generated fact documents
have explicit one-hour caches. The repository intentionally has no tracked
production `wrangler.toml`; production bindings remain outside source control.

## Search and answer-engine evaluation

The current wildcard robots group permits public crawling while disallowing
`/ppi/portal/`, `/ppi/admin/`, and `/api/`. No bot-specific group was added:
that preserves the existing training-crawler preference and avoids accidentally
dropping the private exclusions. Live requests to both public pages returned
200 for Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot, PerplexityBot,
ChatGPT-User, Claude-User, and Perplexity-User.

User-triggered fetchers are distinct from search crawlers and may not use
robots policy identically; the pages are publicly fetchable either way. A
successful user-agent request is an edge-access check, not proof that a vendor
has crawled, indexed, cited, or ranked the URL. Account-level WAF/bot rules and
vendor IP allowlists were not visible from the repository and remain an
operator check.

Search snapshots on 2026-09-07 found the App Store result for a branded app
query and indexed pages for `site:getautoclarity.com`. AutoClarity did not appear
in the sampled neutral “mobile pre purchase car inspection Las Vegas” or
“iPhone app car symptom guidance no OBD scanner” results. No AI citation or AI
referral was observed. These are limited snapshots, not rank guarantees.

Current primary guidance reviewed:

- [Google AI features and your website](https://developers.google.com/search/docs/appearance/ai-features): normal Search eligibility and SEO fundamentals apply; no special AI file or schema is required, and appearance is not guaranteed.
- [OpenAI crawlers](https://developers.openai.com/api/docs/bots): OAI-SearchBot controls ChatGPT search; GPTBot training controls are independent; ChatGPT-User is user-initiated.
- [Anthropic crawler controls](https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler): ClaudeBot, Claude-SearchBot, and Claude-User have distinct purposes.
- [Perplexity crawler documentation](https://docs.perplexity.ai/docs/resources/perplexity-crawlers): PerplexityBot and Perplexity-User are distinct; WAF allowlisting can require user-agent and published IP checks.
- [IndexNow protocol](https://www.indexnow.org/documentation)
- [Google Indexing API](https://developers.google.com/search/apis/indexing-api/v3/quickstart): not used here because this ordinary marketing content is outside the API's supported job/broadcast-event use case.
- [llms.txt proposal](https://llmstxt.org/): treated as an optional discoverability aid, not a ranking or citation control.

No authenticated evidence was available for Google Search Console, Bing
Webmaster Tools, Google Business Profile, or an existing IndexNow setup. No
account state was invented and no URL was submitted. This branch stages an
IndexNow key and script that refuses to submit until the exact live key file and
every submitted URL pass an HTTP preflight. Run it only after deployment.

## Machine-readable implementation

- `scripts/public-facts.json` is the maintained fact source.
- `scripts/generate-public-facts.mjs` generates the two public documents and
  both pages' JSON-LD. `--check` fails on drift.
- `/autoclarity-services.json` is a static informational catalog, not a live
  booking, quote, availability, customer-data, checkout, or payment endpoint.
- `/llms.txt` summarizes the two offerings and links only to public resources.
- JSON-LD uses stable Organization, MobileApplication, Service, FAQPage, and
  BreadcrumbList identifiers. Prices are qualified as starting/eligible; there
  is no invented address, review, rating, Android product, or LocalBusiness.

## Measurement and revenue

Browser interaction counters remain useful diagnostics, but are labeled as
such. An App Store outbound event proves only a click; it cannot prove an
install, subscription, renewal, or app revenue. Apple-side conversion needs
App Store Connect or another explicitly authorized source.

For the service funnel, each request now stores one first-touch category such
as `ppi_google_cpc` or `ppi_search_organic`. Inputs are allowlisted; raw campaign
names, URLs, hosts, search text, referrer paths, and customer fields are not
stored in analytics. Missing or invalid values become `ppi_unknown`; the UI
combines direct and unknown as “Direct / unknown” rather than fabricating an AI
source.

The admin now separates:

- **gross collected:** qualifying payment amounts in the 30-day payment cohort;
- **refunded:** refunds recorded against those payments;
- **net collected:** gross minus refunds;
- **disputed:** separately surfaced and excluded from recognized net; and
- **verified funnel:** saved requests, sent quotes, created checkouts,
  successful payments, confirmed bookings, and completed inspections from D1
  workflow/payment records.

Revenue by source is a 30-day request cohort joined to payment records. It is
not lifetime value, GA-style session attribution, or Apple subscription revenue.

## Monetization decisions

No display ad code was added. Actual eligible human page-view volume and a
defensible page RPM were unavailable. The auditable estimate remains:

`estimated ad revenue = eligible human page views / 1,000 × assumed page RPM`

Any numeric output without both inputs would be fabricated. On a high-intent
service request page, distraction, latency, trust loss, consent overhead, and
booking cannibalization are plausible; the decision is deferred pending real
traffic and funnel-value data.

A potentially valuable future agent product is a permissioned, sanitized
inspection-request and verified-report feed for dealers, fleets, or buyer
platforms. It was not built: customer demand, data rights, authentication,
least-privilege authorization, audit logs, abuse controls, service-level terms,
and evidence that automation outperforms the current human flow are all missing.

## Validation and release state

- **Implemented:** source and generated facts, visible copy, JSON-LD, public
  catalog, `llms.txt`, IndexNow preflight, server attribution, authoritative
  milestones, and revenue/source reporting.
- **Tested locally:** fact drift check and typecheck passed; 163 unit tests and
  47 full HTTP workflow tests passed with fresh local D1/R2 and mocked Stripe;
  all internal links and header checks passed; desktop and 375px mobile rendered
  checks found no horizontal overflow or console warnings/errors. The public
  JSON, text summary, and IndexNow key returned 200 with expected content types.
- **Deployed:** no.
- **Submitted to search/indexing services:** no.
- **Indexed:** existing site pages observed; new outputs cannot be indexed before deployment.
- **Observed in AI answers/citations/referrals:** no.
- **Observed payments/revenue from this release:** no; tests use mocked payments only.

The highest-value next action is an owner-approved deployment with migration
`0005`, followed by live smoke tests, the preflighted IndexNow submission, and
authenticated Search Console/Bing inspection. That action is intentionally not
performed by this branch.
