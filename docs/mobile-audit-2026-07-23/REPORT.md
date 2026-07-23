# Mobile Responsive Audit — 2026-07-23

Target: `https://autoclarity-site.pages.dev` (hosted Cloudflare preview, noindex).
Method: measured in the browser pane (document scrollWidth vs viewport, computed
styles, element rects) across widths, plus visual screenshots for key views.

> The browser-pane tool cannot write PNG files into the repo, so the durable
> evidence here is the **measured** matrix below. Screenshots were reviewed live
> for: homepage @320, homepage @390, landing hero @390, intake form @390,
> customer portal (post-payment/refunded) @390.

## Results

| Check | 320 | 375 | 390 | 414 | 768 | Desktop |
|---|---|---|---|---|---|---|
| Homepage — horizontal overflow | none | none | none | none | none | none |
| Landing — horizontal overflow | none | none | none | none | none | none |
| Intake form — overflow | none | none | none | none | none | none |
| Portal — overflow | — | — | none | — | none | none |

- **Inputs:** `#fullName` etc. computed `font-size: 16px` → no iOS auto-zoom. Keyboards: email→`type=email`, phone→`type=tel`+`inputmode=tel`, ZIP/year/mileage→`inputmode=numeric`, VIN→text (uppercased).
- **Tap targets:** hero CTA height ≈ 61px; sticky mobile bar buttons ≥ 44px.
- **Form layout:** multi-field rows now stack to a **clean single column** at ≤560px (fix added this session in `assets/css/ppi.css`).
- **Founder photo:** responsive `<picture>` AVIF/WebP/JPEG (460/640/834), `width/height` set (no layout shift), displayed ≤ ~420px against 834px source → sharp, not distorted.
- **Only elements wider than the viewport** are the decorative `.hero-glow` background divs (aria-hidden, positioned); `overflow-x:hidden` on body means they never create a scrollbar (confirmed `scrollWidth == innerWidth`).
- **Timezone:** customer portal shows Las Vegas / `America/Los_Angeles`.
- **Status:** portal renders status pills cleanly (verified "Refunded"); quote line items and totals readable.

## Fixes applied this session

1. Intake form forced to single column on phones (`@media (max-width:560px)`).
2. Homepage secondary "Now serving Las Vegas" path styles (mobile-friendly, full-width button ≤480px).
3. Public "PPI" labels replaced with "Pre-Purchase Inspection"/"Inspection" (nav, buttons, pricing tiers, JSON-LD) — improves mobile nav clarity.

## Not blocking / acceptable

- Decorative hero glows extend past the viewport by design (no scroll impact).
- Desktop founder hero is 2-column; collapses to stacked (copy → CTA → photo → card) on phones per spec.

---

# Final mobile & conversion pass — 2026-07-23 (second session)

Audited against the **local wrangler dev server** (same code as the hosted
preview) at 320/360/375/390/414/768/1440, including the customer portal in the
quote-sent (appointment selection), confirmed, needs-info and refunded states,
plus the admin dashboard.

## New defects found and FIXED this pass

1. **Multi-step form showed all three nav buttons at once** (conversion bug).
   `.btn { display:inline-flex }` (author origin) overrides the UA's
   `[hidden] { display:none }`, so the hidden "Back" and "Submit request"
   buttons rendered on every step — a customer could press Submit on step 1.
   Fixed globally: `[hidden] { display:none !important; }` in `site.css`.
   Verified after fix: step 1 shows only Continue; step 2+ shows Back;
   Submit appears only on step 4; homepage demo tabs still work.
2. **Portal fixed header was transparent when scrolled** — the portal page
   doesn't load `main.js` (which toggles `.is-scrolled`), so page content
   scrolled visibly *through* the header. Added `.nav-solid` (ppi.css) and
   applied it to the portal header.
3. **Nav brand/CTA collision at 320px** on the landing page — the
   "AutoClarity" wordmark ran ~6px under the "Request an inspection" button.
   At ≤374px the wordmark is now hidden (icon remains); `white-space: nowrap`
   moved to `site.css` so the homepage "Get the app" button no longer wraps
   to two lines at 320.
4. **Verdict strip was left-aligned** while the rest of the hero centers at
   ≤940px — now centered to match.
5. **Accessibility**: the success-panel photo `<input type=file>` had no
   accessible name — added `aria-label`. Structural a11y checks (labels,
   alt text, heading order, single h1, skip links, tab aria) pass on
   homepage, landing and portal; no visible interactive control under 40px.

## Customer-language improvements

- Status pills: "Customer Cancelled" → **"Cancelled by You"**,
  "Admin Cancelled" → **"Cancelled by AutoClarity"** (`status.ts`, copy only).
- Portal guidance: refunded state now explains the 5–10 business-day bank
  timing (matches the refund email); cancelled states tell the customer what
  they can do next.
- Bare "PPI" removed from remaining public copy: landing hero fineprint,
  pricing app-vs-inspection note, fallback email subject, sample-report meta
  description + aria-label. First textual definition "pre-purchase
  inspection (PPI)" now lives in the guarantee FAQ.

## Screenshots (this directory, `screenshots/`)

Captured from the live dev server via headless Chrome (puppeteer-core,
DPR 2 for mobile, reveal animations disabled). Note: plain
`chrome --headless=new --screenshot` clips mobile widths (enforces a 500px
minimum innerWidth) — do not use it for future captures.

| File | View |
|---|---|
| `home-320.png` | Homepage, 320px |
| `home-390.png` | Homepage, iPhone 390px |
| `inspection-390.png` | Landing page, 390px (full page) |
| `intake-form-390.png` | Intake form section, 390px |
| `portal-appointment-selection-390.png` | Portal: quote + choose appointment |
| `portal-status-confirmed-390.png` | Portal: confirmed booking status |
| `portal-status-refunded-390.png` | Portal: refunded status |
| `home-1440.png` | Homepage, desktop |
| `inspection-1440.png` | Landing page, desktop |
| `admin-overview-1440.png` | Admin dashboard, desktop |

## Re-verified after fixes

100 tests pass (66 unit + 34 integration), `tsc --noEmit` clean, 20 internal
links OK, all header checks pass. No payment/webhook/auth/schema/DNS change —
`wrangler.toml` untouched, `PAYMENTS_ENABLED=false`, `STRIPE_ENV=test`.
