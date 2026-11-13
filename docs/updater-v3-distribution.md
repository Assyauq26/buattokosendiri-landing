# Reviewed updater v3 distribution

Owner authorization: final review, merge, catalog configuration, controlled pilot
and production release after safety checks; seller initiates each app update.
Do not dispatch Actions or alter the published store v1.8.0 tag/archive.

## Exact pairing and trust

- App: v1.8.0 / `7e81f8e60b27ab5695ac50ac6b653b63095e36d1`.
- Archive: 4,398,817 bytes / SHA256
  `2e15208d27a87a4aeae4446404d45a1f91b55fcc5d28da3714dc064aeeaa9223`.
- Worker v3: separately pinned store source
  `1239bec7b8c769810841a4aeb8f719e4770db8fa`; 35 Python files.
- Canonical predecessor: v1.7.4 / `c3cfb22fb03bc3bea37aadfb6d790c75e805d51b`;
  archive `0a286296c0c85e5e320f85043e85dede0213e013dae129351a374df35f586b4e`.

The agent downloads authenticated app bytes and separately pins the reviewed
worker Git checkout. It invokes the existing fresh-only hook, which validates
the complete immutable app archive, arms systemd provisioning, and preserves the
socket directory before the old installer starts. It never bootstraps an existing
shop. On completion the agent waits for the same systemd unit as the timer, then
verifies installed worker bytes and socket health. Reattachment cannot silently
mark a v2 installation complete. Old enrolled agents are not remotely replaced.

## Operator publication

Keep `/etc/btos-platform/updater-publication.json` root-owned and not writable by
group/others. It contains `source` (root-owned immutable store checkout), `sha`
(worker source above), `baselineArchive` (exact v1.7.4 archive), `installations`
(explicit array of verified 32-hex installation IDs; no wildcard), and `channel`
(`pilot` initially, `stable` only after the controlled public-catalog pilot).
This file is not an application API and contains no private key.

The existing refresh service still rejects false rollback by default. Only the
reviewed canonical app identity may enter the additional migration publication
path. The helper verifies pinned source bytes before importing worker policy
code, authenticates both complete archives, prepares a format-2 bound policy,
and signs it using the existing key in a networkless, read-only container.
The private key stays exclusively on the signing host. The helper independently
authenticates the resulting policy before embedding it in the signed catalog.
`minimumUpdater=3`, exact 1.7.4 range and `rollbackCompatible=false` remain intact.

The 5-minute timer refreshes policy at less than 6 hours remaining, increases
policy/catalog sequences, retains authenticated release/revocation history, and
limits catalog expiry to the policy expiry. The shared refresh lock serializes
publication. No catalog publication triggers an app update.

## Deployment and recovery

Deploy only a reviewed exact platform commit with the official activation
helper. It retains the reviewed read-only catalog overlay and rejects unknown
active overlays. Back up platform config, signed catalog, public trust, timer
configuration and a consistent platform dump. Verify a scratch restore before
activation. Keep the old image/source; rollback code using the same catalog
overlay. No platform schema changes are required by this follow-up.

Install store workers through the official `update_service.worker_upgrade`
dry-run/apply path after checking idle jobs and healthy mounted sockets; keep
configuration, prior source/receipt and route backups. Do not change J&T flags,
store data, domains or credentials. Never restore a DB as a worker rollback.

For a publication failure keep the last authenticated catalog and investigate
the service journal; do not set false rollback to true. To stop expansion publish
a higher signed catalog/policy sequence with the previous reviewed cohort. Do not
replay an older signed catalog over a newer sequence. Application recovery after
migration is forward-only as specified in the store worker runbook.

## Evidence and release gate

Relevant package/trust tests, immutable-archive policy signing/refresh tests on
the disposable QA VM, agent completion/denial tests, latest-installer resolver
tests and source build must pass. The controlled legacy pilot must use the real
public catalog and actual dashboard button, with 29 original ledger rows and
data preserved through 30 migrations. New fresh QA already on v1.8.0 is not
substitute evidence for that legacy pilot. Keep publication pilot-only until
that check completes; do not claim all sellers have upgraded workers.
