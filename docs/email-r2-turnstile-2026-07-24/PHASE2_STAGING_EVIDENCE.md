# Phase 2 — R2 photo workflow: STAGING proof + security fixes (2026-07-24)

Staging stack: local `ppi-ui-test` server (`wrangler pages dev`, preview env,
local D1 + local R2 binding `UPLOADS`) — identical code to production. The
production R2 activation itself is gated on the account-level enable
(API error 10042 re-verified repeatedly this session; see the session log).

## Independent security review (subagent) — verdict GO with conditions

`SECURITY_REVIEW_R2.md` (same directory): every claimed property CONFIRMED
with file:line evidence (auth fail-closed incl. dev-key refusal + Access JWT
RS256 verification, randomized non-derived object keys, no traversal path,
magic-byte sniffing, caps, cross-tenant isolation, DB-trigger immutability,
CORS scoping, email record-first). No critical/high defects. Material items
were FIXED in this session's commit rather than accepted:

1. **D1 (medium, availability)** — customer photo streams shared the 60/hr/IP
   portal rate bucket → a photo-heavy report would 429 a real customer.
   Fix: `report-photo` GETs now use a dedicated `portal_photo` bucket
   (600/hr) — `functions/lib/portal.ts` (`PortalAuthOptions`),
   `functions/api/portal/report-photo.ts`. Token brute force stays bounded.
2. **D2 (low, privacy)** — on client-side decode failure the uploader fell
   back to the ORIGINAL file, which can retain EXIF/GPS. Fix: the fallback is
   removed; un-decodable photos are refused with a clear retry message
   (`assets/js/inspector-report.js`, `downscaleJpeg`).
3. **O3** — portal upload POST/GET now 409 `uploads_disabled` (not 500) if the
   flag is on while the binding is absent (`functions/api/portal/upload.ts`).
4. **H1** — the published-photo membership check now parses the snapshot and
   walks `sections[].items[].photos[]` + `generalPhotos[]` instead of a
   substring probe (`report-photo.ts`, `publishedPhotoIds`).

Accepted observations (documented, not fixed): H2 LIKE-wildcard broadening
(errs fail-safe), H4 orphan-object hygiene (unreachable, cost-only), H5
server-side EXIF strip for customer intake uploads (admin-only visibility),
H6 JWT `nbf`, O7 token-in-query (mitigated: no-referrer + no-store +
rotation), O8 publish-time PDF memory ceiling (`pdf_store_failed` fallback
already handles it).

**EXIF/GPS policy (documented decision):** inspector photos are always
canvas re-encoded on-device (≤1600px JPEG q0.82) — this bakes orientation
via the browser's EXIF-aware decode and strips ALL metadata incl. GPS before
upload; un-decodable files are refused (never uploaded raw). Customer intake
uploads are stored as received; they are visible only to the customer
themselves and the Access-gated admin, never published.

## Staging workflow proof (real browser, fixture PPI-FIXTURE-PAIDOK)

All 190 tests (118 unit + 72 integration) + `tsc` pass with the fixes.

- **Start**: duplicate Start (double-click AND double POST) → one report,
  `existing:true` on the second (UNIQUE constraint).
- **Author**: Rear brake pads = FAIL, 2 mm measurement, customer explanation,
  $220–380 estimate, priority Immediate, safety-critical; Tire RL =
  ATTENTION + explanation; remaining 102 items via the section bulk actions →
  104/104 saved (autosave chip "Saved").
- **Photos through the real client path** (canvas-JPEG injected into the
  actual file inputs; change-event → real `downscaleJpeg` → real POST):
  2200×1650 originals downscaled on-device to **1600×1200 JPEG**, captions
  recorded, attached to the two DIFFERENT findings
  (`brakes.rear_pads`, `tires_wheels.tread_rl`); thumbnails stream back
  through the authenticated inspector endpoint (blob URLs, decoded).
  Upload-failure UX proven honest by an induced client error: "Photo failed"
  chip + alert, no phantom state, input cleared.
- **Refresh/resume**: full reload → fail state, measurement, notes, score,
  summary, thumbnails all restored from the server.
- **Publish gates**: readiness blocked until score/verdict/summary set
  (warnings advisory); `draft_complete → ready_for_review` moves; publish
  modal requires the typed ref (wrong ref → 422); amendment publish also
  requires a reason (422 without).
- **Published v1**: request → `completed`; `report_ready` recorded
  idempotently (`dedupe_key report_ready:rv_…`); portal shows v1; **PDF
  173,769 B, 7 pages, exactly 2 embedded JPEGs (DCTDecode), all findings /
  captions / ref present** — HTML and PDF from the same snapshot.
- **Isolation matrix (live staging)**: valid token → both photos 200
  image/jpeg; FOREIGN customer token → 404; garbage token → 401;
  inspector API without auth → 401.
- **Immutability**: photo POST on published report → 423; direct SQL
  `UPDATE report_versions SET payload_json…` → **rejected by the DB trigger**
  ("report versions are immutable").
- **Amendment safety**: amendment created → customer STILL sees v1 (and its
  photos stream); deleting a photo from the amendment draft returned
  `retainedForVersions:true` (R2 object kept, v1 view unaffected); publish v2
  (typed ref + reason) → customer sees v2 amendment with reason + 2-entry
  history, removed photo 404s under v2, kept photo streams; **v2 PDF:
  1 embedded JPEG, "Version 2" + amendment reason present**; magic link
  rotated at publish (old token 401 — correct).
- **Mobile 375×812**: portal report, inspector editor, landing page —
  no horizontal overflow.

## Production Turnstile — prepared autonomously (deploys with the R2 binding)

The CLI OAuth token carries `challenge-widgets.write`, so no dashboard action
was needed: widget **"AutoClarity Public Request Form"** (mode: managed,
domains getautoclarity.com + www) created via the API. Public sitekey
`0x4AAAAAAD9RlzUuK7woWT3B` → `TURNSTILE_SITE_KEY` (wrangler.toml). The
secret went API→stdin→`wrangler pages secret put TURNSTILE_SECRET_KEY`
(never displayed; scratch file destroyed). Test always-pass keys remain ONLY
in launch.json + the integration harness. **Site key + secret + R2 binding
must ship in ONE deploy** (secrets bind at deployment), which is why the
sitekey swap waits for the R2 deploy rather than deploying alone.

## Remaining before production R2 proof

1. **Owner: complete the account-level R2 enable** (the API still returns
   10042 — the earlier dashboard visit did not finish the purchase/terms
   step).
2. Then (autonomous): create bucket `autoclarity-ppi-uploads` → deploy →
   verify runtime config + live photo path + Turnstile validation matrix →
   full acceptance test.
