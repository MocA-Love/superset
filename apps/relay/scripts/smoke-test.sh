#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <hostname> <region> [<region> ...]" >&2
  exit 64
fi

HOSTNAME="$1"
shift
REGIONS=("$@")

fail=0
for region in "${REGIONS[@]}"; do
  printf "  %-4s " "$region"
  body=$(curl -sS --max-time 8 -H "fly-prefer-region: $region" "https://${HOSTNAME}/health" 2>&1) || {
    printf "  FAIL curl failed: %s\n" "$body"
    fail=$((fail + 1))
    continue
  }
  got=$(printf "%s" "$body" | sed -nE 's/.*"region":"([^"]+)".*/\1/p')
  if [ "$got" = "$region" ]; then
    printf "  OK %s\n" "$body"
  else
    printf "  FAIL wanted region=%s, got=%s: %s\n" "$region" "$got" "$body"
    fail=$((fail + 1))
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "==> smoke test FAILED: $fail region(s) did not respond as expected" >&2
  exit 1
fi
echo "==> smoke test OK across ${#REGIONS[@]} region(s)"
