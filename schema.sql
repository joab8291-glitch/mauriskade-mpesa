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

-- Configurable allocation policy. The default follows the client's recommended oldest-due-first rule.
CREATE TABLE IF NOT EXISTS public.rent_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 allocation_rule text NOT NULL DEFAULT 'oldest_due_first'
   CHECK (allocation_rule IN ('oldest_due_first','oldest_period_first','newest_due_first')),
 notice_period_months integer NOT NULL DEFAULT 1 CHECK (notice_period_months BETWEEN 1 AND 12),
 updated_by text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.rent_settings(singleton,allocation_rule) VALUES(true,'oldest_due_first')
 ON CONFLICT(singleton) DO NOTHING;
ALTER TABLE public.rent_settings ADD COLUMN IF NOT EXISTS notice_period_months integer NOT NULL DEFAULT 1 CHECK (notice_period_months BETWEEN 1 AND 12);

-- Tenant-reported missing payments are cases for staff investigation; they are never auto-posted.
CREATE TABLE IF NOT EXISTS public.rent_payment_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 transaction_code text NOT NULL,
 amount integer CHECK (amount IS NULL OR amount > 0),
 description text,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','rejected')),
 staff_note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(lease_id,transaction_code)
);
CREATE INDEX IF NOT EXISTS rent_payment_reports_status_created_idx ON public.rent_payment_reports(status,created_at DESC);

ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS requested_amount integer;
ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS external_reference text;
ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS verified_by text;
ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS verification_note text;
CREATE UNIQUE INDEX IF NOT EXISTS rent_payments_external_reference_uidx ON public.rent_payments(external_reference) WHERE external_reference IS NOT NULL;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['rent_settings','rent_payment_reports'] LOOP
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='deny_client_api_access') THEN
   EXECUTE format('CREATE POLICY deny_client_api_access ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',t);
  END IF;
 END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS rent_leases_one_active_per_meter_idx ON public.rent_leases(meter_code) WHERE status='active';

-- ------------------ client brief completion: property, staff and rent controls ------------------
CREATE TABLE IF NOT EXISTS public.properties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 address text,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(name)
);
INSERT INTO public.properties(name,address) VALUES('Mauriskade Apartments','') ON CONFLICT(name) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.property_units (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 property_id uuid NOT NULL REFERENCES public.properties(id),
 meter_code text UNIQUE REFERENCES public.meters(meter_code),
 unit_label text NOT NULL,
 status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','occupied','unavailable')),
 notes text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(property_id,unit_label)
);
ALTER TABLE public.rent_leases ADD COLUMN IF NOT EXISTS property_unit_id uuid REFERENCES public.property_units(id);
-- Standalone rent units do not need a Hydro water meter.
ALTER TABLE public.rent_leases ALTER COLUMN meter_code DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rent_leases_active_property_unit_uidx ON public.rent_leases(property_unit_id) WHERE status='active' AND property_unit_id IS NOT NULL;
-- A customer login may belong to a legacy meter or one rent-only tenancy.
ALTER TABLE public.users ALTER COLUMN meter_code DROP NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS rent_lease_id uuid REFERENCES public.rent_leases(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS users_rent_lease_uidx ON public.users(rent_lease_id) WHERE rent_lease_id IS NOT NULL;
DO $rent_identity$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_customer_identity_check' AND conrelid='public.users'::regclass) THEN
  ALTER TABLE public.users ADD CONSTRAINT users_customer_identity_check CHECK (meter_code IS NOT NULL OR rent_lease_id IS NOT NULL);
 END IF;
END $rent_identity$;
ALTER TABLE public.rent_leases ADD COLUMN IF NOT EXISTS notice_date date;
ALTER TABLE public.rent_leases ADD COLUMN IF NOT EXISTS notice_end_date date;
ALTER TABLE public.rent_leases ADD COLUMN IF NOT EXISTS tenant_email text;
ALTER TABLE public.meters ADD COLUMN IF NOT EXISTS tenant_email text;
ALTER TABLE public.rent_leases ADD COLUMN IF NOT EXISTS security_deposit integer NOT NULL DEFAULT 0 CHECK(security_deposit>=0);

CREATE TABLE IF NOT EXISTS public.admin_staff (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 username text NOT NULL UNIQUE,
 display_name text NOT NULL,
 password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('manager','finance','caretaker')),
 active boolean NOT NULL DEFAULT true,
 must_change_password boolean NOT NULL DEFAULT true,
 created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.admin_staff_sessions (
 token_hash text PRIMARY KEY,
 staff_id uuid NOT NULL REFERENCES public.admin_staff(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_staff_sessions_expiry_idx ON public.admin_staff_sessions(expires_at);
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS actor_id text;
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS actor_name text;
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS actor_role text;
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS actor_username text;
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS actor_source text;
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS entity_id text;
ALTER TABLE public.admin_actions ADD COLUMN IF NOT EXISTS before_after jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Audit identity is written once by the trusted backend. Public browser roles have no table privileges.
CREATE INDEX IF NOT EXISTS admin_actions_actor_created_idx ON public.admin_actions(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_actions_entity_created_idx ON public.admin_actions(entity_type, entity_id, created_at DESC);

-- Financial records are append-only; approvals are requested by one staff member and
-- must be decided by a different person. The legacy ADMIN_KEY owner is the bootstrap approver.
CREATE TABLE IF NOT EXISTS public.rent_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 action_type text NOT NULL CHECK(action_type IN ('deposit_refund','deposit_deduction','deposit_transfer','payment_reversal','rent_adjustment','opening_balance','final_settlement','rent_writeoff','formal_notice','payment_plan','final_settlement')),
 resource_id uuid,
 lease_id uuid REFERENCES public.rent_leases(id),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 reason text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
 requested_by text NOT NULL,
 requested_by_name text NOT NULL,
 requested_by_role text NOT NULL,
 decided_by text,
 decided_by_name text,
 decided_by_role text,
 decision_note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS rent_approvals_status_idx ON public.rent_approvals(status,created_at DESC);

CREATE TABLE IF NOT EXISTS public.rent_deposit_transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 kind text NOT NULL CHECK(kind IN ('received','deduction','refund','transfer_in','transfer_out')),
 amount integer NOT NULL CHECK(amount>0),
 reference text,
 note text NOT NULL,
 approval_id uuid REFERENCES public.rent_approvals(id),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rent_deposits_lease_idx ON public.rent_deposit_transactions(lease_id,created_at);

ALTER TABLE public.rent_charges ADD COLUMN IF NOT EXISTS charge_type text NOT NULL DEFAULT 'rent';
ALTER TABLE public.rent_charges ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.rent_charges DROP CONSTRAINT IF EXISTS rent_charges_lease_id_period_start_key;
CREATE UNIQUE INDEX IF NOT EXISTS rent_charges_lease_period_type_uidx ON public.rent_charges(lease_id,period_start,charge_type);
ALTER TABLE public.rent_payments DROP CONSTRAINT IF EXISTS rent_payments_method_check;
ALTER TABLE public.rent_payments ADD CONSTRAINT rent_payments_method_check CHECK(method IN ('mpesa_stk','mpesa_paybill','manual','credit_adjustment','bank_import'));
ALTER TABLE public.rent_payments DROP CONSTRAINT IF EXISTS rent_payments_status_check;
ALTER TABLE public.rent_payments ADD CONSTRAINT rent_payments_status_check CHECK(status IN ('pending','confirmed','failed','unallocated','allocated','review','reversed'));
ALTER TABLE public.rent_allocations ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE public.rent_receipts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','reversed'));
ALTER TABLE public.rent_receipts ADD COLUMN IF NOT EXISTS paper_receipt_number text;
ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS reversal_note text;
ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES public.rent_approvals(id);
ALTER TABLE public.rent_payments ADD COLUMN IF NOT EXISTS paper_receipt_number text;

CREATE TABLE IF NOT EXISTS public.rent_scheduled_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 effective_date date NOT NULL,
 new_rent_amount integer NOT NULL CHECK(new_rent_amount>0),
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','applied','cancelled')),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 applied_at timestamptz,
 UNIQUE(lease_id,effective_date)
);
CREATE TABLE IF NOT EXISTS public.rent_settlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 effective_date date NOT NULL,
 rent_due integer NOT NULL DEFAULT 0,
 deposit_balance integer NOT NULL DEFAULT 0,
 proposed_deduction integer NOT NULL DEFAULT 0,
 proposed_refund integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','awaiting_approval','settled','cancelled')),
 statement jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.rent_bank_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 file_name text NOT NULL,
 row_count integer NOT NULL DEFAULT 0,
 imported_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rent_bank_statement_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 import_id uuid NOT NULL REFERENCES public.rent_bank_imports(id) ON DELETE CASCADE,
 transaction_date date NOT NULL,
 amount integer NOT NULL CHECK(amount>0),
 reference text NOT NULL,
 account_reference text,
 description text,
 status text NOT NULL DEFAULT 'unmatched' CHECK(status IN ('unmatched','matched','posted','duplicate','ignored')),
 matched_payment_id uuid REFERENCES public.rent_payments(id),
 matched_lease_id uuid REFERENCES public.rent_leases(id),
 staff_note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(import_id,reference,amount)
);
CREATE INDEX IF NOT EXISTS rent_bank_lines_status_idx ON public.rent_bank_statement_lines(status,transaction_date);

CREATE TABLE IF NOT EXISTS public.rent_reminder_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 charge_id uuid NOT NULL REFERENCES public.rent_charges(id),
 reminder_type text NOT NULL CHECK(reminder_type IN ('before_due','due_today','overdue_3','overdue_7')),
 channel text NOT NULL CHECK(channel IN ('sms','whatsapp','email')),
 scheduled_for date NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','held','blocked_config','sent','delivered','failed','cancelled')),
 amount_due integer NOT NULL DEFAULT 0,
 message text,
 provider_reference text,
 last_error text,
 attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(charge_id,reminder_type,channel)
);
CREATE INDEX IF NOT EXISTS rent_reminder_jobs_queue_idx ON public.rent_reminder_jobs(status,scheduled_for);
CREATE TABLE IF NOT EXISTS public.rent_followup_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 charge_id uuid REFERENCES public.rent_charges(id),
 due_date date NOT NULL,
 task_type text NOT NULL CHECK(task_type IN ('overdue_followup','payment_plan_check','dispute_review','failed_message')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','cancelled')),
 assigned_to text,
 note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS rent_followup_unique_idx ON public.rent_followup_tasks(lease_id,charge_id,task_type,due_date);
CREATE TABLE IF NOT EXISTS public.rent_payment_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 total_amount integer NOT NULL CHECK(total_amount>0),
 installment_amount integer NOT NULL CHECK(installment_amount>0),
 frequency text NOT NULL CHECK(frequency IN ('weekly','fortnightly','monthly')),
 start_date date NOT NULL,
 next_due_date date NOT NULL,
 status text NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('pending_approval','active','completed','defaulted','cancelled')),
 reason text NOT NULL,
 requested_by text NOT NULL,
 approved_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rent_payment_plan_installments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 plan_id uuid NOT NULL REFERENCES public.rent_payment_plans(id) ON DELETE CASCADE,
 due_date date NOT NULL,
 amount integer NOT NULL CHECK(amount>0),
 status text NOT NULL DEFAULT 'due' CHECK(status IN ('due','paid','missed')),
 paid_at timestamptz,
 UNIQUE(plan_id,due_date)
);
CREATE TABLE IF NOT EXISTS public.rent_disputes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 description text NOT NULL,
 disputed_amount integer,
 follow_up_date date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','resolved','rejected')),
 staff_note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rent_communication_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid REFERENCES public.rent_leases(id),
 reminder_job_id uuid REFERENCES public.rent_reminder_jobs(id),
 channel text NOT NULL,
 recipient text,
 message text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','held','blocked_config','sent','delivered','failed')),
 provider_reference text,
 provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
 sent_at timestamptz,
 delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rent_formal_notices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 title text NOT NULL,
 body text NOT NULL,
 approval_id uuid REFERENCES public.rent_approvals(id),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','sent','cancelled')),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz
);

-- Restrict all new application-owned tables to the trusted backend connection.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['properties','property_units','admin_staff','admin_staff_sessions','rent_approvals','rent_deposit_transactions','rent_scheduled_changes','rent_settlements','rent_bank_imports','rent_bank_statement_lines','rent_reminder_jobs','rent_followup_tasks','rent_payment_plans','rent_payment_plan_installments','rent_disputes','rent_communication_log','rent_formal_notices'] LOOP
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='deny_client_api_access') THEN
   EXECUTE format('CREATE POLICY deny_client_api_access ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',t);
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.rent_payment_plan_installments ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES public.rent_payments(id);
CREATE UNIQUE INDEX IF NOT EXISTS rent_plan_installment_payment_uidx ON public.rent_payment_plan_installments(payment_id) WHERE payment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.rent_backup_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 backup_date date NOT NULL UNIQUE,
 status text NOT NULL CHECK(status IN ('blocked_config','sent','failed')),
 file_sha256 text,
 file_bytes bigint,
 destination text,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rent_backup_tests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 file_sha256 text NOT NULL,
 tables_tested integer NOT NULL,
 rows_tested bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('passed','failed')),
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 tested_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['rent_backup_runs','rent_backup_tests'] LOOP
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='deny_client_api_access') THEN
   EXECUTE format('CREATE POLICY deny_client_api_access ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',t);
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.rent_approvals DROP CONSTRAINT IF EXISTS rent_approvals_action_type_check;
ALTER TABLE public.rent_approvals ADD CONSTRAINT rent_approvals_action_type_check CHECK(action_type IN ('deposit_refund','deposit_deduction','deposit_transfer','payment_reversal','rent_adjustment','opening_balance','final_settlement','rent_writeoff','formal_notice','payment_plan','rent_credit_refund'));
ALTER TABLE public.rent_settlements ADD COLUMN IF NOT EXISTS rent_credit_balance integer NOT NULL DEFAULT 0;
ALTER TABLE public.rent_settlements ADD COLUMN IF NOT EXISTS proposed_credit_refund integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS public.rent_credit_refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 amount integer NOT NULL CHECK(amount>0),
 status text NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','paid','cancelled')),
 external_reference text UNIQUE,
 note text NOT NULL,
 approval_id uuid NOT NULL REFERENCES public.rent_approvals(id),
 requested_by text NOT NULL,
 approved_by text NOT NULL,
 paid_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS rent_credit_refunds_lease_idx ON public.rent_credit_refunds(lease_id,status,created_at);
DO $$
BEGIN
 REVOKE ALL PRIVILEGES ON TABLE public.rent_credit_refunds FROM PUBLIC, anon, authenticated;
 ALTER TABLE public.rent_credit_refunds ENABLE ROW LEVEL SECURITY;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rent_credit_refunds' AND policyname='deny_client_api_access') THEN
  CREATE POLICY deny_client_api_access ON public.rent_credit_refunds AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.rent_allocation_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 allocation_id bigint NOT NULL REFERENCES public.rent_allocations(id),
 previous_amount integer NOT NULL,
 new_amount integer NOT NULL,
 reason text NOT NULL,
 approval_id uuid REFERENCES public.rent_approvals(id),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rent_allocation_adjustments_allocation_idx ON public.rent_allocation_adjustments(allocation_id,created_at);
DO $$
BEGIN
 REVOKE ALL PRIVILEGES ON TABLE public.rent_allocation_adjustments FROM PUBLIC, anon, authenticated;
 ALTER TABLE public.rent_allocation_adjustments ENABLE ROW LEVEL SECURITY;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rent_allocation_adjustments' AND policyname='deny_client_api_access') THEN
  CREATE POLICY deny_client_api_access ON public.rent_allocation_adjustments AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
 END IF;
END $$;

ALTER TABLE public.rent_deposit_transactions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted';
ALTER TABLE public.rent_deposit_transactions DROP CONSTRAINT IF EXISTS rent_deposit_transactions_status_check;
ALTER TABLE public.rent_deposit_transactions ADD CONSTRAINT rent_deposit_transactions_status_check CHECK(status IN ('posted','approved_pending','paid'));
CREATE UNIQUE INDEX IF NOT EXISTS rent_deposit_reference_uidx ON public.rent_deposit_transactions(reference) WHERE reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rent_followup_null_charge_uidx ON public.rent_followup_tasks(lease_id,task_type,due_date) WHERE charge_id IS NULL;

ALTER TABLE public.rent_approvals DROP CONSTRAINT IF EXISTS rent_approvals_action_type_check;
ALTER TABLE public.rent_approvals ADD CONSTRAINT rent_approvals_action_type_check CHECK(action_type IN ('deposit_refund','deposit_deduction','deposit_transfer','payment_reversal','rent_adjustment','opening_balance','final_settlement','rent_writeoff','formal_notice','payment_plan','rent_credit_refund','rent_credit_transfer'));
CREATE TABLE IF NOT EXISTS public.rent_credit_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 from_lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 to_lease_id uuid NOT NULL REFERENCES public.rent_leases(id),
 amount integer NOT NULL CHECK(amount>0),
 status text NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','cancelled')),
 approval_id uuid NOT NULL UNIQUE REFERENCES public.rent_approvals(id),
 note text NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(from_lease_id<>to_lease_id)
);
CREATE INDEX IF NOT EXISTS rent_credit_transfers_from_idx ON public.rent_credit_transfers(from_lease_id,status,created_at);
DO $$
BEGIN
 REVOKE ALL PRIVILEGES ON TABLE public.rent_credit_transfers FROM PUBLIC, anon, authenticated;
 ALTER TABLE public.rent_credit_transfers ENABLE ROW LEVEL SECURITY;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rent_credit_transfers' AND policyname='deny_client_api_access') THEN
  CREATE POLICY deny_client_api_access ON public.rent_credit_transfers AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
 END IF;
END $$;

ALTER TABLE public.rent_charges ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE public.rent_charges ADD COLUMN IF NOT EXISTS void_reason text;
CREATE INDEX IF NOT EXISTS rent_charges_active_lease_due_idx ON public.rent_charges(lease_id,due_date,period_start) WHERE voided_at IS NULL;

ALTER TABLE public.rent_charges DROP CONSTRAINT IF EXISTS rent_charges_lease_id_period_start_charge_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS rent_charges_active_period_uidx ON public.rent_charges(lease_id,period_start,charge_type) WHERE voided_at IS NULL;

DROP INDEX IF EXISTS public.rent_leases_one_active_per_meter_idx;
CREATE UNIQUE INDEX IF NOT EXISTS rent_leases_one_open_ended_per_meter_idx ON public.rent_leases(meter_code) WHERE status='active' AND end_date IS NULL;

ALTER TABLE public.rent_backup_runs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.rent_backup_runs DROP CONSTRAINT IF EXISTS rent_backup_runs_status_check;
ALTER TABLE public.rent_backup_runs ADD CONSTRAINT rent_backup_runs_status_check CHECK(status IN ('blocked_config','queued','sent','failed'));

CREATE UNIQUE INDEX IF NOT EXISTS rent_payments_paper_receipt_uidx ON public.rent_payments(paper_receipt_number) WHERE paper_receipt_number IS NOT NULL AND btrim(paper_receipt_number)<>'';

-- Cover every previously unindexed foreign key. These small indexes keep
-- parent deletes/updates and the associated rent operations predictable as
-- tenancy, approvals, reminders and reconciliation history grow.
CREATE INDEX IF NOT EXISTS admin_staff_sessions_staff_id_idx ON public.admin_staff_sessions(staff_id);
CREATE INDEX IF NOT EXISTS rent_allocation_adjustments_approval_id_idx ON public.rent_allocation_adjustments(approval_id);
CREATE INDEX IF NOT EXISTS rent_approvals_lease_id_idx ON public.rent_approvals(lease_id);
CREATE INDEX IF NOT EXISTS rent_bank_statement_lines_matched_lease_id_idx ON public.rent_bank_statement_lines(matched_lease_id);
CREATE INDEX IF NOT EXISTS rent_bank_statement_lines_matched_payment_id_idx ON public.rent_bank_statement_lines(matched_payment_id);
CREATE INDEX IF NOT EXISTS rent_communication_log_lease_id_idx ON public.rent_communication_log(lease_id);
CREATE INDEX IF NOT EXISTS rent_communication_log_reminder_job_id_idx ON public.rent_communication_log(reminder_job_id);
CREATE INDEX IF NOT EXISTS rent_credit_refunds_approval_id_idx ON public.rent_credit_refunds(approval_id);
CREATE INDEX IF NOT EXISTS rent_credit_transfers_to_lease_id_idx ON public.rent_credit_transfers(to_lease_id);
CREATE INDEX IF NOT EXISTS rent_deposit_transactions_approval_id_idx ON public.rent_deposit_transactions(approval_id);
CREATE INDEX IF NOT EXISTS rent_disputes_lease_id_idx ON public.rent_disputes(lease_id);
CREATE INDEX IF NOT EXISTS rent_followup_tasks_charge_id_idx ON public.rent_followup_tasks(charge_id);
CREATE INDEX IF NOT EXISTS rent_formal_notices_approval_id_idx ON public.rent_formal_notices(approval_id);
CREATE INDEX IF NOT EXISTS rent_formal_notices_lease_id_idx ON public.rent_formal_notices(lease_id);
CREATE INDEX IF NOT EXISTS rent_payment_plans_lease_id_idx ON public.rent_payment_plans(lease_id);
CREATE INDEX IF NOT EXISTS rent_payments_approval_id_idx ON public.rent_payments(approval_id);
CREATE INDEX IF NOT EXISTS rent_reminder_jobs_lease_id_idx ON public.rent_reminder_jobs(lease_id);
CREATE INDEX IF NOT EXISTS rent_settlements_lease_id_idx ON public.rent_settlements(lease_id);
