# Independent Workflow & Data-Integrity QA Review — PPI Portal Staging

Date: 2026-07-24 (21:17–21:30 PDT) — independent second-pair-of-eyes review
Target: http://localhost:8790 (`wrangler pages dev`, preview env, local D1 + local R2)
Reviewer: independent QA agent (no repo edits except this file; no git; no wrangler; no reseed; no server restarts; production untouched)

## Executive summary

**The end-to-end workflow QA could NOT be executed.** The staging server on :8790 is in a
wedged state: every endpoint that touches D1 returns **HTTP 500** ("internal error;
reference=..." from workerd's Durable Object storage layer), persistently, over ~15 minutes
of retries. Root cause (evidence below): the `.wrangler/` state directory was **deleted out
from under the running dev server** and then recreated + migrated + seeded by *separate*
wrangler processes at 21:15. The running server still holds orphaned (deleted-inode) storage
handles and cannot open the current database directory. Only a restart of `wrangler pages dev`
can recover it, and restarting was explicitly out of scope for this review.

Consequence for the "already proven" claim: the timestamps and inode evidence show the
fixture data now on disk was written 21:15:55–21:16:01 by an automated seed/integration run
in *separate processes* — **not through the :8790 server as it currently runs**. Whatever was
proven, it was not proven against the server instance now listening on :8790.

## Environment forensics (evidence)

| # | Evidence | Detail |
|---|---|---|
| 1 | Process table | `wrangler pages dev . --port 8790` started 21:02 (node pid 81343); proxy workerd pid 81351 owns 127.0.0.1:8790; user workerd pid 83850 spawned **21:15:42** by a hot reload, listens on 127.0.0.1:59119 (matches last `reloadComplete` userWorkerUrl in wrangler log) |
| 2 | Wrangler log `~/.wrangler/logs/wrangler-2026-07-25_04-02-13_556.log` | 04:15:35.741Z build FAILURE: `Could not resolve ".wrangler/tmp/bundle-8eLHQ8/middleware-loader.entry.ts"` — the tmp dir was deleted mid-run — followed by "Reloading local server..." |
| 3 | Wrangler log `wrangler-2026-07-25_04-15-54_869.log` | separate `wrangler d1 migrations apply --local` at 21:15:54 recreated schema (0001_init.sql, 0002_inspection_reports.sql) in `.wrangler/state/v3/d1` |
| 4 | Wrangler log `wrangler-2026-07-25_04-15-56_478.log` | a second short-lived wrangler dev instance at 21:15:56 (own proxy secret, user worker port 59165) — the likely vehicle for the seed/integration run |
| 5 | **Inode mismatch (smoking gun)** | on-disk `d1/miniflare-D1DatabaseObject/metadata.sqlite` = inode **1121910**; workerd 83850 holds the same path open at deleted inode **1121495**. R2: disk inode **1121941** vs held **1121528**. The live server's storage handles point at unlinked files/directories → every D1 open fails → 500 |
| 6 | Data timestamps | all fixture rows, magic-link `used_at`, and rate-limit counters written 04:15:55–04:16:01Z (a ~6-second window; 32 `portal_token` hits, 3 `portal_photo` hits) — automated run, not interactive HTTP proof against :8790 |
| 7 | DB itself is healthy | `PRAGMA integrity_check` = ok (read-only external open); all tables present; fixtures intact |

## Check results

Legend: PASS = observed as expected; FAIL = observed contrary to expectation;
BLOCKED = could not execute because the D1 layer 500s on the running server.

### A. Checks that do not touch D1 (executed)

| Check | Expected | Observed | Result |
|---|---|---|---|
| GET `/` (static) | 200 | **200** | PASS |
| GET `/api/admin/overview` no auth | 401 | **401** + `x-content-type-options: nosniff`, `cache-control: no-store`, `x-robots-tag: noindex` | PASS |
| GET `/api/admin/overview` wrong key | 401 | **401** | PASS |
| OPTIONS `/api/admin/overview` | 405 (no permissive preflight on admin) | **405** | PASS |
| GET `/wrangler.toml` | 404 (repo-file denylist) | **404** | PASS |
| GET `/.dev.vars` | 404 | **404** | PASS |
| GET `/api/inspector/inspections` (GET on POST-only route) | 404 | **404** | PASS (expected fall-through) |

### B. Workflow checks (task steps 1–7) — all BLOCKED by the wedged D1 layer

| Step | Check | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | GET `/api/admin/overview` (pick fixture) | 200 | **500** internal error (x5 retries over 15 min) | BLOCKED |
| 1 | GET `/api/admin/requests` | 200 | **500** | BLOCKED |
| 1 | GET `/api/inspector/overview` | 200 | **500** | BLOCKED |
| 1 | POST `/api/inspector/inspections` for CAMRY | 200 or explicit status-gate error | not attempted — auth precedes DB but the first DB call would 500; a mutation attempt against a wedged storage layer risks partial writes | BLOCKED |
| 2 | POST save draft; stale `baseSeq` | 200 then **409** (`save.ts:40`) | not executable | BLOCKED |
| 2 | Photo upload: real JPEG / text-as-.jpg / >10 MB / unknown itemKey | 200 / **422** / **413** / **422** (`photos/index.ts:62-71`) | not executable | BLOCKED |
| 3 | Photo GET headers | `image/jpeg`, `nosniff`, `CSP default-src 'none'; sandbox`, `cache-control: private, no-store` (`report-photo.ts:55-62`, `photos/[photoId].ts`) | not executable | BLOCKED |
| 4 | DELETE draft-only photo | `retainedForVersions:false`, then GET **404** (`[photoId].ts:100-114`) | not executable | BLOCKED |
| 5 | Reissue magic link; unpublished report → portal 404; cross-tenant photo probe → 404 | 200 / 404 / 404 | not executable — and see Finding 2: the supplied PAIDOK photo id no longer exists | BLOCKED |
| 6 | Portal upload: real JPEG / PNG-declared-JPEG / txt-as-.jpg / 7th file | ok / server sniff decides (sniff wins, `upload.ts:80-82`) / **422** / **409** `upload_limit` | GET `/api/portal/report?t=<bogus>` → **500** (rate-limit table is the first D1 touch); further portal calls pointless | BLOCKED |
| 7 | Rate-limit sanity (≤60 general portal calls) | normal GETs still 200 | only 2 portal calls spent (both 500 before rate accounting); budget respected but nothing to measure | BLOCKED |

### C. Read-only data-integrity checks on the on-disk D1/R2 (executed via `sqlite3 mode=ro`)

| Check | Observed | Result |
|---|---|---|
| D1 `PRAGMA integrity_check` | ok | PASS |
| Fixtures present | 15 requests incl. PPI-FIXTURE-CAMRY (`submitted`, untouched by me), PAIDOK (`completed`), VETTE/LAMBO (`ready_for_review`) | PASS |
| PAIDOK report chain | `rpt_164fc7f46f634b1ca0f263ae9555b9fa` state=published, current v2 (`rv_14ca65bb…`); v1 and v2 version rows both published | PASS |
| PAIDOK photo ↔ R2 ↔ blob linkage | photo row `rph_ab0d1044928f4a309127f21775b3d9f9` → `reports/rpt_164fc…/photos/46c727ac-….jpg` → R2 `_mf_objects` row → 23-byte blob on disk; both version PDFs also present as R2 objects+blobs | PASS (linkage) |
| Task-supplied cross-tenant probe id `rph_2dc38ce1b2f946669a64588b2e518115` | **does not exist** anywhere in the DB | FINDING 2 |
| `request_uploads` ↔ R2 | row `upl_d07d22f0…` (req PPI-260725-3KAQ) references `uploads/req_d031…/….png` — **no matching R2 object** (store holds only 3 objects) | FINDING 5 |
| Rate-limit buckets | `portal_photo` bucket exists in code (`lib/portal.ts`: 600/hr for image streams; default `portal_token` 60/hr) and in data (3 hits recorded) | PASS (existence only) |

## Defects / findings, ranked

1. **BLOCKER (environment, not product code)** — staging server on :8790 is unusable: every
   D1-touching route returns 500 (`workerd` internal error at miniflare `object-entry.worker`).
   Reproduce: `curl -H "authorization: Bearer <dev key>" http://localhost:8790/api/admin/overview`
   → 500. Also 500: `/api/admin/requests`, `/api/inspector/overview`, `/api/ppi/runtime-config`,
   `/api/portal/report`, `/api/portal/report-photo` — on :8790 AND directly on the live user
   worker port 59119. Cause: `.wrangler/` deleted under the running server, then rebuilt by
   external processes (inode evidence above). Fix: restart `wrangler pages dev` (out of my
   scope). **Never delete `.wrangler/` or run `wrangler d1 … --local` while the dev server runs.**

2. **HIGH (process/evidence integrity)** — the "proven workflow" evidence does not match the
   current DB. The PAIDOK photo id supplied for the cross-tenant probe
   (`rph_2dc38ce1b2f946669a64588b2e518115`) is absent from the on-disk database; the actual
   PAIDOK photo is `rph_ab0d1044928f4a309127f21775b3d9f9`. The DB was rebuilt at 21:15:55
   after that proof. Everything previously proven needs re-running against a restarted server.

3. **MEDIUM (code observation; could not verify over HTTP)** — image validation on both upload
   paths is magic-byte sniffing only (`functions/api/inspector/reports/[id]/photos/index.ts:17-23,69-71`
   and `functions/api/portal/upload.ts:16-27,80-82`); nothing decodes the image. The seeded
   PAIDOK "photo" is a fabricated **23-byte** JPEG (SOI + SOF0 declaring 640×480 + EOI, zero
   scan data) stored as `image/jpeg`, width/height NULL. If the announced "decode-failure
   refusal" fix was meant to reject undecodable images at upload, it is not present on these
   endpoints; if it lives only in the PDF path (`lib/pdf.ts` JPEG parsing), a customer-facing
   portal photo can still be an unrenderable blob. Also: the photo-stream proof therefore
   streamed a 23-byte stub, never a real image. Re-test with a genuine JPEG after restart.

4. **LOW (local-dev only, worth knowing)** — unhandled storage exceptions bypass the
   security-header middleware: the D1-500 responses carry NO `x-content-type-options`,
   `cache-control` or `x-robots-tag` and the body leaks a local filesystem path
   (`/Volumes/Super Storage/…/miniflare/...`). In hosted Pages an exception yields the CF
   error page instead, so this is not directly a production exposure, but the middleware's
   header guarantees only hold for responses the handlers actually return.

5. **LOW (fixture data integrity)** — orphaned customer upload: `request_uploads` row
   `upl_d07d22f00afc4d478c7e35c8ee639c12` points at an R2 object that does not exist in the
   store (casualty of the state rebuild). Harmless locally; on production this shape of
   inconsistency would render a broken image in the portal, so the R2-object-existence 404
   path (`upload.ts:119-120`) is doing real work — keep it.

Positive observations: admin auth fails closed without touching storage (401s with correct
security headers), OPTIONS on admin APIs is refused (405) rather than picking up permissive
dev-server CORS, repo housekeeping files are unreachable (404), and the D1 file itself is
internally consistent with a coherent PAIDOK publish chain (v1+v2, snapshot-linked photo,
both version PDFs in R2).

## Verdict

**Not certifiable — behavioral verification incomplete (0 of the 7 workflow steps executable).**
This is an environment failure, not a demonstrated product failure: the D1 file is intact, the
auth/middleware surfaces that could be exercised behaved exactly as designed, and the code
paths for every expected status (409 stale-seq, 422/413 upload rejections, photo security
headers, retainedForVersions delete, portal publish gating, 600/hr photo bucket) are present
in source. But none of that has been observed over HTTP against the server as it now runs, the
prior session's proof predates the current database (Finding 2), and the one "photo" the
pipeline has ever served is a 23-byte stub (Finding 3). Before production: restart
`wrangler pages dev`, re-seed cleanly if needed, and re-run this checklist end-to-end with a
real JPEG — expect roughly 30–45 minutes of curl work using the expected-status table above.
Do not ship on the strength of the existing evidence alone.

---

## Reconciliation addendum (primary session, after the review)

The reviewer's environment forensics were correct and identified a real
operational root cause: **the integration suite's global setup rebuilds
`.wrangler/state`, so running `npm test` while a `wrangler pages dev` server
is running deletes the database out from under it** (deleted-inode wedge →
persistent 500s). This explains both this review's blocked state and an
earlier same-session anomaly. Rule going forward (also added to the handoff):
**never run `npm test` while a local dev server is up; restart the server
after any test run.**

Point-by-point reconciliation:

- **Finding 1 (BLOCKER, environment)** — accepted. The server was restarted
  cleanly and re-seeded.
- **Finding 2 (evidence integrity)** — the review is right that the on-disk
  DB no longer matches the earlier proof (the 21:15 `npm test` rebuilt it).
  The earlier workflow evidence was, however, gathered as live HTTP/browser
  observations BEFORE the wipe, and its artifacts persist (v1 PDF 173,769 B
  with 2 DCTDecode JPEG streams; v2 PDF 103,626 B with 1; recorded status
  matrices). The "23-byte stub photo" belongs to the integration harness's
  seeded fixture in the REBUILT DB — the earlier session uploads streamed at
  70,139/74,960 bytes and decoded at 1600×1200 in the browser.
- **Finding 3 (sniff-only validation)** — correct observation; the server
  intentionally sniffs magic bytes and does not decode (Workers have no
  image codec). The inspector CLIENT re-encodes every photo before upload
  (and now refuses un-decodable files). A malformed-but-sniffable upload can
  therefore be stored, is bounded by auth + caps, renders as a broken image
  only in that customer's own report, and cannot execute (CSP sandbox +
  nosniff). Accepted as a documented limitation.
- **Findings 4–5 (local-dev 500 header leak; orphaned fixture upload row)** —
  accepted as local-dev observations; the hosted platform error path differs
  and the 404-on-missing-object path is covered by tests.

### Re-validation on the restarted, clean server (all executed over HTTP)

| Check | Expected | Observed |
|---|---|---|
| Real 100,765-byte photographic JPEG (PIL-generated 2000×1500) upload to `brakes.rear_pads` | 200 + dims | **200**, width 2000 height 1500, caption stored |
| Text file as `.jpg` (declared image/jpeg) | 422 | **422** |
| 11 MB file | 413 | **413** |
| Unknown itemKey | 422 | **422** |
| Stream back | 200 image/jpeg + nosniff + CSP sandbox + no-store | **all present**, 100,765 bytes byte-identical, PIL decodes as JPEG 2000×1500 |
| DELETE draft-only photo | retainedForVersions:false | **confirmed** |
| GET after delete | 404 | **404** |
| Runtime flags | uploads on, payments OFF | **confirmed** |

Verdict after reconciliation: the behavioral evidence for the photo workflow
stands (original session artifacts + this clean-server re-validation); the
review's environment findings are fixed and its process rule is adopted.
