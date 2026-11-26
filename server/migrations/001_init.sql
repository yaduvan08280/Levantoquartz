-- Levanto Quartz — core schema
--
-- Operational data is kept in the shape the plant already works in: a
-- workbook of named tabs, each a grid of rows. One table row per sheet row,
-- the cells as a JSON array, so the admin's raw-data view and the forms app
-- read exactly what the old "New Base" spreadsheet held.

CREATE TABLE IF NOT EXISTS tabs (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  position     integer NOT NULL DEFAULT 0,
  hidden       boolean NOT NULL DEFAULT false,
  frozen_rows  integer NOT NULL DEFAULT 0,
  frozen_cols  integer NOT NULL DEFAULT 0,
  max_cols     integer NOT NULL DEFAULT 26,
  col_formats  jsonb NOT NULL DEFAULT '{}'::jsonb,
  col_widths   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tab_rows (
  tab_id  integer NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  row_no  integer NOT NULL,
  cells   jsonb NOT NULL,
  fmts    jsonb,
  PRIMARY KEY (tab_id, row_no)
);

-- Settings and long-lived state the app keeps for itself: sessions, the
-- Telegram token and offset, alert watermarks, scheduled jobs.
CREATE TABLE IF NOT EXISTS kv (
  scope  text NOT NULL,
  key    text NOT NULL,
  value  text NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Every change made through the admin panel's raw-data view.
CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,
  action   text NOT NULL,
  tab      text,
  row_no   integer,
  col_no   integer,
  old_val  text,
  new_val  text,
  detail   jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tab_idx ON audit_log (tab, row_no);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
