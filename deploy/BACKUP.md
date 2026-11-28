# Nightly backup to Google Drive

`deploy/backup.sh` copies the whole database and all uploaded photos to Google
Drive every night, checks that the upload matches, and keeps 35 nightly copies
plus one per month for a year.

## Set up once, on the server

1. Create a shared drive in Google Drive called **Levanto Backups** (a shared
   drive, so the backups belong to the company, not to one person's account).

2. Install rclone and connect it to Google Drive:

   ```bash
   sudo apt install rclone
   rclone config
   ```

   Choose: `n` (new remote) → name it `gdrive` → storage type `drive` → leave
   client id and secret empty → scope `drive` → no service account file → no
   advanced config. The server has no browser, so answer **No** to "use web
   browser"; rclone prints a command to run on your own PC, which opens Google
   sign-in and gives back a code to paste. Then answer **Yes** to "Configure
   this as a Shared Drive" and pick **Levanto Backups**.

3. Run it once by hand and look in the shared drive:

   ```bash
   REMOTE="gdrive:" /opt/levanto/deploy/backup.sh
   ```

4. Schedule it for 02:30 every night:

   ```bash
   crontab -e
   ```

   and add this line:

   ```
   30 2 * * * REMOTE="gdrive:" /opt/levanto/deploy/backup.sh >> /var/log/levanto-backup.log 2>&1
   ```

## Restoring

Download a night's folder from Drive, then in the app's folder:

```bash
docker compose stop app
docker compose exec -T db pg_restore -U levanto -d levanto --clean --if-exists < levanto-db.dump
docker compose start app
docker compose exec -T app tar -C /data -xzf - < levanto-media.tar.gz
docker compose restart app
```

Do a trial restore on another machine once, before relying on this.

## If a backup fails

The script exits with an error and writes the reason to the log. To be told,
put a command in `deploy/backup.env` that sends its argument somewhere you
will see it, for example `ALERT_CMD=/opt/levanto/deploy/notify.sh`.
