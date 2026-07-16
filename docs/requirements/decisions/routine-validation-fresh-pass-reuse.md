# Routine Validation Fresh-PASS Reuse

## Decision

`lattice validate --story=<id>` may reuse a prior project-command PASS instead
of spawning the same commands again. Reuse is an optimization only: any missing,
legacy, malformed, changed, dirty, or unreadable input falls back to real
execution and can never manufacture PASS.

The overall validation verdict and project command truth are separate. Evidence
stores a versioned `commandExecution` record independently from verification
coverage. A prior overall `PASS` remains eligible. An old overall `FAIL` is
eligible only when its stored coverage exists and records
`missingRequired > 0`, proving the failure was coverage-only, and current
coverage is recomputed complete. Missing coverage, `missingRequired === 0`, an
unknown overall result, or contradictory fields execute normally. In every
case its structured command execution must be complete PASS and every other
predicate must match. A command failure, timeout, infrastructure failure,
cancel, skip, or partial execution is never reusable. For validate-file
sources, command truth includes the parsed validator verdict: process exit 0
with JSON `status: fail` or `allPass: false` records
`commandExecution: FAIL` and is never reusable.

## Complete identity

Evidence stores `lattice.routine-validation-identity` version 1. Its digest
binds:

- source kind: configured commands, fallback discovery, validate file, or no
  validator;
- source/config inputs and validate-file entrypoint digest;
- normalized ordered commands: label, command, args, resolved cwd, shell,
  effective timeout, optional flag, focus tags, executable digest, and a digest
  of the effective child environment;
- invocation `full`, `focus`, and effective workflow profile;
- required `verificationIntent` definitions and resolved workflow/verification
  policy inputs;
- platform, architecture, and Node version.

Raw effective-environment values are never persisted. Only their SHA-256 digest
is stored, so a child-visible value change invalidates reuse without exposing
credentials or tokens. `verificationEvidence`, timestamps, outputs, and other
mutable story metadata are excluded from identity.

Legacy evidence or unknown/partial identity versions execute normally.

## Reuse gate

The decision occurs inside `withValidationExecutionLock`. It requires all of:

1. structured, complete `commandExecution: PASS`;
2. complete identity digest equality;
3. current required verification coverage with `missingRequired === 0`;
4. material-clean tracked and untracked worktree: canonical Lattice story
   metadata and registered runtime paths (including the owner-lease heartbeat)
   may be dirty, while any source, config, command entrypoint, other material,
   or unknown/unclassifiable dirty path rejects reuse. The validate-file
   `--changed-files` input and its identity use this same material-only filter,
   so metadata/runtime churn cannot change the command while source/config
   changes still do;
5. matching material and story-files hashes;
6. exact HEAD or a descendant whose intervening commits touch only canonical
   story-metadata paths; and
7. identical HEAD and material-clean snapshots before and after classification.

Routine validate and DONE pre-run reuse share the same lineage classifier. A
non-ancestor, empty descendant, rename/path ambiguity, non-metadata path, git
error, or HEAD race rejects lineage.

An accepted hit returns `disposition=reused`, its lineage and identity digest,
and `commandExecutions=0`. It does not rewrite `test-evidence.json`, append an
activity fact, auto-commit metadata, or move HEAD. An execution returns
`disposition=executed`, persists the new identity and command-execution record,
and reports stable refusal reasons when a prior record was considered.

## Migration and rollback

Migration is lazy. Existing evidence has no complete identity and therefore
runs once; the resulting evidence can support subsequent reuse. No historical
record is upgraded in place.

Rollback is fail-closed: disable or remove the pre-execution reuse call while
leaving the versioned evidence fields readable. Validation then executes as it
did before this decision; no gate needs to reinterpret old PASS data.
