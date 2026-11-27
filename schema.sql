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

-- Separate customer-facing room references; Hydro meter_code remains the immutable device identifier.
ALTER TABLE meters ADD COLUMN IF NOT EXISTS rent_account_ref text;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS water_account_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS meters_rent_account_ref_uidx ON meters (rent_account_ref) WHERE rent_account_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meters_water_account_ref_uidx ON meters (water_account_ref) WHERE water_account_ref IS NOT NULL;

-- One login per meter. Username is a distinct login field, initially set to meter_code.
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

-- Record of sensitive admin actions (manual recharges, admin-sent M-Pesa prompts).
CREATE TABLE IF NOT EXISTS admin_actions (
  id           bigserial PRIMARY KEY,
  action       text NOT NULL,
  meter_number text,
  status       text NOT NULL DEFAULT 'DONE',   -- STARTED, DONE, REFUSED, AMBIGUOUS
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);


-- Protect the audit log: it is private operational data, accessed only by the trusted
-- backend through DATABASE_URL. The browser-facing Supabase roles must never read or
-- mutate audit entries. RLS with no client policies is intentional default-deny.
REVOKE ALL PRIVILEGES ON TABLE public.admin_actions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.admin_actions_id_seq FROM PUBLIC, anon, authenticated;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;


-- These four tables are private to the Mauriskade application backend.
-- Customer authentication is handled by server.js sessions (not Supabase Auth),
-- so do not create broad anon/authenticated policies. The backend connects with
-- DATABASE_URL; service_role remains available for trusted server-side operations.
REVOKE ALL PRIVILEGES ON TABLE public.meters, public.sessions, public.transactions, public.users
  FROM PUBLIC, anon, authenticated;
ALTER TABLE public.meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;


-- Explicit restrictive deny policy for browser/API roles on every backend-only table.
-- The application uses its own signed-cookie sessions and trusted DATABASE_URL pool,
-- not Supabase Auth/JWT, so no anon/authenticated row access is appropriate.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meters','sessions','transactions','users','admin_actions'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=t
        AND policyname='deny_client_api_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY deny_client_api_access ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ----------------------- rental-management ledger -----------------------
-- Rent is deliberately separate from water transactions: rent payments never issue STS tokens.
CREATE TABLE IF NOT EXISTS public.rent_leases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 meter_code text NOT NULL REFERENCES public.meters(meter_code),
 tenant_name text NOT NULL,
 unit_label text NOT NULL,
 rent_account_ref text NOT NULL,
 rent_amount integer NOT NULL CHECK (rent_amount > 0),
 billing_frequency text NOT NULL CHECK (billing_frequency IN ('monthly','quarterly','half_yearly','annually')),
 start_date date NOT NULL,
 end_date date,
 due_day integer NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 28),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','suspended')),
 agreement_terms text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rent_leases_meter_idx ON public.rent_leases(meter_code,status);
CREATE INDEX IF NOT EXISTS rent_leases_ref_idx ON public.rent_leases(rent_account_ref);
CREATE TABLE IF NOT EXISTS public.rent_charges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 period_start date NOT NULL, period_end date NOT NULL, due_date date NOT NULL,
 amount integer NOT NULL CHECK(amount > 0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(lease_id,period_start)
);
CREATE INDEX IF NOT EXISTS rent_charges_due_idx ON public.rent_charges(lease_id,due_date);
CREATE TABLE IF NOT EXISTS public.rent_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid REFERENCES public.rent_leases(id),
 rent_account_ref text NOT NULL, payer_phone text,
 amount integer NOT NULL CHECK(amount > 0),
 method text NOT NULL CHECK(method IN ('mpesa_stk','mpesa_paybill','manual')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed','unallocated','allocated','review')),
 checkout_request_id text UNIQUE, merchant_request_id text, mpesa_receipt text UNIQUE,
 transaction_time timestamptz, raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb, notes text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rent_payments_lease_idx ON public.rent_payments(lease_id,created_at DESC);
CREATE INDEX IF NOT EXISTS rent_payments_status_idx ON public.rent_payments(status,created_at DESC);
CREATE TABLE IF NOT EXISTS public.rent_allocations (
 id bigserial PRIMARY KEY, payment_id uuid NOT NULL REFERENCES public.rent_payments(id),
 charge_id uuid NOT NULL REFERENCES public.rent_charges(id), amount integer NOT NULL CHECK(amount > 0),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(payment_id,charge_id)
);
CREATE TABLE IF NOT EXISTS public.tenancy_agreements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 version integer NOT NULL DEFAULT 1, title text NOT NULL DEFAULT 'Tenancy Agreement',
 body text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','superseded')),
 issued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(lease_id,version)
);
CREATE TABLE IF NOT EXISTS public.rent_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL UNIQUE REFERENCES public.rent_payments(id),
 receipt_number text NOT NULL UNIQUE, issued_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['rent_leases','rent_charges','rent_payments','rent_allocations','tenancy_agreements','rent_receipts'] LOOP
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='deny_client_api_access') THEN
   EXECUTE format('CREATE POLICY deny_client_api_access ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',t);
  END IF;
 END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS rent_leases_active_ref_uidx ON public.rent_leases(rent_account_ref) WHERE status='active';

CREATE INDEX IF NOT EXISTS rent_allocations_charge_id_idx ON public.rent_allocations(charge_id);

ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS requested_amount integer;
