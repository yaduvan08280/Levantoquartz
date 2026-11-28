-- More than one workbook. "New Base" (production) was the only one; the
-- Domestic Marketing app keeps its own, with its own tab names.
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS book text NOT NULL DEFAULT 'newbase';
ALTER TABLE tabs DROP CONSTRAINT IF EXISTS tabs_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS tabs_book_name_key ON tabs (book, name);
