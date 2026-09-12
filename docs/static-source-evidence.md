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

## Lab patch release transaction

The Lab finish path refreshes already-valid evidence for its official patch-only
version outputs in the same release commit. It verifies the old full-file digest
and exact old excerpt before generating the new fields, and verifies changes to the official version and lock files are limited to their
version fields. It also updates bound
dependency hashes and preserves classifications and rationale. Stale prior
evidence, invalid ranges, or non-version edits refuse the transaction and restore
the prior version and manifest bytes. Other source changes still require source
review and explicit evidence regeneration. The version regression runs a complete
disposable Lab finish with a synthetic transport provider; this test fixture is
not the independent Claude audit required for the real Lab candidate.

The subsequent local-main integrations through `9a526607f6` were reviewed before
re-anchoring eight unchanged excerpts and four unchanged call expressions. The
bounded dependency update covers the official version files, the full-suite
registry additions, and process-fact registry assertions. No exception category,
rationale, invocation, or call digest changed during this reconciliation.

The release transaction also preserves the exact line count and each line's
bytes except the validated old-to-new version literal. It refuses reformatting
and malformed historical flags, and tests non-patch/malformed transitions plus
undeclared or unexpected output paths with rollback. The disposable finish
regression budget sums its four CLI call limits plus setup allowance and reports
transport timeout separately from a failed source-evidence assertion. The two
Lab-driver exceptions additionally bind the driver and both source-evidence
helpers, so changes to that behavior require fresh review.

The official regression now verifies every entry-level source digest and every
dependency digest, then runs the real scanner against the committed repository.
Lab patch refresh refuses a noncanonical manifest instead of reformatting it.
After local-main `ee1b815a84`, the additional literal snapshot-binding reader was
reviewed: its TypeScript AST checks read one source file and have no subprocess
launches. The refreshed runtime-contract entries bind that reader and source,
and the new exact callsite is registered as EX-RUNTIME-SNAPSHOT-BINDING.

Local-main `73bb02e52a` inserts two validation commands. All 166 prior command
objects were matched byte-for-byte in order to their new indices; no existing
invocation changed. The new classifier and partial-hash scripts contain only
literal Git subprocess calls at their direct child-process sites, so the scanner
adds no exception for them. Their package script insertion and the reviewed
process-fact declaration changes are reflected in current source/dependency
bindings; the complete 168-command scan passes without new exception categories.

Projects without the static manifest retain the ordinary shared version producer.
For manifest-bearing projects, manifest publication and rollback restoration use
same-directory temporary files and rename, avoiding partially written individual
files. This is per-file atomicity, not a crash-atomic multi-file transaction. A
rename-failure regression verifies restoration and removal of temporary debris.

The 0.3.343 merge retains the independently registered runtime snapshot edge,
its precise read-only source-contract classification, and its additional
removal/dependency/invocation regression controls. The duplicate local draft
entry is superseded by that exact main entry.


The regression driver is currently operator-invoked by the pinned Lab command,
not automatically scheduled by ordinary `proof-or-stop validate`. The production
scanner is registered and enforces evidence consistency. The official draft
[static-evidence-regression-registration](story/drafts/static-evidence-regression-registration/background.md)
owns routine regression registration under the framework validation-maintenance
backlog, including runtime measurement, resource policies and exact child closure.
This scheduling gap is explicitly deferred; current RED/GREEN and real Claude
release audit remain required.

Digests bind original file bytes; UTF-8 decoding is used only for excerpt slicing.
Missing evidence files have a stable refusal. Version outputs must be valid UTF-8
and the guarded core allowlist must match the main producer's existing exported
VERSION_SYNC_PATHS. Its two private optional extension-lock paths remain explicit
compatibility bindings; an unexpected producer output raises a distinct allowlist
drift refusal before publication. Changes outside those outputs
remain subject to the surrounding Lab clean-tree assertion.

See [Lab verification provenance](static-evidence-lab-verification.md) for official
draft creation/discovery counter-evidence and measured child timeout headroom.

All version-transaction negatives use newly allocated disposable roots. The
manifest-free path delegates before any version-path or source-content guard.
The full disposable release also checks entry-level digest refresh. Child output
capture has an explicit 32 MiB ceiling and a distinct output-limit diagnostic.

## CLI runtime Lab integration reconciliation

The CLI runtime Lab merged main `7dd2470088` before release preparation. Its
three added root package test aliases leave every existing script, dependency,
and version unchanged. The bootstrap dependency change only preserves runtime
version refusals; the build-binding helper changes are comments. Process/runtime
registry and verifier changes add the already reviewed CLI admission, observation,
queue, and build-prerequisite contracts.

This reconciliation refreshes 51 affected dependency bindings and re-anchors eight
unchanged call expressions with newly generated current excerpts. Existing
classifications, rationale, invocation bindings, and call digests are preserved.
Eight added process-contract calls receive exact `fixture-regression` entries,
binding their fixed child source, preparation helper, and build inputs. The budget
fixture also binds its single final-controls companion. The observation fixture's
self child is restricted to its lock-holder mode; it does not recursively run the
suite. Their preparation is build work, and their disposable CLI/handler controls
retain their assertion status and timeout behavior. These entries grant no root
validation re-entry or arbitrary child-command permission.

The unchanged production scanner reports 75 needs-review rows and eight stale
entries before this reconciliation, then zero of either after it. This is source
evidence consistency, not a Story delivery speedup or an independent audit PASS.
Entry-removal and child-dependency drift controls accompany the standard static
boundary and version-transaction regression before the real Claude release audit.
