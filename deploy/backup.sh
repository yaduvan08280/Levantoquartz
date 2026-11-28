#!/usr/bin/env bash
# Nightly backup of the Levanto app to Google Drive.
#
# Takes a complete copy of the database and the uploaded photos, keeps the last
# few on this machine, and uploads them to Google Drive with rclone.
#
# One-time setup on the server (see deploy/BACKUP.md):
#   sudo apt install rclone
#   rclone config            # create a remote named "gdrive" for Google Drive
#   crontab -e               # add:  30 2 * * * /opt/levanto/deploy/backup.sh >> /var/log/levanto-backup.log 2>&1
#
# Settings (override in the environment or in deploy/backup.env):
#   COMPOSE_FILE   which compose file the app runs from        (docker-compose.yml)
#   REMOTE         rclone destination                           (gdrive:Levanto Backups)
#   KEEP_LOCAL     how many nightly copies to keep on this PC   (7)
#   KEEP_REMOTE    days of nightly copies to keep on Drive      (35)
#   ALERT_CMD      command run with one argument, the message, when a backup fails
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
[ -f deploy/backup.env ] && . deploy/backup.env

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
REMOTE="${REMOTE:-gdrive:Levanto Backups}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"
KEEP_REMOTE="${KEEP_REMOTE:-35}"
dest="${BACKUP_DIR:-$here/backups}"
stamp="$(date +%Y-%m-%d_%H%M)"
work="$dest/$stamp"

fail() {
  echo "$(date '+%F %T') BACKUP FAILED: $1"
  if [ -n "${ALERT_CMD:-}" ]; then $ALERT_CMD "Levanto backup FAILED on $(hostname): $1" || true; fi
  rm -rf "$work"
  exit 1
}
trap 'fail "stopped at line $LINENO"' ERR

mkdir -p "$work"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

echo "$(date '+%F %T') backup $stamp starting"

# 1. The database, in Postgres' own format (restores with pg_restore).
dc exec -T db pg_dump -U levanto -Fc levanto > "$work/levanto-db.dump"
[ "$(stat -c %s "$work/levanto-db.dump")" -gt 10000 ] || fail "the database dump is suspiciously small"
# Proof that the file is a readable dump, not a truncated one.
dc exec -T db pg_restore --list < "$work/levanto-db.dump" > /dev/null || fail "the database dump does not read back"

# 2. Uploaded photos and videos.
dc exec -T app tar -C /data -czf - . > "$work/levanto-media.tar.gz"

( cd "$work" && sha256sum levanto-db.dump levanto-media.tar.gz > SHA256SUMS )

# 3. To Google Drive. A copy on the 1st of the month is also kept under monthly/ for a year.
rclone copy "$work" "$REMOTE/nightly/$stamp" --quiet || fail "upload to $REMOTE failed"
rclone check "$work" "$REMOTE/nightly/$stamp" --one-way --quiet || fail "the uploaded copy does not match"
if [ "$(date +%d)" = "01" ]; then
  rclone copy "$work" "$REMOTE/monthly/$stamp" --quiet || fail "monthly upload failed"
  rclone delete "$REMOTE/monthly" --min-age 370d --rmdirs --quiet || true
fi

# 4. Tidy up old copies, here and on Drive.
rclone delete "$REMOTE/nightly" --min-age "${KEEP_REMOTE}d" --rmdirs --quiet || true
ls -1d "$dest"/20* 2>/dev/null | sort | head -n -"$KEEP_LOCAL" | xargs -r rm -rf

trap - ERR
echo "$(date '+%F %T') backup $stamp done: $(du -sh "$work" | cut -f1) -> $REMOTE/nightly/$stamp"
