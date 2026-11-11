# Latest stable installation

The default `INSTALLER_RELEASE_POLICY=latest-stable` checks the official repository's
latest published stable release whenever an installation command is prepared.
Drafts, prereleases, branch heads, foreign repositories and assets without a digest
are rejected. An unavailable/unverified latest release produces a visible error;
the wizard never silently installs the old manifest version.

The immutable version, tag commit and artifact digest are pinned to that pairing
for its 15 minute validity. An already running installation is never switched to
a newer release mid-job. Prepare a new command after expiration or a new release.
Existing unpinned pairings retain their previous manifest release during migration.

The operator installs `deploy/btos-store-catalog.service` and `.timer`. Every five
minutes a separate operator process verifies GitHub identity, complete package
hashes, updater files, compatibility and the shipped public trust bundle. It signs
public metadata with the existing server key in a networkless container. Neither
the application nor seller VPS receives that signing key. Release history and
revocations remain intact. Failures appear in the service journal and block new
commands rather than falling back. The catalog is refreshed before its two day
expiry; operators should monitor failed units.

Publishing a stable release authorizes its discovery, not automatic fleet updates.
Existing shops still require an explicit update. The package's installed-version
range is preserved verbatim. Fresh installation of v1.7.2 does not authorize a
direct upgrade from v1.4.1 to v1.7.2.

For deliberate operator recovery only, `INSTALLER_RELEASE_POLICY=pinned` retains
the explicit manifest workflow. Do not use this to disguise a failed latest lookup.
Rollback stops/disables the catalog timer and restores the previous exact platform
image. The additive pairing release column and authenticated catalog history may
remain. Revoke unused pairings created by the newer controller if reverting to a
controller that does not understand pinned pairing releases. Do not restore a live
database as a code rollback, and do not rerun bootstrap on an active shop.
