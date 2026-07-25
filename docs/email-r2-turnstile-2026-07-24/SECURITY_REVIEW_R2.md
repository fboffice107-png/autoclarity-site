# Security & Data-Integrity Review — R2 Photo/Upload System

Independent adversarial review before enabling the `[[r2_buckets]]` binding (`UPLOADS`,
bucket `autoclarity-ppi-uploads`) and `UPLOADS_ENABLED=true` in production.
Scope: photo/upload pipeline, report snapshots, email interplay, CORS.
Method: full source read of every R2 touchpoint, auth path, migration, and client
uploader; `npm run typecheck` clean; 118/118 unit tests pass (10 files).
Date: 2026-07-24. Reviewer: automated security review agent (read-only; nothing modified, nothing deployed).

All paths relative to `/Volumes/Super Storage/autoclarity-site`.

---

## Verdicts per claim

### 1. Upload authentication/authorization — CONFIRMED

- Customer intake uploads require a valid magic-link portal token:
  `functions/api/portal/upload.ts:45` (POST) and `:106` (GET) both call `requirePortal`
  before touching R2 or D1. `requirePortal` (`functions/lib/portal.ts:15-33`) rate-limits
  by IP (60/hr, `:16`), then verifies the token via SHA-256 hash lookup
  (`functions/lib/magic.ts:49-61` — 256-bit tokens, only hashes stored, revocation and
  expiry checked).
- Inspector report photos: every handler in
  `functions/api/inspector/reports/[id]/photos/index.ts:30` and
  `.../photos/[photoId].ts:31,50,87` calls `requireInspectorReport`
  (`functions/lib/inspector.ts:15-35`), which delegates to `requireAdmin`
  (`functions/lib/auth.ts:83-115`) and additionally enforces same-origin on mutations
  (`inspector.ts:21-23`).
- Production fails closed:
  - Dev key branch is gated on `!isProduction` (`auth.ts:95`); with `PPI_ENV=production`
    a matching dev key is refused. Unit-tested: `tests/unit/auth.test.ts:41-43`
    ("refuses the dev key even when it matches").
  - No Access config in production → 503 `admin_locked` (`auth.ts:105-110`).
  - Access JWT is actually verified, not trusted: alg pinned to RS256 (`auth.ts:48`),
    aud/exp/iss claims checked (`:51-54`), RSASSA-PKCS1-v1_5 signature verified against
    the team's published certs (`:68-79`). A spoofed `cf-access-jwt-assertion` header
    without a valid signature yields 401 (`auth.ts:91`).
  - Defense-in-depth: `functions/_middleware.ts:74-77` runs `requireAdmin` on
    `/ppi/admin*` and `/inspector*` static surfaces in production, so the UI shells are
    also gated even if Cloudflare Access were misconfigured.
- Auth coverage sweep: every file under `functions/api/admin/**`, `functions/api/inspector/**`
  calls `requireAdmin`/`requireInspectorReport` as its first action; every
  `functions/api/portal/**` endpoint calls `requirePortal` first (verified by grep across
  all 20 endpoints — no unauthenticated handler touches `env.UPLOADS`).

Minor notes (not defects): the Access JWT check does not validate `nbf`/`iat` (exp/iss/aud
only), and the certs cache (`auth.ts:20-21`) lives for 1h per isolate — both standard and
acceptable.

### 2. Object privacy — CONFIRMED

- Complete enumeration of R2 access: `env.UPLOADS`/`r2OrNull` is referenced in exactly
  seven places (grep-verified) — portal upload put/get (`upload.ts:90,116`), portal
  report-photo get (`report-photo.ts:30`), admin upload get (`admin/uploads/[id].ts:18`),
  admin upload delete (`admin/requests/[id].ts:420`), inspector photo put/get/delete
  (`photos/index.ts:78`, `photos/[photoId].ts:37,105`), publish-time PDF put
  (`publish.ts:71`) and PDF/photo reads inside `report-pdf.ts:240,252`. Every one sits
  behind `requirePortal`, `requireAdmin`, or `requireInspectorReport`. There is no public
  bucket URL, no signed-URL issuance, and no route that serves R2 content unauthenticated.
- Keys are randomized and never derived from user input:
  - Customer uploads: `uploads/${auth.requestId}/${crypto.randomUUID()}.${ext}`
    (`upload.ts:87`) — `requestId` comes from the verified token, `ext` from the
    server-side sniffed type via a fixed lookup table (`upload.ts:29-35,86`), never from
    the filename.
  - Report photos: `reports/${report.id}/photos/${crypto.randomUUID()}.${ext}`
    (`photos/index.ts:76-77`) — `ext` from a fixed three-way ternary on the sniffed type.
  - PDFs: `reports/${report.id}/${versionId}-${newId('pdf')}.pdf` (`publish.ts:70`).
- No path traversal: object keys are only ever read back from D1 rows (`object_key`
  columns) that were written by the server; no user-controlled string is ever concatenated
  into a `.get()`/`.put()`/`.delete()` key. The user-supplied `id` query parameters are
  used solely as bound SQL parameters (`upload.ts:110-113`, `report-photo.ts:21-24`).
- Streams carry `x-content-type-options: nosniff`, `content-security-policy:
  "default-src 'none'; sandbox"`, and `cache-control: private, no-store`
  (`upload.ts:119-127`, `report-photo.ts:33-40`, `photos/[photoId].ts:39-46`,
  `admin/uploads/[id].ts:21-29`), so even a crafted image/HTML polyglot cannot execute
  in the site's origin or be cached by an intermediary.

### 3. Upload validation — CONFIRMED

- True magic-byte sniffing on the buffered bytes, independent of declared MIME:
  - Portal: `sniffImage` (`upload.ts:16-27`) checks JPEG (FFD8FF), PNG (89504E47),
    WebP (RIFF….WEBP), and HEIC/HEIF (ftyp + brand allowlist). Declared MIME is checked
    against the config allowlist first (`upload.ts:74-77`), then the sniff is the hard
    gate (`upload.ts:78-80`); the *sniffed* type — not the declared one — is stored and
    later served (`upload.ts:90,98`).
  - Inspector: `photos/index.ts:17-23` (JPEG/PNG/WebP only; HEIC deliberately excluded
    so PDFs can embed), enforced at `:70-71`. Integration test proves a shell script with
    a `image/jpeg` claim is rejected 422 (`tests/integration/inspector-flow.test.ts:203-208`).
- Size caps: per-file cap checked twice on the portal path — `content-length` header
  pre-check with 64 KB slack before parsing (`upload.ts:49-52`) and the actual
  `file.size` after parsing (`upload.ts:70-72`); default 8 MB
  (`functions/lib/config.ts:171-175`). Inspector: 10 MB (`photos/index.ts:14,63`).
- Count caps: 6 per request (D1 count, `upload.ts:54-60`; `config.ts:172`),
  120 per report (`photos/index.ts:15,47-53`).
- Filename sanitization for display only: `clampStr(file.name, 120).replace(/[^\w.\- ]/g, '_')`
  (`upload.ts:88`) — CR/LF/quotes/Unicode all collapse to `_`; the name is never part of
  the object key.
- Caveat (observation, not a refutation): the `content-length` pre-check treats a missing
  header as 0 (`upload.ts:49`), so the true enforcement for chunked bodies is the
  post-parse `file.size` check — meaning the Worker does buffer the body first. Both
  upload endpoints sit behind auth + rate limiting, and Cloudflare's own request-body
  limit bounds it, so this is a bounded-DoS observation only (see §9).

### 4. Cross-tenant isolation — CONFIRMED (with an honest assessment of the substring check)

- Portal upload GET binds both `id` AND the token's `request_id`
  (`upload.ts:110-113`) — another customer's upload id yields 404 regardless of validity.
- Report photos: `report-photo.ts` resolves the *published version for the token's own
  requestId* first (`report-photo.ts:17`, via `getPublishedVersion` which filters
  `WHERE request_id = ? AND status = 'published'`, `functions/lib/report.ts:728-740`),
  then requires the photo row to match `report_id = version.report_id`
  (`report-photo.ts:21-24`). A photo id from another customer's report can pass the
  substring check only if it literally appears inside *this* customer's published
  payload, and even then the `report_id` bind on the photo lookup kills it. Cross-tenant
  retrieval is structurally impossible. Integration-tested both directions:
  `inspector-flow.test.ts:295-307` (other customer's token → 404 on photo, report, PDF).
- The `payload_json.includes(`"${id}"`)` false-positive analysis (`report-photo.ts:19`):
  - Snapshot photo entries serialize as `"id":"rph_<32hex>"` (`report.ts:532-538`), so
    legitimate ids always match.
  - For a false positive to *leak a draft photo*, all of the following must hold:
    (a) the id is a real `report_photos.id` for the same report (else the SQL lookup
    404s); (b) that photo is excluded from the current published snapshot; (c) the exact
    string `"rph_<hex>"` — including both quote characters — appears elsewhere in the
    payload. Because JSON escapes interior quotes as `\"`, an inspector-typed caption or
    summary containing `"rph_x…"` serializes as `\"rph_x…\"`, which does NOT contain the
    probe substring — except in the single corner case where the id abuts the closing
    quote of the JSON string (e.g. a caption *ending* in `"rph_<hex>`). That requires the
    inspector to paste a quoted draft-photo id at the end of published free text.
  - Ids are `rph_` + 32 random hex chars (`newId`, `functions/lib/util.ts:5-7`) — never
    guessable, never shown in customer-facing UI, and the only party who could plant one
    is the inspector.
  - Worst-case impact if all stars align: the customer sees a draft/removed photo of
    *their own* report. No cross-tenant exposure is reachable under any input.
  - Verdict: theoretically imperfect, practically negligible. Hardening suggestion below
    (§Hardening H1) to make it exact.
- The DELETE-side retention probe uses SQL `LIKE '%"rph_<hex>"%'`
  (`photos/[photoId].ts:95-98`). The `_` in the prefix is a LIKE wildcard, so it matches
  slightly more than intended — but a false positive there merely *retains* an R2 object
  (fail-safe direction). No defect.

### 5. Immutability — CONFIRMED

- DB trigger: `migrations/0002_inspection_reports.sql:150-155` —
  `trg_report_versions_immutable` raises ABORT on any UPDATE of `payload_json`,
  `payload_sha256`, `version`, `report_id`, `request_id`, `kind`, `published_by`,
  `published_at`. Only `status`/`superseded_at`/`pdf_object_key` remain mutable, exactly
  matching the two legitimate writers: supersession on republish (`report.ts:700-702`)
  and the best-effort PDF key write (`publish.ts:72`). Integration test asserts a v1
  payload hash survives amendment (`inspector-flow.test.ts:310-315` ff.).
- Photo delete never destroys published evidence: `photos/[photoId].ts:94-108` checks
  whether ANY version snapshot of the report references the photo id before calling
  `r2.delete`; referenced photos are only soft-deleted in D1 (`:100`), object retained,
  and the audit log records `retainedForVersions` (`:109-113`).
- Published lock returns 423 on every mutation surface: photo POST
  (`photos/index.ts:42-44`), photo PATCH (`photos/[photoId].ts:53`), photo DELETE
  (`photos/[photoId].ts:90`), autosave (`report.ts:259-261` → 423 mapping at
  `save.ts:40`), state moves (`state.ts:26`). Leaving `published` is possible only via
  the amend endpoint, which requires a reason and creates a NEW version on republish
  (`amend.ts:24-31`; `report.ts:699-716`).
- Publication itself requires `ready_for_review` + the request ref typed back as a
  confirmation phrase (`publish.ts:36-39`), and amendments additionally require a reason
  (`publish.ts:41-45`).

### 6. Duplicate/orphan behavior — OBSERVATION (design acceptable, accumulation bounded but unaudited)

- A retried upload creates a fresh UUID object + a fresh D1 row; there is no
  content-hash dedupe. Acceptable: R2 storage is cheap, rows count against the 6/120
  caps, so duplicates self-limit.
- Orphaned R2 objects (object exists, no D1 row) can occur when `r2.put` succeeds and
  the subsequent D1 INSERT fails (`upload.ts:90-99`; `photos/index.ts:78-92` — put
  precedes insert in both). These orphans do NOT count against any cap and are never
  listed or garbage-collected — there is no bucket-listing/reconciliation job anywhere in
  the repo. Accumulation is bounded in practice by auth + rate limits (60/hr portal;
  admin-only inspector), so this is a cost/hygiene issue, not a security issue: orphaned
  keys are unguessable UUIDs and unreachable through any endpoint (every read goes
  through a D1 row).
- The reverse orphan (D1 row, object gone) is handled gracefully everywhere with 404s
  (`upload.ts:117`, `report-photo.ts:31`, `photos/[photoId].ts:38`).
- Admin `delete_upload` hard-deletes intake objects (`admin/requests/[id].ts:414-424`) —
  fine, because intake uploads are never referenced by published report versions
  (separate table, `request_uploads` vs `report_photos`).
- Suggestion H4 below: a periodic orphan-sweep script and/or R2 lifecycle rule.

### 7. Email safety interplay — CONFIRMED

- Record-first: `functions/lib/email.ts:28-40` INSERTs the message row with status
  `recorded` before any network call; the Resend send (`:52-63`) happens after, and
  failure paths only UPDATE that row to `failed` (`:70-74`) — nothing upstream is rolled
  back. The publish flow treats notifications as the final step after the version is
  committed (`publish.ts:96-108`), and PDF storage failure is explicitly best-effort with
  an audit record (`publish.ts:75-78`). An email outage can never unwind a stored
  request, version, or photo.
- Dedupe: `migrations/0002_inspection_reports.sql:178-179` — partial UNIQUE index on
  `messages(dedupe_key)`. `sendEmail` converts the constraint violation into a
  `duplicate` status without resending (`email.ts:36-39`). Publish uses
  `report_ready:<versionId>` / `report_published_owner:<versionId>` keys
  (`publish.ts:101,107`), so retries and replays cannot double-send. Integration-tested:
  exactly one `report_ready` message after publish (`inspector-flow.test.ts:263-269`).
- Production pinning: `RESEND_API_BASE` override is ignored when `PPI_ENV=production`
  (`email.ts:48-49`) — no SSRF-via-config into the email path in prod.

### 8. CORS — CONFIRMED

- `functions/_middleware.ts:42-44`: CORS is scoped to `pathname.startsWith('/api/ppi/')`
  OR `pathname === '/api/portal/upload'` (exact match). Response headers are added only
  for those paths (`:88-90`); preflights for every other `/api/*` path get a bare 405
  (`:66-69`) — deliberately preventing `wrangler dev`'s permissive `*` fallback from ever
  reaching admin/inspector surfaces.
- Allowed origins: only `PUBLIC_FORM_ORIGINS` + `PUBLIC_BASE_URL`, parsed strictly to
  origins (`functions/lib/cors.ts:13-40`); non-allowlisted origins get no
  `access-control-allow-origin` at all, and `vary: origin` is set. Production config
  allowlists only `getautoclarity.com` and `www.getautoclarity.com` (`wrangler.toml:41`).
- Admin/inspector endpoints never emit CORS headers (no call site outside the middleware
  path gate — grep-verified), and mutations additionally enforce `originAllowed`
  (`functions/lib/util.ts:80-94`) server-side, which also protects the portal upload POST
  (`upload.ts:39-41`) against cross-site form posts from non-allowlisted origins.
- Covered by `tests/unit/cors.test.ts` (8 tests, passing).

### 9. Other material findings

Everything below was checked; findings are ranked in the defects section.

- **SQL injection**: none — every query uses bound parameters; the two dynamic
  `SET`-clause builders (`photos/[photoId].ts:64-81`, `report.ts:281-315`) join only
  hard-coded column fragments and bind all values.
- **SSRF**: the only outbound fetches in `functions/` are Stripe (fixed base;
  test-override refused in production, `functions/lib/stripe.ts`), Resend (same,
  `email.ts:48-49`), NHTSA vPIC with a `[A-Z0-9]`-normalized VIN
  (`functions/lib/vin.ts:5-7,92-94`), and the Access certs endpoint built from the
  env-configured team domain (`auth.ts:59`). No user-controlled URL is ever fetched.
- **Header injection / content-disposition**: filenames are sanitized to
  `[\w.\- ]` at write time (`upload.ts:88`) and quote-stripped at serve time
  (`upload.ts:122`, `admin/uploads/[id].ts:24`); PDF filenames derive from the
  server-generated ref (fixed alphabet, `util.ts:10-19`; `report-pdf.ts:230-233`).
  CR/LF cannot survive either filter. No injection possible.
- **Cache poisoning**: all dynamic responses get `cache-control: no-store` from the
  middleware (`_middleware.ts:86`), image/PDF streams additionally set
  `private, no-store`; nothing user-controlled reaches a cacheable URL.
- **DoS via body parsing**: both upload POSTs buffer the full body in memory
  (`upload.ts:78`, `photos/index.ts:69`) and `request.formData()` runs before the
  per-file size check can see actual bytes. Mitigations already present: auth + IP rate
  limit run *before* any body read, `content-length` pre-check rejects honest oversize
  early, and Cloudflare's platform request-size limit caps the rest. Residual risk: a
  token-holding customer can burn Worker CPU/memory with ~60 near-limit bodies per hour.
  Low severity, bounded, acceptable.
- **HEIC**: accepted from customers (sniffed brand allowlist, `upload.ts:21-25`), stored
  and served back with `image/heic` + sandbox CSP. Non-Safari admin browsers may not
  render HEIC inline — availability nit, not security. Inspector photos exclude HEIC by
  design so PDF embedding stays JPEG-only.
- **`img.onerror` recode fallback (EXIF/GPS)** — real, small, and worth knowing about:
  `assets/js/inspector-report.js:763-787` downscales inspector photos to JPEG via canvas
  (which strips EXIF, including GPS). But when the browser cannot decode the file,
  `img.onerror` resolves with the ORIGINAL file (`:784`). If that original is a JPEG the
  browser choked on (or any sniffable JPEG/PNG/WebP), the server accepts it with full
  EXIF/GPS/device metadata intact. Who sees those bytes: the inspector UI, and — if the
  photo is published — the customer, both via the streaming endpoint
  (`report-photo.ts:33-40`, raw bytes) and the PDF, which embeds the untouched JPEG
  stream via DCTDecode (`report-pdf.ts:191-199`, `pdf.photo`). Practical exposure is the
  inspector's own device metadata and the inspection-site GPS (usually the seller's
  location, which the customer already knows) — but photos taken elsewhere (e.g. the
  founder's home) that fail decode would leak their coordinates to the customer.
  HEIC originals hitting this fallback are harmlessly rejected server-side (inspector
  endpoint accepts no HEIC). Customer intake uploads are never client-recoded at all
  (`assets/js/ppi-form.js:670-690`), so customer EXIF/GPS reaches R2 as-is — visible
  only to the customer themselves and the Access-gated admin. Ranked as D2 below.
- **Portal rate limit vs. photo-heavy reports (availability, will appear only after R2
  go-live)**: every `report-photo` image load is a full `requirePortal` pass, and each
  pass increments the same fixed-window IP limit of 60/hr (`portal.ts:16`). The customer
  report page loads photos via `/api/portal/report-photo?id=…&t=…`
  (`assets/js/ppi-portal-report.js:39`) with `loading="lazy"`
  (`assets/js/report-render.js:50,176`). A published report may carry up to 120 photos
  (`photos/index.ts:15`). A customer scrolling a photo-rich report — or refreshing a few
  times, or a household behind one NAT IP — can exceed 60 requests/hr, at which point ALL
  portal endpoints (view, report, PDF, photos) return 429 for up to an hour. Today this
  is invisible because no photos exist; the day R2 is enabled and the first 40-photo
  report is published, it becomes reachable in normal use. Ranked as D1 below.
- **`UPLOADS_ENABLED` fail-open default**: `modeFlags` treats *unset* as enabled
  (`types.ts:60`, `!== 'false'`), and the portal POST then calls `env.UPLOADS.put`
  unguarded (`upload.ts:90`). If the var were ever removed while the binding is absent,
  customers get 500s instead of the clean 409. The inspector side is safe
  (`r2OrNull`, `inspector.ts:38-41` returns null on missing binding). Robustness note,
  O3 below.

---

## Ranked material defects

No critical or high-severity security defects were found. The two items below are
material enough to fix around go-live; neither blocks it.

**D1 — MEDIUM (availability, triggered by this rollout): portal rate limit will 429
legitimate customers on photo-heavy reports.**
`functions/lib/portal.ts:16` (60/hr/IP shared across ALL portal endpoints) ×
`functions/api/inspector/reports/[id]/photos/index.ts:15` (120-photo cap) ×
`assets/js/ppi-portal-report.js:39` (one authenticated request per image).
Concrete failure: publish a report with 45 photos; the customer opens it on mobile,
scrolls to the photo sections (lazy-load fires ~45 requests), reloads once — the next
request 429s and the entire portal (report, PDF, everything) is dead for that IP for up
to an hour, right at the moment of maximum customer attention. Fix options: exempt or
separately bucket `report-photo` GETs (e.g. 600/hr), skip the rate-limit increment on
image streams after the first token verification, or batch photos into the report
payload. One-line change in `requirePortal` call sites either way.

**D2 — LOW (privacy): decode-failure fallback uploads un-recoded originals with EXIF/GPS
that can reach the customer.**
`assets/js/inspector-report.js:784` resolves the original file on `img.onerror`; server
keeps sniffable JPEGs verbatim (`photos/index.ts:69-78`); published bytes stream to the
customer verbatim (`report-photo.ts:33`) and embed verbatim in the PDF
(`report-pdf.ts:191-199`). Failure scenario: an inspector photo taken off-site that the
mobile browser fails to decode (memory pressure on large images is the realistic trigger)
publishes with GPS coordinates of wherever it was taken. Fix options: reject the upload
client-side instead of falling back; or strip EXIF server-side (JPEG APP1 segment removal
is ~30 lines, no re-encode needed); or at minimum surface "original uploaded without
processing" in the editor UI so the inspector knows.

---

## Observations & hardening suggestions (not defects)

**H1 — Make the published-photo membership check exact.** Replace the substring probe at
`functions/api/portal/report-photo.ts:19` with a parse-and-walk of the snapshot's photo
ids (`sections[].items[].photos[].id` + `generalPhotos[].id` — `report.ts:568,641`), or
keep the substring test as a fast pre-filter and confirm with the parsed set. Eliminates
the contrived caption corner case in §4 and makes the intent auditable.

**H2 — Escape LIKE wildcards in the delete-retention probe** at
`photos/[photoId].ts:96-97` (`_` in `rph_` is a single-char wildcard). Current behavior
errs safe (over-retains), so this is cosmetic correctness.

**O3 — Guard the portal upload POST on binding presence.** Mirror `r2OrNull` in
`upload.ts` (check `env.UPLOADS` truthiness alongside `flags.uploadsEnabled`) so a
missing binding yields the honest 409 instead of a 500. Matters for preview branches
deployed without the binding after `UPLOADS_ENABLED=true` lands in `wrangler.toml`.

**H4 — Orphan hygiene.** Add a reconciliation script (list bucket keys → check
`request_uploads.object_key` / `report_photos.object_key` / `report_versions.pdf_object_key`
→ report or delete strays older than N days) and run it occasionally. Today orphans are
unreachable and rate-bounded, but they are also invisible.

**H5 — EXIF stripping server-side for customer intake uploads** would also remove GPS
from what the admin sees, if that is desired; currently intake photos retain full
metadata by design (they are evidence of a listing, and only the Access-gated admin and
the uploading customer can view them).

**H6 — `nbf` claim check** in `verifyAccessJwt` (`auth.ts:51-54`) for completeness.

**O7 — Magic tokens ride in `?t=` query strings** (portal page, image tags, PDF links).
Mitigated: `referrer-policy: no-referrer` on all `/api/*` responses
(`_middleware.ts:85`), `no-store` everywhere, links rotate on every reissue/publish
(`magic.ts:29-34`), 14-day TTL (`config.ts:170`). Residual exposure is server-side
request logs only. Acceptable for a magic-link design; noted for awareness.

**O8 — Publish-time PDF read-back pattern** (`publish.ts:58-74`) re-reads every photo
from R2 and renders the PDF inside the request; with 120 photos × 10 MB this could
approach Worker memory/CPU limits and trip the (well-handled) `pdf_store_failed`
fallback. On-demand rendering then serves customers, so worst case is a slower first
download. No action needed; keep the photo counts sane.

---

## Go / No-Go

**GO** — with two conditions attached:

1. **Fix or consciously accept D1 before the first photo-heavy report is published.**
   The rate-limit interaction is the one thing in this review that will predictably bite
   a real customer as a direct consequence of enabling R2. It is a small, safe change
   (separate bucket or higher limit for `report-photo` GETs) and is best shipped in the
   same window as the binding.
2. **Confirm the production `UPLOADS_ENABLED=true` flip lands together with the
   uncommented binding** (`wrangler.toml:53-55`), since the portal POST 500s (rather than
   409s) if the flag is on while the binding is absent (O3).

The core security posture is sound and genuinely fail-closed: every R2 byte in and out
passes a verified identity check scoped to the owning request/report; keys are
unguessable and never user-derived; published snapshots are trigger-enforced immutable;
published evidence survives deletion; CORS is tightly scoped; email failures cannot
corrupt state; and the production dev-key/Access behavior is both implemented and
unit-tested. D2 and the hardening items are quality-of-privacy improvements, not
gating risks. Stripe remains test/disabled and is unaffected by this change.
