# Diagnostic-Scan Scope Review

**Master switch:** `scan.included` in `functions/lib/config.ts` (exposed to the
frontend as `scanIncluded`). **Default: `false`** because a diagnostic scan is
an optional scope item, not an included part of every inspection. Enable it only
when it is part of the approved customer quote and confirmed inspection scope.

## Behavior by state

### `scan.included = false` (current default)
- Hero highlights do not mention "computer scan."
- Pricing cards do not advertise a scan.
- The public, indexable HTML contains no diagnostic-scan or emissions-readiness
  offer text, including hidden DOM text.
- The intake form contains no diagnostic-scanning consent field.
- Emissions-readiness is not advertised as standard.
- A real report may still include a clearly disabled "scan: not performed /
  not included" section.

### Future `scan.included = true`
- The runtime flag alone does not publish scan language or a consent field.
- A separately reviewed release must add accurate, qualified public copy and
  consent UI only after scope, equipment, licensing, and counsel checks pass.
- Operating rules for the technician (documented, enforced by process):
  - Requires seller permission before connecting.
  - A scan cannot prove the absence of all faults — the report says so.
  - **Never clear codes.** **Never modify vehicle settings.**
  - Record scan outcome as: completed / unavailable / refused / not included.

## Every scanner-language occurrence (audited)

| Location | Wording | Gated by |
|---|---|---|
| `las-vegas-.../index.html` hero highlights | (no scan mention) | — |
| `las-vegas-.../index.html` how-it-works step 5 | road test where permitted and safe | static; no scan claim |
| `las-vegas-.../index.html` road-test card | road test + warning-light documentation | static; no scan/emissions claim |
| `las-vegas-.../index.html` intake | no diagnostic-scanning consent field | static |
| `las-vegas-.../sample-report/` | road-test section present; scan not asserted as performed | static demo, labeled |
| `functions/lib/agreements.ts` (Scope & Limitations, Service Agreement) | scan is conditional on the approved scope, vehicle support, and seller permission; a scan cannot prove the absence of all faults | versioned customer agreements |
| `assets/js/ppi-form.js` `applyScanLanguage()` | retained only for backward compatibility; there are no public `[data-scan]` elements | runtime config |

## Separation from the digital app

This setting only affects the **physical PPI page**. It does not touch the
AutoClarity iPhone app's symptom-guidance language or its App Store copy.

## To enable

The runtime flag alone is not sufficient. A future release must verify the
customer quote/scope, public wording, consent UI, equipment, licensing, and
current versioned agreements together before advertising or requesting consent
for a scan.
