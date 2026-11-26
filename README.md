# Levanto Quartz — production control

The plant's forms app (previously the "Slabworks Forms" Apps Script on the
"New Base" Google Sheet), running as a web app on Postgres, with an admin
panel for users and data.

| Address | What |
|---|---|
| `/` | The forms app operators use. The same page as before. |
| `/admin/` | Admin panel: users, raw data, change log, import and backup. Admin accounts only. |

## How it is put together

```
server/
  legacy/        The original Apps Script project, unchanged: the page (FormsPage/Css/Js.html)
                 and the production logic (form definitions, validation, duplicate rules,
                 grade alerts, Telegram).
  src/store/     The data: every tab held in memory, committed to Postgres on each request.
                 computed.ts reproduces the columns the spreadsheet filled with formulas.
  src/gas/       The platform the logic expects (sheet, cache, settings, files, HTTP, jobs).
  src/routes/    forms.ts serves the page and its calls; admin.ts is the admin panel's API.
  src/importer/  Reads a Google Sheets .xlsx export.
  migrations/    Database schema.
admin/           Admin panel (React + TypeScript + Vite).
  public/sheets/ Raw-data editor: the Mono Sheets grid with a save adapter (editor.js).
```

**Why the original logic is run rather than rewritten.** The requirement was
that forms look and behave exactly as before. The page and the logic behind it
are the same files that ran in production, so there is nothing to drift. What
changed is underneath: instead of a spreadsheet, they read and write a store
backed by Postgres. A save that took seconds to minutes now takes a few
milliseconds.

**Data model.** Data stays in the shape the plant works in — named tabs of
rows — in two tables (`tabs`, `tab_rows`), so the raw-data view shows exactly
what the Google Sheet held. `kv` holds settings and sign-in sessions;
`audit_log` records every change made from the admin panel.

## Run it locally

Needs Node 22 and Postgres 16.

```bash
createdb levanto            # or point DATABASE_URL at any empty database
cd admin && npm install && npm run build
cd ../server && npm install
npm run import -- "/path/to/New Base.xlsx"     # optional: load the Google Sheets export
npm run dev                                    # http://localhost:8080
```

Environment variables (all optional locally): `DATABASE_URL`, `PORT`,
`PUBLIC_URL` (the address used in Telegram links), `DATA_DIR` (uploaded photos),
`ADMIN_PASSWORD` (first run on an empty database), `TRUST_PROXY=1` behind a proxy.

## Deploy on a server with a domain

1. Point the domain's DNS A record at the server. Install Docker.
2. `cp .env.example .env` and set `DOMAIN`, `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`.
3. `docker compose up -d --build`
4. Open `https://<domain>/admin/`, sign in as `admin`, and import the workbook
   under **Import & backup** (in Google Sheets: File → Download → Microsoft Excel).
   The import brings the existing users and their passwords with it.
5. In the forms app, an admin opens **Notifications** and enters the Telegram
   bot token again — it was stored in Apps Script and does not travel with the sheet.

Back up the `dbdata` and `media` Docker volumes; the admin panel can also
download everything as one `.xlsx`.

## Cut-over from Google Sheets

Operators must stop using the old Apps Script link before the final import,
or entries made there afterwards are left behind. Suggested order: announce a
time between shifts → take the old web app offline → download the .xlsx →
import it → share the new link.

## Checks

```bash
cd server
npx tsx test/parity-computed.ts   # computed columns vs. the sheet's own formula results (run right after an import)
npx tsx test/smoke.ts             # every read call, every form, with timings
npx tsx test/lifecycle.ts         # one slab through all stages (writes test rows — dev database only)
```
