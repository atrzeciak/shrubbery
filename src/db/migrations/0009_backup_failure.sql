-- A download that dies partway used to leave no trace: the browser got a truncated file, the site
-- said nothing, and the only surviving signal was backup_at staying as it was.
ALTER TABLE ops_status ADD COLUMN backup_failed_at INTEGER;
ALTER TABLE ops_status ADD COLUMN backup_error TEXT;
