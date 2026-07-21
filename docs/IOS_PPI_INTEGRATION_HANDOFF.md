# iOS App → PPI Handoff (for the AutoClarity iPhone app)

> This document is a spec for the iOS repository. The website work does not
> touch the app; implement this in the app codebase when ready.

## App card

- **Title:** Las Vegas Pre-Purchase Inspection
- **Subtitle:** Have an experienced technician inspect the vehicle before you buy it.
- **Button:** Request an Inspection
- Add a small "In-person service · Las Vegas, NV" caption so it's clearly a
  physical local service, not an app feature.

## Destination

```
https://getautoclarity.com/las-vegas-pre-purchase-inspection?utm_source=ios_app&utm_medium=owned&utm_campaign=ppi_launch
```

Open via the app's normal secure external-browser mechanism
(`SFSafariViewController` or the existing external-link handler). Do not embed
a raw WKWebView with shared cookies.

## Rules (billing separation — important for App Review)

- The physical PPI is paid on the website via Stripe. It is a real-world
  service (Apple guideline 3.1.3(e)) — it must NOT be sold through Apple IAP,
  and the app must not imply the $9.99 digital subscription includes it.
- RevenueCat stays responsible only for the digital AutoClarity subscription
  (`premium`, `autoclarity_single_report`, `autoclarity_pro` offering).
- Do not show PPI prices inside any IAP/paywall surface. Keep the PPI card
  visually separate from subscription upsells.
- The app must remain fully useful without the PPI service (it is — the card
  is additive only).

## Analytics events (app-side)

- `ppi_card_impression` — card rendered
- `ppi_card_tap` — button tapped
- `ppi_web_opened` — external browser successfully opened

(The website tracks its own funnel from `ppi_page_view` onward; `utm_source=ios_app`
connects the two without sharing any personal data.)

## Placement suggestion

Home screen, below the primary "Start diagnosis" flow — visible but not
competing with the app's core action. Hide the card for users outside the US
or, if regional targeting is available, outside Nevada/nearby, to avoid
disappointing taps.
