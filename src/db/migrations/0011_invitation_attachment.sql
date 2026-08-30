-- An invitation may carry one document from the archive — the tree as a PDF, say — so the first
-- mail a relative gets already shows what the site holds. Remembered here so a re-send attaches
-- the same file. NULL for the plain invitation.
ALTER TABLE invitations ADD COLUMN attachment_media_id TEXT REFERENCES media(id);
