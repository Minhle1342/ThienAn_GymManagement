CREATE TABLE payment_requests (
 transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
 payload_hash TEXT NOT NULL
);
