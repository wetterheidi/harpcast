#!/usr/bin/env bash
# Erstinstallation von HARPCast auf dem Server (als root ausführen).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/apps/harpcast
DOMAIN=harpcast.wetterheidi.de
SITE_NAME=harpcast
CERTBOT_EMAIL=heidemarieschmid73@gmail.com

echo "==> Dateien nach ${APP_DIR} kopieren"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude='.git' --exclude='deploy' "$REPO_DIR"/ "$APP_DIR"/
chown -R www-data:www-data "$APP_DIR"

echo "==> nginx-Site einspielen"
cp "$REPO_DIR/deploy/nginx-${SITE_NAME}.conf" "/etc/nginx/sites-available/${SITE_NAME}"
ln -sf "/etc/nginx/sites-available/${SITE_NAME}" "/etc/nginx/sites-enabled/${SITE_NAME}"
nginx -t
systemctl reload nginx

echo "==> TLS-Zertifikat holen (certbot)"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect

nginx -t
systemctl reload nginx
echo "==> Fertig: https://${DOMAIN}"
