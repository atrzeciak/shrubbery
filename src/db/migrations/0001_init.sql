CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'family')),
  lang TEXT NOT NULL DEFAULT 'pl' CHECK (lang IN ('pl', 'en')),
  created_at INTEGER NOT NULL,
  invited_by TEXT,
  disabled_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_account ON passkeys(account_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  passkey_at INTEGER,
  user_agent TEXT,
  revoked_at INTEGER
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  passkey_at INTEGER
);
CREATE INDEX login_codes_email ON login_codes(email, session_nonce);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'pl' CHECK (lang IN ('pl', 'en')),
  invited_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX invitations_email ON invitations(email);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_account_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  ip_hash TEXT
);
CREATE INDEX history_at ON history(at);
