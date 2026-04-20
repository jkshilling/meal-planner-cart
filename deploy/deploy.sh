#!/usr/bin/env bash
# Deploy meal-planner-cart to the shared DigitalOcean droplet.
#
# Prereqs on the droplet:
#   - Node 18+ available at /usr/bin/node
#   - nginx installed, sites-available/ and sites-enabled/ configured
#   - www-data user exists (standard on Debian/Ubuntu)
#   - this repo rsync'd or git-pulled into /srv/meal-planner-cart/
#   - /srv/meal-planner-cart/.env populated (copy .env.example and edit)
#
# Usage (as root):
#   cd /srv/meal-planner-cart
#   sudo ./deploy/deploy.sh
#
# Idempotent: safe to re-run after every update. Touches ONLY this app's
# systemd unit and nginx site — never modifies sibling apps or any global
# files (nginx.conf, sites-enabled/default, systemd presets, etc.).

set -euo pipefail

APP_NAME="meal-planner-cart"
APP_DIR="/srv/${APP_NAME}"
APP_USER="www-data"
APP_GROUP="www-data"
SYSTEMD_UNIT="/etc/systemd/system/${APP_NAME}.service"
NGINX_AVAILABLE="/etc/nginx/sites-available/${APP_NAME}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root." >&2
  exit 1
fi

if [ ! -d "${APP_DIR}" ]; then
  echo "Missing ${APP_DIR}. Deploy the code there first (git clone or rsync)." >&2
  exit 1
fi

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "Missing ${APP_DIR}/.env. Copy .env.example to .env and fill in values." >&2
  exit 1
fi

cd "${APP_DIR}"

echo "=== [1/6] Installing Node production dependencies ==="
# Install as root, then chown the tree. npm ci runs postinstall which builds
# better-sqlite3 for the droplet's architecture.
npm ci --omit=dev
# Rebuild native bindings explicitly in case the tree came from a Mac.
npm rebuild better-sqlite3

echo "=== [2/6] Ensuring ${APP_USER} owns the app tree ==="
# data/ must be writable by the service user; everything else just readable.
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
chmod -R u=rwX,g=rX,o=rX "${APP_DIR}"
# The SQLite file + WAL sidecars need to be writable.
chmod -R u=rwX,g=rwX,o= "${APP_DIR}/data"

echo "=== [3/6] Installing systemd unit at ${SYSTEMD_UNIT} ==="
install -m 0644 "${APP_DIR}/deploy/${APP_NAME}.service" "${SYSTEMD_UNIT}"
systemctl daemon-reload
systemctl enable "${APP_NAME}"

echo "=== [4/6] Installing nginx site (sibling apps untouched) ==="
install -m 0644 "${APP_DIR}/deploy/nginx.conf" "${NGINX_AVAILABLE}"
# Create the enable symlink only if it doesn't already point at our file.
if [ ! -L "${NGINX_ENABLED}" ] || [ "$(readlink "${NGINX_ENABLED}")" != "${NGINX_AVAILABLE}" ]; then
  ln -sfn "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
fi

echo "=== [5/6] Validating nginx config ==="
# This checks the entire nginx config. If it fails, we bail before reloading
# so sibling apps keep serving the old (good) config.
nginx -t

echo "=== [6/6] Restarting services ==="
systemctl restart "${APP_NAME}"
systemctl reload nginx

echo
echo "=== Deployed ==="
systemctl --no-pager status "${APP_NAME}" | head -12 || true
echo
echo "Next steps (only needed first time, or after DNS changes):"
echo "  1. Confirm A record: meals.alaskatargeting.com → this droplet's IP"
echo "  2. Obtain TLS cert:  sudo certbot --nginx -d meals.alaskatargeting.com"
echo
echo "App logs:  journalctl -u ${APP_NAME} -f"
echo "Nginx:     /var/log/nginx/${APP_NAME}.{access,error}.log"
