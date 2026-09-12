# Current source evidence for static exceptions

An exception rationale requires current structured source evidence. Reviewers
must read the referenced source and decide whether it justifies the classification.
The scanner checks consistency, not the semantic truth of that justification.

Use `createStaticSourceEvidence` from `scripts/static-source-evidence.mjs` to
produce `file`, `startLine`, `endLine`, `sourceDigest`, and `excerpt` together from
one source read. Ranges are inclusive and one-based. Do not update outer file or
call hashes while retaining an old current excerpt. After edits or a main merge,
regenerate affected evidence, inspect the resulting diff, and rerun the scanner
before independent audit. A generated excerpt does not grant review approval.

Every current structured excerpt must match the referenced file's SHA-256 and
exact line slice. At least one must include the registered call's starting line
in the same file. Paths must remain inside the repository, including symlink
resolution. An explicit `historical: true` object and narrative strings may retain
historical context, but neither can satisfy the current-source requirement.

Run `node scripts/verify-validation-static-edge-boundaries.mjs` for the regression
contract. It exercises the actual scanner with stale nested hashes, invented
text, invalid/stale ranges, missing call coverage, and history-only evidence, plus
coherent positive controls and the existing child-process traversal boundaries.
The committed manifest is migrated using the source-reviewed static-registry-closure
candidate `ce472dad13`, with every structured excerpt independently checked against
this Lab's source. The regression also checks every committed manifest entry.
The existing v1 format already allowed structured excerpts; this change enforces
their contents and diagnoses narrative-only entries explicitly. No schema shape
is removed. Older stale manifests now need evidence regeneration and review;
the scanner never silently refreshes or reclassifies their rationale.
