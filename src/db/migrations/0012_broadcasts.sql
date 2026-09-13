-- A letter the whole family gets at once: an admin's own words, sent to the people who have an
-- account, to those who have an invitation, or to the relatives whose address the tree holds. The
-- row is written after the mail has gone, so every row here is a message that actually left.
CREATE TABLE broadcasts (
  id                  TEXT PRIMARY KEY,
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,
  groups              TEXT NOT NULL,              -- JSON array of "accounts" | "invited" | "others"
  attachment_media_id TEXT REFERENCES media(id),
  sent_by             TEXT REFERENCES accounts(id),
  sent_at             INTEGER NOT NULL,
  sent_count          INTEGER NOT NULL
);
CREATE INDEX broadcasts_sent_at ON broadcasts(sent_at DESC);
