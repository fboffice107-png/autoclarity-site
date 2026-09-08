# Diagnostic-Scan Scope Review

**Release gate:** `SCAN_CAPABILITY_RELEASED` in `functions/lib/config.ts`.
It is `false`; public runtime configuration therefore reports scan unavailable,
the admin configuration API rejects `scan.included=true`, and server intake
rejects/normalizes stale or crafted scan permission. This cannot be enabled by
a database setting alone.

## Behavior by state

### `scan.included = false` (current default)
- Hero highlights do not mention "computer scan."
- Pricing cards do not advertise a scan.
- The public, indexable HTML contains no diagnostic-scan or emissions-readiness
  offer text, including hidden DOM text.
- The intake form contains no diagnostic-scanning consent field.
- The server refuses a stale/crafted `permScan=true` submission and persists no
  scan permission.
- Emissions-readiness is not advertised as standard.
- A real report may still include a clearly disabled "scan: not performed /
  not included" section.

### Future `scan.included = true`
- A code-reviewed capability release must deliberately change the hard release
  gate; the runtime flag alone cannot publish scan language or consent.
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
| `assets/js/ppi-form.js` `applyScanLanguage()` | retained only for backward compatibility; there are no public `[data-scan]` elements | code release + runtime config |
| `functions/lib/validate.ts` | rejects crafted scan permission and normalizes the stored value to false | server release gate |
| `functions/lib/config.ts` | ignores stale true overrides and rejects attempts to enable scan | code release gate |

## Separation from the digital app

This setting only affects the **physical PPI page**. It does not touch the
AutoClarity iPhone app's symptom-guidance language or its App Store copy.

## To enable

The runtime flag alone is not sufficient and the current API rejects it. A
future code release must verify the
customer quote/scope, public wording, consent UI, equipment, licensing, and
current versioned agreements together before advertising or requesting consent
for a scan.
