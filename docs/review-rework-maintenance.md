# Bounded REVIEW rework

Freeze one committed candidate and collect terminal evidence from every required
lane, then the independent inventory completeness critic. Once the inventory is
complete, the reported `review_inventory_finalize --remediation` exit permits
one batch of applicable repairs in DEV without first collecting a zero-new-family
wave on code already known to need repair. This existing exit grants no TEST or
DONE authority. Refresh the affected intent GREEN evidence after the repair.

Distinguish reproduced implementation defects, missing reading, stale evidence,
and proposals for new scope. Keep original Findings and their reproduction
records. Missing reading requires actual missing reads; it is not proof of an
implementation defect. Routing and repair obligations still use the existing
applicability and scope contracts. A new request requires the scope workflow.

The independent critic can link a repeated observation to a canonical verified
Finding in the same wave or a sealed earlier wave of the same frozen epoch.
New waves retain the original Finding ID, family, and signed Finding hash in the
signed epoch. Cross-wave use rechecks the original Finding and ReviewRun evidence
against the frozen subject. Missing, altered, or legacy family-only bindings
cannot authorize the link. Grouping changes family accounting only: neither
Finding is resolved, missing reading remains missing, and a changed candidate
requires a new epoch. Status distinguishes observations from finding families.

After aggregated remediation, the existing selector computes the changed files
and canonical dependency closure. Git inventory and dirty-state output use the
registered 64 MiB review transport instead of the implicit small child-process
buffer. Overflow, unresolved dependencies, and opaque imports still require the
full active reviewer set. `reviewer_list` displays changed files, dependency
closure, and any excluded lanes. Text shows counts and at most ten bounded path
samples; `--json` retains the complete arrays. An unreadable Git dirty-state
probe reports `DIRTY_STATE_UNREADABLE` with its transport error code rather than
claiming untracked material exists. Closed, isolated test repairs may select quality
and test-coverage; production-source changes and open Findings still require the
full active set until a stronger concern-specific proof contract exists.

This repair does not convert a failed read into PASS, reduce independent-host
assurance, promise that every local source edit can skip lanes, or establish that
an existing live Story has finished. Its regressions run against built production
code and disposable fixtures, including authenticated native reviewer brokers in
a provider-neutral fixture process:

```sh
node scripts/verify-review-rework.mjs
```

The Lab record and external delivery report retain RED/GREEN, the exact before
and after code, and independent candidate audit. Local integration is a separate
explicit Lab finish operation.

The reviewed inventory executable pin is SHA-256 of emitted JavaScript after the
TypeScript JS parser/printer removes comments and normalizes newlines to LF.
It is intentionally different from a raw TypeScript source digest.
`canonicalIdentityExecutableDigest` produces that domain, and
`assertCanonicalActiveIdentityBoundary` enforces it at runtime. The Lab command
runs `scripts/verify-review-inventory-identity.mjs`, which checks the recorded pin
and current consumer, accepts comment-only changes, and rejects an executable
mutation in a disposable copy. The Git dirty-state regression uses real >1 MiB
porcelain output; its separate failure control lowers only the transport bound
to provoke a real Node ENOBUFS and verifies the full-set fallback.

Audit follow-up on the initial candidate added the executable-pin positive and
mutation checks, a real large-porcelain selector regression, an actual ENOBUFS
negative control, and bounded text rendering. The overflow diagnostic first
failed with `UNTRACKED_OR_IGNORED_MATERIAL` and now requires
`DIRTY_STATE_UNREADABLE`; material detection remains unchanged. The original
reviewed executable pin was already correct and was not replaced by a raw-source
hash. Its consumer is the final executableSources loop in
`assertCanonicalActiveIdentityBoundary`, including identity-bearing paths.

The broad `verify-proof-or-stop-residue.mjs` and identity-cutover
`--boundary-only` checks were also run on the candidate and a separately built
pristine baseline (`ed33501e1dfe1fdf6901e57f3238feb4bca037c1`). Their failure logs
are byte-identical to the respective baseline logs (274 lines for identity
boundary). These existing global failures are not asserted green. The focused
inventory boundary consumer and its executable-mutation rejection both pass.
The external Lab report retains all comparison logs. Unchanged JSON scalar
spellings in the static-edge manifest preserve the baseline encoding as well as
its parsed values; no exception or historical evidence was added or removed.
