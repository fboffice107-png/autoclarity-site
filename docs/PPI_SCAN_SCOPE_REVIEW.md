# Diagnostic-Scan Scope Review

**Master switch:** `scan.included` in `functions/lib/config.ts` (exposed to the
frontend as `scanIncluded`). **Default: `false`** — fail-safe until the owner
confirms scan-tool usage is within the approved operating scope.

The owner has verbally confirmed with Nevada DMV Occupational & Business
Licensing that a **PPI-only** service does not require garage registration. The
website does **not** state any DMV endorsement/licensing of AutoClarity, and
shows no legal conclusions to customers. Because a diagnostic scan can blur the
line between "inspection" and "repair/diagnosis," scan language ships **off** by
default and the owner enables it deliberately once the scope is confirmed.

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

### `scan.included = true` (owner enables after confirming scope)
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
| `functions/lib/agreements.ts` (Scope & Limitations, Service Agreement) | "a diagnostic scan cannot prove the absence of all faults"; "where the vehicle supports it and the seller permits it" | qualified, condition-dependent language (owner-review legal drafts) |
| `assets/js/ppi-form.js` `applyScanLanguage()` | toggles all `[data-scan]` elements from `scanIncluded` | runtime config |

## Separation from the digital app

This setting only affects the **physical PPI page**. It does not touch the
AutoClarity iPhone app's symptom-guidance language or its App Store copy.

## To enable later

Admin dashboard → Configuration → set `scan.included: true` (and confirm the
agreement wording with counsel). No code change required.
