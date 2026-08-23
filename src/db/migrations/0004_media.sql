CREATE TABLE media (
  id TEXT PRIMARY KEY,
  owner_person_id TEXT NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'document')),
  caption TEXT,
  year INTEGER,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  has_thumb INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX media_owner ON media(owner_person_id);

CREATE TABLE media_people (
  media_id TEXT NOT NULL REFERENCES media(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY (media_id, person_id)
);
CREATE INDEX media_people_person ON media_people(person_id);
