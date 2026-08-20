# B-5a88 implementation plan

## Scope and invariants

- Implement only CHK-001 through CHK-007.
- New writes use proof-or-stop role IDs, markers, artifact schema prefixes, package names, and the remote approval schema.
- Readers accept the corresponding lattice forms only where they are required for existing evidence, installed managed blocks, in-flight approvals, or teammate compatibility.
- Do not rewrite archived story JSON, signature salts, CHANGELOG, docs/story, tests/fixtures, or unrelated dirty files.
- Keep package metadata, lockfiles, self-host detection, hooks, and tests synchronized in the same delivery.

## CHK-001

Add one canonical role alias and normalization surface, then use it in review-run lane resolution, reviewer classification, init-check required agents, finding and review-pass writes, quorum, and dispatch instructions. New writes must serialize proof-or-stop role IDs. Existing lattice role IDs must resolve to the same lane and remain readable. Add happy, edge, and adversarial tests for canonical writes, legacy reads, and malformed role rejection.

## CHK-002

Replace managed-block writer markers with proof-or-stop start/end markers. Make the reader probe proof-or-stop first and lattice second, preserving the existing block in place on upgrade. Cover new file generation, old installed block upgrade, mismatched markers, and no duplicate blocks.

## CHK-003

Introduce a centralized artifact schema prefix or alias helper. Convert in-scope new artifact writers to proof-or-stop schema literals and make readers accept the matching lattice literals. Preserve suffix/version, integrity and freshness checks, and archived bytes. Audit process-fact and residue checks so they do not treat accepted historical schemas as new writes.

## CHK-004

Change release-push-approval writes to proof-or-stop.remote-push-approval.v1. Share the accepted schema set between the CLI reader and .githooks/pre-push. Preserve one-shot consume, stale approval rejection, and fail-closed hook behavior for invalid input. Test both schemas and a second consume attempt.

## CHK-005

Rename the root workspace package in package.json and package-lock.json to proof-or-stop, synchronize version identity with the existing version bump contract, and update exact-name self-host checks. Keep LATTICE_CLI_VERSION as the version bump declaration target while using the proof-or-stop version alias for new reads. Add package identity and split-metadata tests.

## CHK-006

Rename packages/utils and packages/lab package names, lockfile package entries, source documentation/import references, and all in-repo dependency edges to @proof-or-stop/utils and @proof-or-stop/lab. Update global lab entrypoint checks and verify the linked package graph resolves with @proof-or-stop/core.

## CHK-007

Remove the lattice bin key from packages/main/package.json and its lockfile while retaining proof-or-stop. Update entrypoint/help/residue verification so lattice is not advertised as a supported command. Frozen historical evidence and required compatibility readers remain explicit exceptions. Add a regression test that rejects reintroduced lattice bin metadata.

## Verification order

1. Run focused unit or smoke tests for each checklist item, starting with role and marker helpers.
2. Run package identity and entrypoint checks after lockfile and bin changes.
3. Run the root build and the repository full test command with no concurrent git mutation.
4. Run proof-or-stop validate in TEST and record verificationEvidence for all 21 intents.
5. Review the final diff against main and confirm only B-5a88 paths are staged.
