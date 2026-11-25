-- PostgreSQL schema for the water-credit service.
-- server.js runs this file on every start, so everything here is idempotent.

-- Meters of our client, copied from Hydro by the admin panel's "Check for new meters".
CREATE TABLE IF NOT EXISTS meters (
  meter_code      text PRIMARY KEY,
  hydro_meter_id  bigint,
  hydro_label     text,                      -- installationLocation from Hydro
  flat            text,                      -- set by the admin
  tenant_name     text,                      -- set by the admin
  phone           text,                      -- 2547XXXXXXXX, used to prefill the M-Pesa number
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

-- One login per meter. Username is a separate login field, initially equal to meter_code.
CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_code      text NOT NULL UNIQUE REFERENCES meters(meter_code),
  username        text UNIQUE,
  password_hash   text NOT NULL,             -- scrypt$salt$hash
  must_change     boolean NOT NULL DEFAULT true,
  disabled        boolean NOT NULL DEFAULT false,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash      text PRIMARY KEY,          -- sha256 of the cookie value
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_number        text        NOT NULL,
  phone               text        NOT NULL,
  amount              integer     NOT NULL,            -- KES, whole shillings (STK Push requirement)
  status              text        NOT NULL DEFAULT 'PENDING_PAYMENT',
  -- PENDING_PAYMENT : STK prompt sent, waiting for the customer or the callback
  -- PAID            : M-Pesa confirmed, token not yet requested
  -- ISSUING         : amountRecharge call in flight
  -- TOKEN_ISSUED    : done, token stored
  -- RETRY           : Hydro said try later (for example a pending recharge command), the worker retries
  -- NEEDS_REVIEW    : a person must check (ambiguous failure, amount mismatch, no callback)
  -- FAILED          : customer cancelled or payment failed, no money taken
  checkout_request_id text UNIQUE,
  merchant_request_id text,
  mpesa_receipt       text UNIQUE,
  result_desc         text,
  token               text,                            -- 20-digit STS token
  water_volume        numeric(12,2),                   -- m3 credited, read back from Hydro recharge records
  balance_after       numeric(14,2),                   -- balance after recharge, from the same record
  hydro_recharge_no   text,                            -- Hydro's recharge order number
  attempts            integer     NOT NULL DEFAULT 0,
  next_retry_at       timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS water_volume numeric(12,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS balance_after numeric(14,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS hydro_recharge_no text;

CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_tx_meter  ON transactions (meter_number, created_at DESC);

-- Safe in-place migration for existing customer accounts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
UPDATE users SET username = meter_code WHERE username IS NULL OR btrim(username) = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);
ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- Audit trail for privileged admin operations (including manually issued STS tokens).
CREATE TABLE IF NOT EXISTS admin_actions (
  id           bigserial PRIMARY KEY,
  action       text NOT NULL,
  meter_number text,
  status       text NOT NULL DEFAULT 'DONE',
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
