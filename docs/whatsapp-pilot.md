# WhatsApp Hubify pilot

Separate service; no platform application deployment or fleet enrollment. Only
Hubify is registered. Central number +6282211700060, seller/test recipient
+6281575652263, explicitly authorized by the owner. Owner pairs both devices.

Provider: rmyndharis/OpenWA 0.29.1, source
79d7f865e0518cb2d210deb28a84dcb0f4f39e66, amd64 image
`ghcr.io/rmyndharis/openwa@sha256:3902f1bc22744dd46b07f010653e345001832d8b79fdbe76d057869b378d186c`.
Image OCI revision checked against audited source. Baileys engine, no Chromium,
no Docker socket, no public admin dashboard, bounded resources. Provider stores
its session files privately; message retention is one day. Container logs disabled
for provider to avoid third-party logging of message/session content.

The relay has a separate database role limited to the `whatsapp_pilot` schema.
Only scoped Hubify token reaches the store. The operator owns gateway credentials
and encryption keys. Signed raw webhook, 120-second freshness, durable dedup.
Fixed templates/registered origins, explicit recipient allowlist, separate consent,
STOP, finite TTL/backoff and supersession. Unknown submission is never resent.
Manual retry is allowed once only when submission never began, still current and
unexpired, with current consent and matching connection generations.

Authentication requires a secret reply code in the initiating browser; the public
incoming challenge alone never logs in. Local verified identity has 30-day freshness
and session-version binding. First linking requires existing password. New accounts
still require verified email. This does not eliminate social-engineering or recycled
phone risk. Email/password remains available when WhatsApp is unavailable.

Operator pairing port 8093 must only be published on 127.0.0.1, reached by SSH
forwarding 127.0.0.1:8093 to 127.0.0.1:8093. It has strict Host/Origin checks, no
CORS, fixed central session, private no-store QR, no master key in the page. This
trusts the operator host/SSH account; never publish or reverse-proxy that port.
Disable WA_OPERATOR_PAIRING after owner pairing. Seller QR uses authenticated
Hubify Admin settings and cannot choose a provider session.

Deployment must record exact commit, back up schema/config, verify the existing
services' identities/readiness, install schema before relay, provision private
sessions before exposing only the API prefix, validate reverse proxy before reload.
Rollback removes only the new route and stops the new services; preserve new schema,
session volumes and audit state. Never restore production database automatically.

Local evidence: adapter, PostgreSQL auth/notification, HTTP and pairing tests.
These are mocks and do not establish real pairing, delivery or restart recovery.
Record real evidence separately after owner action; no general rollout yet.

## Tencent pilot evidence, 2026-11-10

The isolated relay at commit `f7a3fe66791cc4039de781f92c303d3f7f7f26fd`
is active through the bounded HTTPS WhatsApp prefix. Existing platform/store,
email relay, databases and proxy container identities were preserved. Anonymous
session requests return 401; the provider and private operator pairing listener
remain inaccessible through that public route. Configuration and database backup
and a route/service rollback are retained on the operator host.

First pairing exposed a real adapter mismatch: OpenWA returns `created` for a new
session before it starts. The adapter now treats that state as disconnected rather
than rejecting it. The regression test plus the full 35-test relay suite pass.

The owner confirmed central number pairing. Read-only provider/registry checks
confirmed `ready`, the expected central phone, and no remaining QR. This proves
connection only, not message delivery or authentication completion. Seller pairing
and actual test delivery remain outstanding; no general enrollment is enabled.

## Resolved private sender IDs, 2026-11-10

The real customer challenge reached OpenWA but the relay rejected its private
`@lid` sender ID before creating a reply. OpenWA 0.29.1 retains this ID and adds
`senderPhone` from its engine resolver when `RESOLVE_LID_TO_PHONE=true` (verified
on the pilot). The adapter now accepts that digits-only phone only for a direct,
fresh, unforwarded message explicitly marked `isLidSender=true` within the
verified signed webhook. LID digits are never interpreted as a phone number.
Phone-JID disagreement, unresolved LID, modified signatures, other sessions,
recipient allowlist and browser/tenant/purpose binding remain rejected.

Local regression: 38 tests pass, including PostgreSQL resolved-LID receive,
deduplication and no authentication exchange until secret-code verification.
The owner must create a fresh challenge after deployment; expired challenges
are not replayed or extended. Live reply and browser completion are pending.

Both central and seller pairings were verified ready with expected phones.
Provider polling was reduced to 30 seconds, and Retry-After is honored across
all provider routes. Operator pairing is disabled after use. A single authorized
synthetic notification was submitted once (duplicate enqueue deduplicated),
with encrypted message payload erased after submission. Delivery has not yet
been confirmed; no blind resend is permitted. Notification preferences and
synthetic consent were restored after the test.
