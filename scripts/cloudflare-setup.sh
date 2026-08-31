#!/usr/bin/env bash
# Guarded creation of an ISOLATED Cloudflare preview. This intentionally cannot
# target AutoClarity's known production resource names and never modifies the
# tracked local configuration.
set -euo pipefail
cd "$(dirname "$0")/.."

VALIDATE_ONLY=false
case "${1:-}" in
  "") ;;
  --validate-only) VALIDATE_ONLY=true ;;
  *)
    echo "Usage: $0 [--validate-only]" >&2
    exit 2
    ;;
esac

require_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

require_preview_resource() {
  local label="$1"
  local value="$2"

  # A required lowercase `-preview` suffix is easier to review than a growing
  # denylist of production-like names. It also prevents values beginning with
  # `-` from being interpreted as Wrangler options.
  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9-]{1,54}-preview$ ]]; then
    echo "$label must be a lowercase Cloudflare name ending in -preview." >&2
    exit 1
  fi
}

require_var AC_PREVIEW_PROJECT
require_var AC_PREVIEW_DB
require_var AC_PREVIEW_BUCKET
require_var AC_PREVIEW_BRANCH
require_var AC_PREVIEW_PUBLIC_BASE_URL

require_preview_resource "Preview project" "$AC_PREVIEW_PROJECT"
require_preview_resource "Preview database" "$AC_PREVIEW_DB"
require_preview_resource "Preview bucket" "$AC_PREVIEW_BUCKET"

if [[ ! "$AC_PREVIEW_BRANCH" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "Preview branch must contain only lowercase letters, numbers, and hyphens." >&2
  exit 1
fi
case "$AC_PREVIEW_BRANCH" in
  main|master|production|preview-only)
    echo "Preview branch must not be a production branch." >&2
    exit 1
    ;;
esac

EXPECTED_PREVIEW_URL="https://${AC_PREVIEW_BRANCH}.${AC_PREVIEW_PROJECT}.pages.dev"
if [ "$AC_PREVIEW_PUBLIC_BASE_URL" != "$EXPECTED_PREVIEW_URL" ]; then
  echo "Preview public base URL must be exactly: $EXPECTED_PREVIEW_URL" >&2
  exit 1
fi

if [ "${CONFIRM_ISOLATED_PREVIEW:-}" != "YES" ]; then
  echo "Refusing remote changes. Set CONFIRM_ISOLATED_PREVIEW=YES after reviewing the isolated preview names." >&2
  exit 1
fi

if [ ! -f wrangler.local.toml ]; then
  echo "Missing wrangler.local.toml preview template." >&2
  exit 1
fi

if [ "$VALIDATE_ONLY" = true ]; then
  echo "Isolated preview inputs validated; no files or remote resources were changed."
  exit 0
fi

CONFIG_PATH=".wrangler/preview/wrangler.toml"
mkdir -p "$(dirname "$CONFIG_PATH")"
cp wrangler.local.toml "$CONFIG_PATH"

echo "== Checking Cloudflare authorization =="
npx --no-install wrangler whoami >/dev/null

echo "== Creating or locating isolated preview D1 =="
if ! npx --no-install wrangler d1 info "$AC_PREVIEW_DB" >/dev/null 2>&1; then
  npx --no-install wrangler d1 create "$AC_PREVIEW_DB"
fi
DB_ID="$(npx --no-install wrangler d1 info "$AC_PREVIEW_DB" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log(x.uuid||x.id||'')})")"
if [[ ! "$DB_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Could not resolve the isolated preview database ID." >&2
  exit 1
fi

node - "$CONFIG_PATH" "$AC_PREVIEW_PROJECT" "$AC_PREVIEW_DB" "$DB_ID" "$AC_PREVIEW_BUCKET" "$AC_PREVIEW_PUBLIC_BASE_URL" <<'NODE'
const fs = require('fs');
const [path, project, database, databaseId, bucket, publicBaseUrl] = process.argv.slice(2);
let source = fs.readFileSync(path, 'utf8');
function replaceRequired(pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Missing ${label} in local config template`);
  source = source.replace(pattern, replacement);
}
replaceRequired(/^name = ".*"$/m, `name = "${project}"`, 'project name');
replaceRequired(/^database_name = ".*"$/m, `database_name = "${database}"`, 'database name');
replaceRequired(/^database_id = ".*"$/m, `database_id = "${databaseId}"`, 'database ID');
replaceRequired(/^bucket_name = ".*"$/m, `bucket_name = "${bucket}"`, 'bucket name');
replaceRequired(/^PUBLIC_BASE_URL = ".*"$/m, `PUBLIC_BASE_URL = "${publicBaseUrl}"`, 'public base URL');
fs.writeFileSync(path, source);
NODE

echo "== Creating isolated preview R2 and Pages project =="
if ! npx --no-install wrangler r2 bucket info "$AC_PREVIEW_BUCKET" >/dev/null 2>&1; then
  npx --no-install wrangler r2 bucket create "$AC_PREVIEW_BUCKET"
fi
PROJECT_EXISTS="$(npx --no-install wrangler pages project list --json | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  const parsed = JSON.parse(s);
  const projects = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed.result) ? parsed.result
    : Array.isArray(parsed.projects) ? parsed.projects
    : null;
  if (!projects) throw new Error("Unexpected Pages project-list response");
  console.log(projects.some(project => project.name === process.argv[1]) ? "yes" : "no");
});
' "$AC_PREVIEW_PROJECT")"
if [ "$PROJECT_EXISTS" = "no" ]; then
  npx --no-install wrangler pages project create "$AC_PREVIEW_PROJECT" --production-branch preview-only
elif [ "$PROJECT_EXISTS" != "yes" ]; then
  echo "Could not verify the isolated preview Pages project." >&2
  exit 1
fi

echo "== Applying migrations only to the isolated preview D1 =="
npx --no-install wrangler d1 migrations apply DB --remote --config "$CONFIG_PATH"

echo "== Deploying isolated preview branch =="
npx --no-install wrangler pages deploy . --config "$CONFIG_PATH" --project-name "$AC_PREVIEW_PROJECT" --branch "$AC_PREVIEW_BRANCH"

cat <<EOF

Preview deployment complete. Generated config: $CONFIG_PATH (gitignored).
Set preview-only secrets and Cloudflare Access before testing customer data.
Production resources were not selected by this script.
EOF
