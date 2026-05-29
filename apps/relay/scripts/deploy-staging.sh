#!/usr/bin/env bash
set -euo pipefail

APP=superset-relay-staging
REGIONS=(sjc iad fra)
COUNT=${#REGIONS[@]}
REGION_LIST=$(IFS=, ; echo "${REGIONS[*]}")

cd "$(git rev-parse --show-toplevel)"

echo "==> fly deploy ($APP)"
fly deploy \
  --config apps/relay/fly.staging.toml \
  --dockerfile apps/relay/Dockerfile \
  --app "$APP" \
  .

echo "==> fly scale count: $COUNT machines, 1 per region across $REGION_LIST"
fly scale count "app=$COUNT" \
  --region "$REGION_LIST" \
  --max-per-region 1 \
  --app "$APP" \
  --yes

echo "==> Status"
fly status --app "$APP"

echo "==> Smoke test"
"$(dirname "$0")/smoke-test.sh" "${APP}.fly.dev" "${REGIONS[@]}"
