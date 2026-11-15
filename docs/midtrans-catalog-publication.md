# Midtrans v1.9.0 catalog publication

Operator helper only. No central web application deployment or tenant update.
Requires root-owned `/etc/btos-platform/updater-publications/v1.9.0.json` pinning
the reviewed seller source SHA, same target SHA, artifact digest, canonical
v1.8.3 baseline archive and explicit general-eligibility approval. Uses the
existing networkless signer and immutable operator runtime image.

The exact policy is `canonical-v183-to-v190-midtrans`, executor
`midtrans-snap-forward-v1`, schema34→35. It authenticates source/tree/files,
all34 old checksums, the one new SQL checksum, baseline schema and artifact.
Worker3 alone is insufficient: its installed source revision must implement the
executor. Older revisions reject it; catalog signing does not install a worker.
No exception for custom runtime, noncanonical ledger or unsupported baseline.

Activation follows verified Hubify deployment, nontransactional smoke, annotated
tag and release asset/checksum publication. Back up catalog, signing approvals
and service drop-ins; keep old release entries, revocations and approvals intact.
Point only the catalog service ExecStart at the reviewed helper checkout and
run the existing service. Verify both signatures, exact target/digest, increasing
sequences, unchanged historical entries/approvals and all application container
identities/start times. Do not change any application service or dispatch apply.

Recovery: restore the previous catalog service override and restart the existing
catalog publisher if its helper fails before publication. A published signed
catalog is append-only with monotonically increasing sequence; do not replace it
with an older sequence. Correct/revoke through the existing operator mechanism.
Never remove a historical tag or mutate its asset.

Validation policy for this task: Python/JavaScript syntax and focused code review;
no local suite, payment simulator, new staging or sandbox payment transaction, per
owner instruction. Production catalog authentication runs after actual publication.
