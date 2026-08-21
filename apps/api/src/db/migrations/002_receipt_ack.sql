-- Receipt acknowledgment: set when the driver taps Done on the receipt.
-- Un-acked ended sessions are re-surfaced after a QR scan (server-side resume).
ALTER TABLE sessions ADD COLUMN acked_at TEXT;
