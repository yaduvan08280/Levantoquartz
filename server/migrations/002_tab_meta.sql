-- Per-tab extras that are not cell data. For now: the fill colour of header
-- cells, which the dashboard reads to find the slab-count columns on the two
-- Production Summary tabs.
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
