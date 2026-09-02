# B-022e execution plan

## CHK-001
Inventory every tracked active legacy identity by class and record the clean-break superseding decision before production edits. The decision defines canonical Proof-or-Stop writes, removal semantics, and an exact frozen-evidence allowlist. Historical stories, migration inputs, compatibility fixtures, changelog history, signature salts, and provenance-bound schemas stay byte-stable.

## CHK-002
Add and commit a single acceptance harness that fails on the current tree. It checks package/bin/role/env/path/config/prose residue, exact allowlist freshness, historical baseline digests/signature verification, clean-install negatives, and mutation sensitivity. Run it at the baseline commit, record red_evidence_create against the stable cutover acceptance target, and prove B-022e remains discoverable through story_get/checklist_get.

## CHK-003
Rename the root package and Lab/Utils packages to proof-or-stop / @proof-or-stop/*, synchronize all tracked manifests and lockfile nodes, and update global Lab resolution. Inspect packed manifests and ensure no distributable file: dependency or @lattice edge remains.

## CHK-004
Remove the lattice npm bin alias and every active command/wrapper fallback. Rename active source/script/hook entrypoint filenames and call sites, and update spawned commands, help, errors, hints, CI, hooks, and package scripts to proof-or-stop only. Clean-install smoke must prove lattice is absent.

## CHK-005
Remove active read-both legacy runtime identity behavior. Rename constants, identifiers, environment keys, state/config/adapter names, files, registry keys, and all lattice-named Agent/role identities to Proof-or-Stop, including proof-or-stop-review-story-init. Rename role template filenames/frontmatter/config routing/generated assets and make old role IDs unresolvable. Preserve only exact cryptographic/provenance literals covered by the frozen allowlist.

## CHK-006
Update current README/CLI/AGENTS/CLAUDE prose, templates, adapters, hooks, verifier diagnostics, and generated prompt mirrors. Do not rewrite prior decision statements or CHANGELOG history; the new decision supersedes them explicitly.

## CHK-007
Reach GREEN on the same acceptance target: build core/Lab/Utils, run identity/entrypoint/Lab/process/runtime/prompt/Codex verifiers, pack all publishable artifacts, install them in isolated prefixes/projects, run proof-or-stop version/help/lab help/lab run/doctor, assert lattice and @lattice/* negatives, rerun historical baselines, and run allowlist mutation proof.

## CHK-008
Synchronize the root and Core package/lock/version surfaces at 0.3.270; retain Utils's independent 0.3.268 runtime version and @proof-or-stop/core ^0.3.268 extension-API floor; retain Lab's independent 0.3.65 runtime version and @proof-or-stop/core ^0.3.65 floor. Rebuild dist, commit evidence, run the required REVIEW lanes against the renamed canonical roles, add verificationEvidence for all 29 refs, run routine validate and configured DONE-required validation, then done_prepare --mergeMain --refreshStale --validate and story_advance DONE. Do not push remote branches or main.
