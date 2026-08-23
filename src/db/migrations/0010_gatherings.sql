-- The first thing this site stores as an event. Birthdays and anniversaries are worked out from
-- people's dates; a gathering is a thing somebody decides on, and that the family answers.
CREATE TABLE gatherings (
  id           TEXT PRIMARY KEY,
  on_date      TEXT NOT NULL,
  place        TEXT,
  note         TEXT,
  created_by   TEXT REFERENCES accounts(id),
  created_at   INTEGER NOT NULL,
  cancelled_at INTEGER,
  -- Set by the mail half, which is deliberately not built yet: there is no date to announce.
  announced_at INTEGER,
  nudged_at    INTEGER
);

-- Keyed by person, not by account: most of the family will never sign in, and an answer that could
-- only hang off an account would leave the guest list permanently wrong. answered_by keeps the
-- provenance, so an answer given over the telephone is never mistaken for the person's own word.
CREATE TABLE rsvps (
  gathering_id TEXT NOT NULL REFERENCES gatherings(id),
  person_id    TEXT NOT NULL REFERENCES people(id),
  coming       INTEGER NOT NULL,
  headcount    INTEGER NOT NULL,
  answered_by  TEXT REFERENCES accounts(id),
  answered_at  INTEGER NOT NULL,
  PRIMARY KEY (gathering_id, person_id)
);
CREATE INDEX rsvps_gathering ON rsvps (gathering_id);
