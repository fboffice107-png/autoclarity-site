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
