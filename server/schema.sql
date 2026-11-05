BEGIN;
SELECT pg_advisory_xact_lock(5924261105);
CREATE TABLE IF NOT EXISTS sellers (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, consent_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS otp_challenges (
 id uuid PRIMARY KEY, email text NOT NULL, digest text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS otp_email ON otp_challenges(email);
CREATE TABLE IF NOT EXISTS sessions (
 digest text PRIMARY KEY, seller_id uuid NOT NULL REFERENCES sellers(id), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
 bucket text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (
 id uuid PRIMARY KEY, seller_id uuid NOT NULL UNIQUE REFERENCES sellers(id), name text NOT NULL,
 domain text NOT NULL UNIQUE, admin_email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS vps_ipv4 inet;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS admin_password_sealed text;
CREATE TABLE IF NOT EXISTS agents (
 id uuid PRIMARY KEY, store_id uuid NOT NULL UNIQUE REFERENCES stores(id), digest text NOT NULL UNIQUE,
 last_seen timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, public_ip inet
);
CREATE TABLE IF NOT EXISTS pairings (
 digest text PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, agent_id uuid REFERENCES agents(id)
);
CREATE TABLE IF NOT EXISTS jobs (
 id uuid PRIMARY KEY, store_id uuid NOT NULL UNIQUE REFERENCES stores(id), agent_id uuid NOT NULL REFERENCES agents(id),
 release jsonb NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting_dns','failed','complete')),
 stage text NOT NULL DEFAULT 'preflight', sequence integer NOT NULL DEFAULT 0,
 evidence jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz
);
CREATE TABLE IF NOT EXISTS job_events (
 job_id uuid NOT NULL REFERENCES jobs(id), sequence integer NOT NULL, stage text NOT NULL,
 state text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id, sequence)
);
-- Runtime role is provisioned on production by the server bootstrap, never a superuser.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='platform_app') THEN
  GRANT USAGE ON SCHEMA public TO platform_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app;
 END IF;
END $$;
COMMIT;
