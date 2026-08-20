-- Core tables for the mock milestone.
-- Money: integer centavos. Energy: integer watt-hours. Time: ISO-8601 UTC text.

CREATE TABLE chargers (
  id                      INTEGER PRIMARY KEY,
  code                    TEXT NOT NULL UNIQUE,      -- printed label, e.g. CHG-0042
  qr_slug                 TEXT NOT NULL UNIQUE,      -- /c/{qr_slug} deep link
  site_name               TEXT NOT NULL,
  bay                     TEXT NOT NULL,
  tariff_centavos_per_kwh INTEGER NOT NULL,          -- pinned onto sessions at creation
  hold_centavos           INTEGER NOT NULL           -- pre-auth amount, computed server-side
);

CREATE TABLE connectors (
  id         INTEGER PRIMARY KEY,
  charger_id INTEGER NOT NULL REFERENCES chargers(id),
  type       TEXT NOT NULL,                          -- CCS2, Type2, ...
  max_kw     REAL NOT NULL,
  status     TEXT NOT NULL DEFAULT 'AVAILABLE'
             CHECK (status IN ('AVAILABLE','IN_USE','OFFLINE'))
);

CREATE TABLE sessions (
  id                      TEXT PRIMARY KEY,          -- uuid
  charger_id              INTEGER NOT NULL REFERENCES chargers(id),
  connector_id            INTEGER NOT NULL REFERENCES connectors(id),
  state                   TEXT NOT NULL DEFAULT 'pending_payment'
                          CHECK (state IN ('pending_payment','pending_start','charging',
                                           'ended','expired','start_failed')),
  tariff_centavos_per_kwh INTEGER NOT NULL,          -- pinned at creation
  hold_centavos           INTEGER NOT NULL,
  transaction_id          TEXT UNIQUE,               -- from the (mock) charge point
  meter_start_wh          INTEGER,
  meter_stop_wh           INTEGER,
  stop_reason             TEXT,
  billed_wh               INTEGER,                   -- register delta, set once at end
  amount_centavos         INTEGER,                   -- billed_wh × tariff, rounded half-up
  receipt_no              TEXT,                      -- mock OR number
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL,             -- pending_payment TTL (10 min)
  started_at              TEXT,
  ended_at                TEXT
);

CREATE TABLE payment_intents (
  id                TEXT PRIMARY KEY,                -- uuid
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  provider          TEXT NOT NULL,                   -- 'mock-maya'
  state             TEXT NOT NULL DEFAULT 'CREATED'
                    CHECK (state IN ('CREATED','PENDING_AUTH','AUTHORIZED','CAPTURING',
                                     'CAPTURED','AUTH_FAILED','EXPIRED','VOIDED','REFUNDED')),
  method            TEXT,                            -- Maya Wallet | Card | QR Ph
  prepay            INTEGER NOT NULL DEFAULT 0,      -- QR Ph fallback: charge now, refund unused
  hold_centavos     INTEGER NOT NULL,
  captured_centavos INTEGER,
  checkout_id       TEXT,                            -- provider-side checkout reference
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Raw provider webhook payloads, persisted before processing (idempotency + audit).
CREATE TABLE provider_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL UNIQUE,                 -- replay ⇒ insert conflict ⇒ no-op
  payload      TEXT NOT NULL,
  signature    TEXT,
  received_at  TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX idx_sessions_state ON sessions(state);
CREATE INDEX idx_intents_session ON payment_intents(session_id);
