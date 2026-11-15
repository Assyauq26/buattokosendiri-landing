# v1.8.3 payment catalog continuation

This changes only the reviewed root publisher, not the central application,
database, proxy, any seller runtime or existing approvals. Follow the existing
blu-catalog-operator runbook and retain its backups and all historical envelopes.

The third explicitly reviewed path is canonical public v1.8.2/schema33 to
v1.8.3/schema34, executor `payment-live-forward-v1`. The seller repository builder
pins the actual ef7b338 baseline, full app/file/migration inventory and the one new
QRIS snapshot migration. Unknown paths still fail closed.

Create `/etc/btos-platform/updater-publications/v1.8.3.json` only after merged
seller source, immutable final artifact, Hubify deployment and smoke are verified.
Fields follow the v1.8.2 approval, with source/sha/targetSha bound to the exact
new merge, artifactDigest to the published archive and baselineArchive to unchanged
public v1.8.2 (55913f7c…9e6a). General catalog eligibility requires the deliberate
`["*"]` cohort and `generalEligibilityReviewed:true`; it does not run any update.

Back up approvals/catalog/drop-ins and record all running container identities.
Use a new SHA-bound helper checkout and a new timer override; keep previous
approvals unchanged. Reuse the exact existing operator runtime digest and isolated
networkless signer. Never mount signing credentials into either web application.

Check signature, global sequence, history/revocations, source/digest/size,
33→34 policy, cohort, expiry and unmodified app identities. Publication failure
keeps the previous catalog; restore operator configuration if necessary, without
rolling back database data or replaying an older signed envelope. Shops without
the reviewed worker revision remain guarded. Gmail/GoPay connection and checkout
activation remain explicit per-shop actions; no account is connected by publishing.
