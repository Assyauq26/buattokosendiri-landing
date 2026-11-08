# Operator mail provisioning candidate

NO-GO for public production. No existing approved release is changed.

This branch coordinates with `Assyauq26/buattokoonline` branch
`codex/automatic-mail-provisioning` (proposed v1.2.0). Apply the additive schema
before activating `MAIL_PROVISIONING_ENABLED=1`. Generate a dedicated operator
`MAIL_CONTROL_SECRET` (64 hex characters) server-side and share it only with the
private relay. AUTH_SECRET encrypts retryable tenant tokens in a separate vault
namespace. Never include either secret in browser data, logs or an artifact.

New tables: `mail_tenants`, `mail_audit` (append-only for platform_app). Provisioning
locks store rows, serializes admission, and returns one stable credential on retry.
The canary admission ceiling is three tenants due to the verified free provider
budget. `/agent/job` advertises mailRequired; old/off controllers do not break
existing installation flow. Mail-enabled completion requires a current signed
readiness receipt. Completed agents reconcile credentials every120seconds.

Control endpoint: POST `/api/platform/internal/mail-registry`, authenticated with
the operator-only secret. **Deny this route at the public reverse proxy.**
Paired-agent endpoints: POST `/agent/mail`, POST `/agent/mail-ack`.
Owner endpoints: GET/POST `/store/mail` (platform session and same-origin).
Owner actions: identity, administrators, rotate, disable, enable. Expected
generation prevents concurrent lost updates. Only OTP-verified platform accounts
can be administrators. Domain changes require matching DNS. Agent claims never
authorize registry edits. `/revoke` disables mail and appends an audit event.

Owner approval synchronizes the canonical registry immediately; the agent
reconciles runtime credentials. Published branding must match that approved
identity. Domain runtime/HTTPS migration remains a separate operation; mismatches
fail closed and are shown as action-needed. Do not call this a complete automatic
store-domain migration.

Before any production activation: obtain final approval, backup platform DB plus
AUTH_SECRET and proxy configuration; deploy the reviewed relay digest on a
private network; validate complete Caddy configuration before reload; check
platform health and Hubify ready before and after. Roll back exact saved proxy
configuration/image on regression. Preserve additive tables and quota/delivery
storage; do not restore a revoked token as valid.

The companion repository `docs/central-mail-candidate.md` contains the service,
quota, monitoring, rollback, test evidence and release-gate report. Capacity,
current-candidate real inbox evidence, Ubuntu2GB installer/rollback, exact tagged
release and public rollout remain gates. No merged PR implies deployed code.
