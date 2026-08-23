-- One row (id = 1) of operational facts. Plan B of this sub-project adds its own columns here.
CREATE TABLE ops_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  backup_at INTEGER
);
INSERT INTO ops_status (id, backup_at) VALUES (1, NULL);
