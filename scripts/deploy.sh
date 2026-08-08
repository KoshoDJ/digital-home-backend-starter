#!/usr/bin/env bash
# Deploy the backend worker to Cloudflare.
# Reads CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the repo's
# gitignored .env.local. Deploys whatever is currently checked out.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "error: .env.local not found (needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)" >&2
  exit 1
fi

set -a
eval "$(grep -E '^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)=' .env.local)"
set +a

echo "Deploying backend worker from branch: $(git branch --show-current) ($(git log --oneline -1))"
npm run deploy
