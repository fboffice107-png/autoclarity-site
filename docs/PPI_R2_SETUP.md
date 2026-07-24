# R2 photo/PDF storage — owner activation steps

Report photos and stored PDFs are feature-flagged on Cloudflare R2. R2 is
**not enabled on the account yet** (re-verified 2026-07-23: the API returns
error 10042 "enable R2 through the Cloudflare Dashboard" — dashboard-only,
cannot be done from the CLI). Everything except photo upload/display and
publish-time PDF storage works without it (PDFs render on demand instead);
the hosted preview honestly reports `uploads_disabled`. The full photo path
(upload → finding → publish → HTML + PDF parity → per-customer isolation) is
already covered by the integration tests against a local R2, so activation is
configuration only. No code changes are needed to turn it on.

1. **Dashboard** → R2 → **Enable R2** (accept terms; the free tier may still
   ask for a card — this does not add a paid service by itself).
2. Create the bucket:
   ```bash
   npx wrangler r2 bucket create autoclarity-ppi-uploads
   ```
3. In `wrangler.toml`, un-comment the `[[r2_buckets]]` block:
   ```toml
   [[r2_buckets]]
   binding = "UPLOADS"
   bucket_name = "autoclarity-ppi-uploads"
   ```
4. Set `UPLOADS_ENABLED = "true"` in `[vars]` (same file).
5. Redeploy:
   ```bash
   npx wrangler pages deploy . --project-name autoclarity-site --branch main --commit-dirty=true
   ```
6. Verify: open a report in the editor — the per-item "📷 Add photo" button
   replaces the "Photo storage is off" note. Upload one photo, publish a test
   report, confirm the photo appears in the customer report and the PDF, and
   that `report_versions.pdf_object_key` is set on the new version.

Notes:
- The bucket is private; nothing in it is ever served directly or publicly.
  All reads go through authorized Worker endpoints with randomized keys.
- Customer intake uploads (`request_uploads`) share the same binding and
  activate at the same time.
- Local dev and the integration tests already run with a **local** R2
  (`--r2 UPLOADS`), so the photo path is fully tested today.
