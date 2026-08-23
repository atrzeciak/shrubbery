CREATE TABLE people (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  maiden_name TEXT,
  nickname TEXT,
  sex TEXT CHECK (sex IN ('f', 'm')),
  display_name TEXT NOT NULL,
  birth_date TEXT,
  birth_place TEXT,
  death_date TEXT,
  death_place TEXT,
  deceased INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  phone TEXT,
  residence TEXT,
  notes TEXT,
  unverified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX people_email ON people(email);

CREATE TABLE person_links (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN ('instagram', 'facebook', 'linkedin', 'other')),
  label TEXT,
  url TEXT NOT NULL
);
CREATE INDEX person_links_person ON person_links(person_id);

CREATE TABLE parent_of (
  parent_id TEXT NOT NULL REFERENCES people(id),
  child_id TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX parent_of_child ON parent_of(child_id);

CREATE TABLE partner_of (
  a_id TEXT NOT NULL REFERENCES people(id),
  b_id TEXT NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN ('married', 'partner', 'divorced')),
  start_year INTEGER,
  end_year INTEGER,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);

CREATE TABLE avatars (
  person_id TEXT PRIMARY KEY REFERENCES people(id),
  jpeg BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE accounts ADD COLUMN person_id TEXT REFERENCES people(id);
CREATE UNIQUE INDEX accounts_person ON accounts(person_id) WHERE person_id IS NOT NULL;

CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  parent_text TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT,
  lang TEXT NOT NULL DEFAULT 'pl' CHECK (lang IN ('pl', 'en')),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'auto')),
  matched_person_id TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  note TEXT
);
CREATE INDEX join_requests_email ON join_requests(email);
