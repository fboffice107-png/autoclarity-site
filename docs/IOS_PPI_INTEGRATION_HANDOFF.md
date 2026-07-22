# iOS App → PPI Handoff (for the AutoClarity iPhone app)

> **The iOS app was NOT modified by this work.** The Xcode project is a separate
> repository from `autoclarity-site`, and the workspace contains multiple
> candidate projects plus a known decoy (`DO_NOT_USE_old_fake_sandbox.xcodeproj`).
> Editing the wrong target is risky, so per the task's guidance for the
> "uncertain/unavailable project" case, this is a spec + a paste-ready prompt to
> run inside the correct iOS project.

## App card

- **Title:** Las Vegas Pre-Purchase Inspection
- **Subtitle:** Have an experienced technician inspect the vehicle before you buy it.
- **Badge:** Now Serving Las Vegas
- **Button:** Request an Inspection
- Small caption: "In-person service · Las Vegas, NV · separately priced"

## Destination (short marketing route)

```
https://getautoclarity.com/ppi?utm_source=ios_app&utm_medium=owned&utm_campaign=ppi_launch
```

`/ppi` 301-redirects to the canonical page and preserves the UTM query string.
Open via the app's approved external-browser flow (`SFSafariViewController` or
the existing secure external-link handler) — never a raw shared-cookie WKWebView,
and never embed the payment pages in an insecure custom web view.

## Rules (App Review + billing separation)

- The physical PPI is a real-world service (Apple guideline 3.1.3) — it must
  **not** be sold via Apple IAP, and the app must not imply the app
  subscription includes it.
- RevenueCat stays limited to the digital subscription (`premium`,
  `autoclarity_single_report`, `autoclarity_pro` offering).
- Do not show PPI prices inside any IAP/paywall surface; keep the PPI card
  visually separate from subscription upsells.
- The app must remain fully useful without the PPI service (the card is additive).
- Review whether the App Store privacy disclosures / support text need updating
  because of the new external physical-service link before submitting.
- Do not ship an app update whose website link is broken or non-production —
  confirm the page is live first.

## Analytics (app-side, no personal data)

- `ppi_card_impression` — card rendered
- `ppi_card_tap` — button tapped
- `ppi_website_open_success` — external browser opened successfully

The website tracks its own funnel from `ppi_page_view` onward; `utm_source=ios_app`
connects the two without sharing any personal data.

## Placement

Home screen, below the primary "Start diagnosis" action — visible but not
competing with the app's core flow. Consider hiding the card for users clearly
outside the US/Nevada if regional signal is available, to avoid disappointing taps.

---

## Ready-to-paste Claude Code prompt (run INSIDE the iOS project)

> Copy everything below into a Claude Code session opened in the **correct
> production AutoClarity iOS repository** (confirm it is not
> `DO_NOT_USE_old_fake_sandbox.xcodeproj`).

```
Add a "Las Vegas Pre-Purchase Inspection" promo card to the AutoClarity iOS app
home screen. Requirements:

1. First confirm this is the correct PRODUCTION app target (bundle id matching
   the shipping App Store app; NOT any *sandbox*/*fake*/*DO_NOT_USE* project).
   Print the target/bundle id you are editing and stop if it looks like a decoy.

2. Card content:
   - Title: "Las Vegas Pre-Purchase Inspection"
   - Subtitle: "Have an experienced technician inspect the vehicle before you buy it."
   - Badge: "Now Serving Las Vegas"
   - Button: "Request an Inspection"
   - Caption: "In-person service · Las Vegas, NV · separately priced"
   Match the app's existing card styling; do not put it inside any paywall/IAP view.

3. On tap, open this URL via SFSafariViewController (or the app's existing secure
   external-link opener), NOT a shared-cookie WKWebView:
   https://getautoclarity.com/ppi?utm_source=ios_app&utm_medium=owned&utm_campaign=ppi_launch

4. Billing separation: do NOT route this through RevenueCat/IAP. Do not imply the
   app subscription includes the inspection. Keep RevenueCat limited to the
   digital subscription. The app must stay fully usable without this card.

5. Analytics (reuse the app's existing analytics, no PII): log
   ppi_card_impression on appear, ppi_card_tap on tap, ppi_website_open_success
   when the browser opens.

6. Place the card on the home screen below the primary "Start diagnosis" action.

7. Do not submit an App Store update until the owner confirms the website page is
   live. Review whether App Store privacy/support metadata needs an update for the
   new external service link, and report what (if anything) changed.

Build the app and confirm it compiles. Report the exact files changed and the
target/bundle id you edited.
```
