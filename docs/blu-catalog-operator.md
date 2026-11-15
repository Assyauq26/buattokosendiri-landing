# blu v1.8.2 catalog-only operator continuation

This does not deploy the central app, modify its database, or update any shop.
The owner authorized publishing the payment release for compatible shops after
Hubify deployment/smoke. The new publisher supports only the existing1.8.0 path
and the exact canonical1.8.1→1.8.2 blu path, using separately root-reviewed approvals.

Keep `/etc/btos-platform/updater-publication.json` and every historical catalog.
The new approval lives at `/etc/btos-platform/updater-publications/v1.8.2.json`:
`source` is the root-owned immutable merged seller-repository checkout, `sha` and
`targetSha` are that exact merge, `artifactDigest` is the final published archive,
`baselineArchive` is the unchanged public1.8.1 artifact, `channel` is stable,
and `installations` is an explicit list of verified IDs. A deliberately reviewed
general cohort requires exactly `["*"]` and `generalEligibilityReviewed:true`;
it still requires exact source/schema/files/migrations and revised worker support.
The1.8.0 approval never accepts a wildcard.

The full installer Git inventory is verified before importing the exact reviewed
policy builder. It pins the original31 migration checksums plus exact32/33 SQL,
full baseline app inventory, source/tree/schema, release artifact and cohort.
Unknown versions/executors/artifacts remain rejected. Policies retain global
sequence monotonicity across releases and refresh within the existing timer.

The operator runtime is the existing independently reviewed platform image digest
4a71f979… from6064d26; no new platform app image is built or activated. Only the
new reviewed signing scripts are mounted into network-disabled, read-only,
capability-free signing processes. Private keys remain in their original root-only
directory, outside app mounts and public releases.

Before changing the publisher timer override, back up the override files, both
approval locations and catalog metadata, record all running app/container image
identities, validate the exact helper checkout and keep the prior ExecStart.
Use a separate systemd drop-in bound to the new helper's merged SHA. Reload unit
metadata; never restart the central web app, database, proxy or other shops.
Publish only after the seller artifact is released and Hubify smoke passed.
Independently verify the resulting catalog signature, sequence, artifact size/digest,
cohort, policy identity and expiry. Verify all app identities remain unchanged.

If publication fails, retain the last signed catalog and journal. Restore the
publisher drop-in/approval from the operator backup if needed; do not restore a
database or replay an older signed catalog. Preserve all release identities and
revocations. Existing Google clients/consent and bank activation stay per store;
GoPay remains unavailable in this release.
