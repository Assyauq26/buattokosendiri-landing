-- Opt-in operator migration. Not part of platform startup or fleet provisioning.
BEGIN;
CREATE TABLE IF NOT EXISTS wa_tenants (
 id uuid PRIMARY KEY REFERENCES stores(id), origin text NOT NULL UNIQUE,
 brand text NOT NULL, token_digest text NOT NULL UNIQUE,
 auth_enabled boolean NOT NULL DEFAULT false,
 notifications_enabled boolean NOT NULL DEFAULT false,
 preparing_enabled boolean NOT NULL DEFAULT false,
 paused boolean NOT NULL DEFAULT true,
 generation integer NOT NULL DEFAULT 1 CHECK (generation > 0)
);
CREATE TABLE IF NOT EXISTS wa_sessions (
 provider_id uuid PRIMARY KEY, tenant_id uuid UNIQUE REFERENCES wa_tenants(id),
 purpose text NOT NULL CHECK (purpose IN ('central','seller')),
 expected_phone text NOT NULL, connected_phone text UNIQUE,
 state text NOT NULL DEFAULT 'disconnected', generation integer NOT NULL DEFAULT 1,
 connection_enabled boolean NOT NULL DEFAULT true,
 CHECK ((purpose='central' AND tenant_id IS NULL) OR (purpose='seller' AND tenant_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS wa_one_central ON wa_sessions(purpose) WHERE purpose='central';
CREATE TABLE IF NOT EXISTS wa_challenges (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES wa_tenants(id),
 purpose text NOT NULL CHECK (purpose IN ('login','link')),
 phone text NOT NULL, browser_digest text NOT NULL,
 public_digest text NOT NULL UNIQUE, reply_digest text,
 tenant_generation integer NOT NULL, session_id uuid NOT NULL REFERENCES wa_sessions(provider_id), session_generation integer NOT NULL,
 state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','reply_queued','reply_sent','consumed','locked')),
 attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS wa_challenge_phone ON wa_challenges(phone,created_at);
CREATE TABLE IF NOT EXISTS wa_auth_deliveries (
 id uuid PRIMARY KEY, challenge_id uuid NOT NULL UNIQUE REFERENCES wa_challenges(id),
 session_id uuid NOT NULL REFERENCES wa_sessions(provider_id), phone text NOT NULL,
 payload_sealed text, state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','submitted','unknown','expired','cancelled')),
 provider_message_id text, updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wa_exchanges (
 digest text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES wa_tenants(id),
 challenge_id uuid NOT NULL UNIQUE REFERENCES wa_challenges(id),
 browser_digest text NOT NULL, phone text NOT NULL, purpose text NOT NULL,
 tenant_generation integer NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS wa_receipts (
 session_id uuid NOT NULL, message_id text NOT NULL, idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,message_id),
 UNIQUE(session_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS wa_limits (
 scope text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_consents (
 tenant_id uuid NOT NULL REFERENCES wa_tenants(id), phone text NOT NULL,
 granted boolean NOT NULL, changed_at timestamptz NOT NULL,
 source text NOT NULL CHECK(source IN ('website','STOP')),
 PRIMARY KEY(tenant_id,phone)
);
CREATE TABLE IF NOT EXISTS wa_order_heads (
 tenant_id uuid NOT NULL REFERENCES wa_tenants(id), order_id text NOT NULL,
 revision bigint NOT NULL, PRIMARY KEY(tenant_id,order_id)
);
CREATE TABLE IF NOT EXISTS wa_notifications (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES wa_tenants(id),
 event_id uuid NOT NULL, order_id text NOT NULL, revision bigint NOT NULL,
 event_type text NOT NULL, phone text NOT NULL, session_id uuid NOT NULL REFERENCES wa_sessions(provider_id),
 session_generation integer NOT NULL, tenant_generation integer NOT NULL,
 payload_sealed text, state text NOT NULL DEFAULT 'queued' CHECK(state IN
 ('queued','sending','submitted','unknown','delivered','read','failed','expired','cancelled','superseded')),
 provider_message_id text, attempts integer NOT NULL DEFAULT 0,
 submission_started_at timestamptz, manual_retries integer NOT NULL DEFAULT 0,
 next_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,event_id), UNIQUE(tenant_id,order_id,revision)
);
CREATE INDEX IF NOT EXISTS wa_notification_queue ON wa_notifications(state,next_at);
CREATE UNIQUE INDEX IF NOT EXISTS wa_notification_provider ON wa_notifications(session_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS wa_delivery_receipts (
 session_id uuid NOT NULL, message_id text NOT NULL, state text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,message_id)
);
COMMIT;
