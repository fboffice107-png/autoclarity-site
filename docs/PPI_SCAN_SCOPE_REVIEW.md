# Diagnostic-Scan Scope Review

**Master switch:** `scan.included` in `functions/lib/config.ts` (exposed to the
frontend as `scanIncluded`). **Default: `false`** because a diagnostic scan is
an optional scope item, not an included part of every inspection. Enable it only
when it is part of the approved customer quote and confirmed inspection scope.

## Behavior by state

### `scan.included = false` (current default)
- Hero highlights do not mention "computer scan."
- Pricing cards do not advertise a scan.
- "Road test & diagnostics" scope card shows the road test + warning-light
  documentation; the scan/emissions lines are hidden (`data-scan="on"` hidden).
- The intake form hides the "seller has agreed to diagnostic scanning" checkbox
  (`data-scan="on"`), so sellers are not asked to approve scanning.
- Emissions-readiness is not advertised as standard.
- A real report may still include a clearly disabled "scan: not performed /
  not included" section.

### `scan.included = true`
- Qualified wording appears everywhere: *"Diagnostic scan where supported and
  included in the confirmed inspection scope."*
- The seller diagnostic-scanning consent field is shown.
- Operating rules for the technician (documented, enforced by process):
  - Requires seller permission before connecting.
  - A scan cannot prove the absence of all faults — the report says so.
  - **Never clear codes.** **Never modify vehicle settings.**
  - Record scan outcome as: completed / unavailable / refused / not included.

## Every scanner-language occurrence (audited)

| Location | Wording | Gated by |
|---|---|---|
| `las-vegas-.../index.html` hero highlights | (no scan mention) | — |
| `las-vegas-.../index.html` how-it-works step 5 | "…road test where permitted and safe" + optional scan clause | `[data-scan="on"]` |
| `las-vegas-.../index.html` "Road test & diagnostics" card | road test + warning-light doc (default); scan/emissions lines | `[data-scan="on"]` / `[data-scan="off"]` |
| `las-vegas-.../index.html` intake, seller diagnostic-scanning consent | checkbox | `[data-scan="on"]` |
| `las-vegas-.../sample-report/` | road-test section present; scan not asserted as performed | static demo, labeled |
| `functions/lib/agreements.ts` (Scope & Limitations, Service Agreement) | scan is conditional on the approved scope, vehicle support, and seller permission; a scan cannot prove the absence of all faults | versioned customer agreements |
| `assets/js/ppi-form.js` `applyScanLanguage()` | toggles all `[data-scan]` elements from `scanIncluded` | runtime config |

## Separation from the digital app

This setting only affects the **physical PPI page**. It does not touch the
AutoClarity iPhone app's symptom-guidance language or its App Store copy.

## To enable

Set `scan.included: true` through the reviewed PPI configuration process, then
verify the customer quote/scope and current versioned agreements all describe
the same conditional scan service. No customer should be promised or asked to
authorize a scan when the switch is off.
