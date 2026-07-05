#!/usr/bin/env bash
# Update von HARPCast: neuesten Stand holen und nach /apps/harpcast kopieren.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/apps/harpcast

git -C "$REPO_DIR" pull --ff-only
rsync -a --delete --exclude='.git' --exclude='deploy' "$REPO_DIR"/ "$APP_DIR"/
chown -R www-data:www-data "$APP_DIR"
echo "==> Update fertig"
