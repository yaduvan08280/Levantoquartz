#!/usr/bin/env bash
# Update the Levanto app on this computer: get the latest code, rebuild, restart.
set -e
cd "$(dirname "$0")"
git pull
docker compose -f docker-compose.local.yml up --build -d
echo "Done. If a page looks unchanged, press Ctrl+Shift+R in the browser."
