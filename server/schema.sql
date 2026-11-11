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
CREATE TABLE IF NOT EXISTS mail_tenants (
 store_id uuid PRIMARY KEY REFERENCES stores(id), origin text NOT NULL UNIQUE, brand text NOT NULL,
 seller_emails text[] NOT NULL, token_digest text NOT NULL UNIQUE, token_sealed text,
 generation integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT true,
 verified_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mail_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
 event text NOT NULL, generation integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mail_tenants ADD COLUMN IF NOT EXISTS brand_revision integer NOT NULL DEFAULT -1;
ALTER TABLE mail_tenants ADD COLUMN IF NOT EXISTS brand_synced_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS authenticated_at timestamptz;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS installation_generation integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS observation jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS observed_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retired_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS current_agent_per_store ON agents(store_id) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS current_job_per_store ON jobs(store_id) WHERE retired_at IS NULL;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_store_id_key;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_store_id_key;
CREATE TABLE IF NOT EXISTS installation_history (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), generation integer NOT NULL,
 last_seen timestamptz, revoked_at timestamptz NOT NULL, retired_at timestamptz NOT NULL DEFAULT now(),
 job_state text, job_stage text, job_snapshot jsonb, events jsonb NOT NULL DEFAULT '[]',
 UNIQUE(store_id,generation)
);
CREATE OR REPLACE FUNCTION assign_installation_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 SELECT installation_generation INTO NEW.generation FROM public.stores WHERE id=NEW.store_id;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_installation_generation ON agents;
CREATE TRIGGER agent_installation_generation BEFORE INSERT ON agents
 FOR EACH ROW EXECUTE FUNCTION assign_installation_generation();
CREATE TABLE IF NOT EXISTS platform_admins (
 seller_id uuid PRIMARY KEY REFERENCES sellers(id),
 role text NOT NULL CHECK(role IN ('super_admin','operator','support')),
 enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS platform_requests (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
 actor_id uuid NOT NULL REFERENCES sellers(id),
 action text NOT NULL CHECK(action IN ('reinstall','domain','ownership','close_store','delete_account','uninstall','purge')),
 reason text NOT NULL, state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','reviewed','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_platform_request ON platform_requests(store_id,action) WHERE state='requested';
CREATE TABLE IF NOT EXISTS platform_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL, role text NOT NULL, store_id uuid,
 installation_id uuid, action text NOT NULL, reason text NOT NULL, request_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_audit ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE platform_audit ADD COLUMN IF NOT EXISTS target_seller_id uuid;
-- The WA pilot uses a separate schema and role. Expose aggregates and masked
-- session observations to the platform role through narrow read-only views.
DO $$ BEGIN
 IF to_regclass('whatsapp_pilot.wa_sessions') IS NOT NULL THEN
  CREATE OR REPLACE VIEW platform_wa_sessions AS
   SELECT s.tenant_id,s.purpose,s.state,s.connection_enabled,
    CASE WHEN s.connected_phone IS NOT NULL THEN right(s.connected_phone,4) END AS phone_suffix,
    t.paused,t.auth_enabled,t.notifications_enabled
   FROM whatsapp_pilot.wa_sessions s LEFT JOIN whatsapp_pilot.wa_tenants t ON t.id=s.tenant_id;
  CREATE OR REPLACE VIEW platform_wa_queue AS
   SELECT tenant_id,state,count(*)::int AS total,max(updated_at) AS last_update
   FROM whatsapp_pilot.wa_notifications WHERE updated_at>=now()-interval '7 days'
   GROUP BY tenant_id,state;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION platform_set_whatsapp_pause(target uuid, pause boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE whatsapp_pilot.wa_tenants
 SET paused=pause,generation=generation+1 WHERE id=target AND paused<>pause;
 IF pause THEN
  UPDATE whatsapp_pilot.wa_notifications SET state='cancelled',updated_at=now()
  WHERE tenant_id=target AND state='queued';
 END IF;
END $$;
REVOKE ALL ON FUNCTION platform_set_whatsapp_pause(uuid,boolean) FROM PUBLIC;
-- Runtime role is provisioned on production by the server bootstrap, never a superuser.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='platform_app') THEN
  GRANT USAGE ON SCHEMA public TO platform_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON sellers,otp_challenges,sessions,rate_limits,stores,
    agents,pairings,jobs,job_events,mail_tenants,platform_requests TO platform_app;
  GRANT SELECT,INSERT ON installation_history TO platform_app;
  GRANT SELECT,INSERT ON mail_audit,platform_audit TO platform_app;
  GRANT SELECT ON platform_admins TO platform_app;
  GRANT EXECUTE ON FUNCTION platform_set_whatsapp_pause(uuid,boolean) TO platform_app;
  REVOKE INSERT, UPDATE, DELETE ON platform_admins FROM platform_app;
  REVOKE UPDATE, DELETE ON mail_audit,platform_audit FROM platform_app;
  GRANT USAGE, SELECT ON SEQUENCE mail_audit_id_seq,platform_audit_id_seq TO platform_app;
  IF to_regclass('platform_wa_sessions') IS NOT NULL THEN
   GRANT SELECT ON platform_wa_sessions,platform_wa_queue TO platform_app;
  END IF;
 END IF;
END $$;
COMMIT;
