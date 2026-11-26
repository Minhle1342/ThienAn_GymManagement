CREATE TABLE admin_access_codes (
    token_hash TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
);
