# B-5a88 implementation plan

## Scope and invariants

- Implement only CHK-001 through CHK-007.
- New writes use proof-or-stop role IDs, markers, artifact schema prefixes, package names, and the remote approval schema.
- Readers accept the corresponding lattice forms only where they are required for existing evidence, installed managed blocks, in-flight approvals, or explicit historical compatibility.
- Do not rewrite archived story JSON, signature salts, CHANGELOG, docs/story, tests/fixtures, or unrelated dirty files.
- The old frozen-marker and package-identity rows in earlier decisions are superseded for this story by CHK-002, CHK-005, and CHK-006; archived evidence remains untouched.
- The migration includes the full M0.5 role surface: template filenames/frontmatter, prompt registry records, agent_prompt resolution, dispatch and host shims, Codex/Claude/Antigravity asset resolution, reviewer evidence readers, delivery/floor consumers, process-fact registry, contract verifier, and explicit legacy-alias sunset behavior.

## CHK-001

Add one canonical role alias and normalization surface for all 16 canonical prompt roles plus the current verification-intent dispatch role. Use it in review-run lane resolution, reviewer classification, init-check required agents, finding and review-pass writes, quorum, delivery/floor readers, dispatch instructions, agent_prompt, prompt registry, host asset resolution, and process-fact contract checks. New writes must serialize proof-or-stop role IDs. Existing lattice and formerly unprefixed IDs must resolve to the same canonical role and remain readable. Rename or canonicalize template filenames/frontmatter and generated host/Codex manifests without rewriting historical story evidence. Define a machine-readable alias sunset rule: old inputs are read-only compatibility, new writes reject legacy IDs, and terminal evidence remains readable until its reference window expires. Add role and host golden tests.

## CHK-002

Replace managed-block writer markers with proof-or-stop start/end markers. Make the reader probe proof-or-stop first and lattice second, preserving the existing block in place on upgrade. Cover new file generation, old installed block upgrade, mismatched markers, and no duplicate blocks.

## CHK-003

Introduce a centralized artifact schema prefix and accepted-alias helper. Convert in-scope new artifact writers to proof-or-stop schema literals and make readers accept the matching lattice literals. Preserve suffix/version, integrity and freshness checks, and archived bytes. Cover the complete writer/reader/freshness/process-fact matrix, including done-required evidence and closeout-write receipts. Verify two named archived stories from different eras through CLI reads and signature/freshness checks without rewriting their JSON.

## CHK-004

Change release-push-approval writes to proof-or-stop.remote-push-approval.v1. Share the accepted schema set between the CLI reader and .githooks/pre-push. Preserve one-shot consume, stale approval rejection, and fail-closed hook behavior for invalid input. Test both schemas and a second consume attempt.

## CHK-005

Rename the root workspace package in package.json and package-lock.json to proof-or-stop, synchronize version identity with the existing version bump contract, and update exact-name self-host checks and current version output. Keep LATTICE_CLI_VERSION as the version-bump declaration target while using the proof-or-stop version alias for new reads. Add package identity, split-metadata, and Proof-or-Stop --version tests.

## CHK-006

Rename packages/utils and packages/lab package names, lockfile package entries, source documentation/import references, and all in-repo dependency edges to @proof-or-stop/utils and @proof-or-stop/lab. Update global lab entrypoint checks and verify the linked package graph resolves with @proof-or-stop/core. Old sibling npm publication names are explicitly out of scope; only repository compatibility reads required by the current graph remain.

## CHK-007

Remove the lattice bin key from packages/main/package.json and its lockfile while retaining proof-or-stop. Update entrypoint/help/residue/Codex asset verification so lattice is not advertised as a supported command. Frozen historical evidence and required compatibility readers remain explicit exceptions. Do not edit CHANGELOG.md in this story. Add a regression test that rejects reintroduced lattice bin metadata.

## Verification order

1. Run focused role, prompt registry, marker, schema, approval, package, and bin tests, including dual-read and negative cases.
2. Run the named archived story CLI read checks and verify no archived story bytes change.
3. Run the root build and the repository full test command with no concurrent git mutation.
4. Run proof-or-stop validate in TEST and record verificationEvidence for all 21 intents.
5. Run role, process-fact, entrypoint, and Codex asset contract verifiers.
6. Review the final diff against main and confirm only B-5a88 paths are staged.
