CREATE TABLE transactions (
 id TEXT PRIMARY KEY,
 member TEXT NOT NULL,
 description TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('membership','pt','class','retail')),
 method TEXT NOT NULL CHECK(method IN ('cash','transfer','card')),
 amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 100000000000),
 status TEXT NOT NULL CHECK(status IN ('paid','pending','failed')),
 occurred_at TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE
);
CREATE TABLE refunds (
 id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL REFERENCES transactions(id),
 amount INTEGER NOT NULL CHECK(amount > 0),
 reason TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE
);
CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY,
 action TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL
);
CREATE INDEX transactions_date ON transactions(occurred_at);
CREATE INDEX refunds_date ON refunds(occurred_at);
