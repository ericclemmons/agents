#!/usr/bin/env bash
# Pre-build: copies host resources into .build/ for the Docker build context.
set -euo pipefail

BUILD_DIR="$(cd "$(dirname "$0")/.." && pwd)/.build"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

if [ -n "${REQUESTS_CA_BUNDLE:-}" ] && [ -f "$REQUESTS_CA_BUNDLE" ]; then
  cp "$REQUESTS_CA_BUNDLE" "$BUILD_DIR/ca-certificates.crt"
  echo "[prepare-build] Copied CA bundle → .build/ca-certificates.crt"
elif [ -n "${REQUESTS_CA_BUNDLE:-}" ]; then
  echo "[prepare-build] REQUESTS_CA_BUNDLE=$REQUESTS_CA_BUNDLE not found — skipping" >&2
else
  echo "[prepare-build] No REQUESTS_CA_BUNDLE set — skipping"
fi
