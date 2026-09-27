-- rsvps_gathering repeated the leading column of the rsvps primary key, and every answer paid to
-- keep it. login_codes.passkey_at was never written or read.
DROP INDEX rsvps_gathering;
ALTER TABLE login_codes DROP COLUMN passkey_at;
