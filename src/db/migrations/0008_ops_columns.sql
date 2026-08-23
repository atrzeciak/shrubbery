-- Plan A created ops_status with backup_at. These are what the daily checks learn.
ALTER TABLE ops_status ADD COLUMN checked_at INTEGER;
ALTER TABLE ops_status ADD COLUMN domain_expires_at INTEGER;
ALTER TABLE ops_status ADD COLUMN card_expires_at INTEGER;
ALTER TABLE ops_status ADD COLUMN subscription_renews_at INTEGER;
ALTER TABLE ops_status ADD COLUMN warnings TEXT;
ALTER TABLE ops_status ADD COLUMN error TEXT;
-- When the current run of failures began; cleared on success, so check_failing can count days.
ALTER TABLE ops_status ADD COLUMN error_since INTEGER;
