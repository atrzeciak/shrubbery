-- founder: the superadmin who started the site. Exactly one, never demoted, never disabled.
-- protected: an admin only the founder may demote or disable; the founder alone sets this flag.
ALTER TABLE accounts ADD COLUMN founder INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;
UPDATE accounts SET founder = 1, protected = 1
 WHERE id = (SELECT id FROM accounts WHERE role = 'admin' ORDER BY created_at LIMIT 1);
