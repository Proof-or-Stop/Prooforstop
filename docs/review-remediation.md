# Atomic review remediation

During DEV remediation, the owner calls `review_remediation_close` once for a
repair set from a consumed, finalized review inventory. The request binds
`storyId`, a stable `repairSetId`, `epochId`, the full `repairCommit` SHA, and a
nonempty `findings` array. Each entry contains `findingId`, `resolution`, and
`verification` references with `itemId`, `intentRef`, and the canonical SHA-256
`evidenceDigest` of the stored verification evidence row. The references identify
existing tool-executed evidence; the command does not accept caller-authored
PASS receipts or rerun tests.

Before publication, all findings must be open members of the signed inventory.
Every reference must cover a current intent with a matching command/selector pin,
fresh material and a valid signed successful V5 execution/publication bundle.
The shared strict verifier binds Story, intent, command, selector and recorded
freshness, and authenticates complete output artifact bytes. Readable legacy
receipts grant no closure or convergence-progress authority; re-execute the
pinned verifier to obtain current evidence. The same check runs immediately
before publication, so a removed or changed artifact refuses the whole set. The repair commit
must follow the inventory cutoff and precede the executed proof. Blocking dirty
source or fixture paths refuse the whole set. A missing proof on any finding
leaves the entire ledger unchanged.

The command prepares existing individually signed, exact-CAS lifecycle
transitions against private snapshots and publishes the complete ledger once
under the findings fence. It retains the original findings and each transition's
signature and source binding. It then rebuilds the canonical projection and
metrics, commits only those three metadata artifacts, and reports `openCount`
from a fresh canonical read. An open count is a finding-state fact, not a REVIEW
PASS, inventory-completeness receipt, TEST authorization or Story DONE claim.

If projection or Git commit fails after publication, the terminal facts remain
durable and the command reports failure. Retry the exact request with the same
`repairSetId`; it verifies the signed batch marker, repairs missing derived
artifacts and finishes the pending metadata commit without appending terminal
facts again. A completed retry preserves ledger bytes and commit identity.
Changing a request under the same ID is an idempotency conflict. Resolve an
unrelated staged-path or commit-hook refusal before retrying; do not amend the
repair claim or manually rewrite the ledger.
