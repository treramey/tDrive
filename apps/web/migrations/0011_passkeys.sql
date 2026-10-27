ALTER TABLE credential_state ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0);

CREATE TABLE auth_owner (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	user_handle TEXT NOT NULL UNIQUE CHECK (length(user_handle) = 43)
);

CREATE TABLE passkeys (
	id TEXT PRIMARY KEY,
	owner_id INTEGER NOT NULL DEFAULT 1 CHECK (owner_id = 1) REFERENCES auth_owner(id),
	public_key TEXT NOT NULL,
	name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
	counter INTEGER NOT NULL CHECK (counter >= 0),
	revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
	device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
	backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
	created_at TEXT NOT NULL,
	last_used_at TEXT
);

CREATE TABLE dashboard_sessions_next (
	token_hash TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL,
	passkey_id TEXT REFERENCES passkeys(id) ON DELETE CASCADE
);
INSERT INTO dashboard_sessions_next (token_hash, created_at, expires_at, last_used_at)
	SELECT token_hash, created_at, expires_at, last_used_at FROM dashboard_sessions;
DROP TABLE dashboard_sessions;
ALTER TABLE dashboard_sessions_next RENAME TO dashboard_sessions;
CREATE INDEX dashboard_sessions_expiry_idx ON dashboard_sessions(expires_at);
CREATE INDEX dashboard_sessions_passkey_idx ON dashboard_sessions(passkey_id);

CREATE TABLE passkey_challenges (
	id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
	purpose TEXT NOT NULL CHECK (purpose IN ('login', 'enroll')),
	challenge TEXT NOT NULL,
	binding_hash TEXT NOT NULL,
	auth_epoch INTEGER NOT NULL,
	origin TEXT NOT NULL,
	rp_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	consumed_by TEXT,
	session_hash TEXT,
	name TEXT,
	CHECK (
		(purpose = 'login' AND session_hash IS NULL AND name IS NULL) OR
		(purpose = 'enroll' AND session_hash IS NOT NULL AND name IS NOT NULL)
	)
);
CREATE INDEX passkey_challenges_expiry_idx ON passkey_challenges(expires_at);
CREATE INDEX passkey_challenges_session_idx ON passkey_challenges(session_hash);
