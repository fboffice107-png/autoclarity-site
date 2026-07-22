#!/usr/bin/env bash
# One-time Cloudflare resource setup + first preview deploy for the PPI portal.
# Requires: npx wrangler login (already authenticated). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="autoclarity-site"
DB_NAME="autoclarity_ppi"
BUCKET="autoclarity-ppi-uploads"
BRANCH="$(git branch --show-current)"

echo "== Checking wrangler auth =="
npx wrangler whoami >/dev/null || { echo "Run: npx wrangler login"; exit 1; }

echo "== D1 database =="
if ! npx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
  npx wrangler d1 create "$DB_NAME"
fi
# Resolve the database_id from `d1 list` by NAME (do not use `d1 info`, which
# reads the placeholder id out of wrangler.toml and fails). Falls back to
# parsing `d1 create` output if list is unavailable.
DB_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);const r=a.find(x=>x.name==='$DB_NAME');console.log(r?(r.uuid||r.database_id||''):'')}catch{console.log('')}})")
if [ -n "$DB_ID" ] && [ "$DB_ID" != "00000000-0000-0000-0000-000000000000" ]; then
  node -e "
    const fs=require('fs');
    let t=fs.readFileSync('wrangler.toml','utf8');
    t=t.replace(/database_id = \"[0-9a-f-]+\"/, 'database_id = \"$DB_ID\"');
    fs.writeFileSync('wrangler.toml', t);
    console.log('wrangler.toml patched with database_id $DB_ID');
  "
else
  echo "WARN: could not resolve database_id automatically — set it in wrangler.toml manually (see 'npx wrangler d1 list')."
fi

echo "== R2 bucket (requires R2 enabled in the dashboard) =="
npx wrangler r2 bucket create "$BUCKET" 2>/dev/null || echo "R2 bucket not created (enable R2 in the dashboard, then re-run: npx wrangler r2 bucket create $BUCKET). Uploads stay disabled until then."

echo "== Pages project =="
npx wrangler pages project create "$PROJECT" --production-branch main 2>/dev/null || echo "project exists"

echo "== Remote migrations (preview DB) =="
npx wrangler d1 migrations apply "$DB_NAME" --remote

echo "== Preview deploy from branch: $BRANCH =="
npx wrangler pages deploy . --project-name "$PROJECT" --branch "$BRANCH"

cat <<'EOF'

NEXT (manual, ~5 min — see docs/PPI_CLOUDFLARE_SETUP.md):
 1. Set preview secrets: ADMIN_DEV_KEY, TURNSTILE_SECRET_KEY, STRIPE_SECRET_KEY
    (sk_test_ only), STRIPE_WEBHOOK_SECRET, optional RESEND_API_KEY/EMAIL_FROM/
    ADMIN_NOTIFY_EMAIL:
      npx wrangler pages secret put ADMIN_DEV_KEY --project-name autoclarity-site
 2. Set preview var PUBLIC_BASE_URL to the printed preview URL.
 3. Protect the preview with Cloudflare Access (Zero Trust -> Applications).
 4. Open <preview>/ppi/admin/ -> seed fixtures -> test on your iPhone.
EOF
