-- Every passkey challenge the server hands out, until it is used once or expires. A cookie alone
-- let a captured assertion from a passkey whose counter stays at 0 sign in again and again.
CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
