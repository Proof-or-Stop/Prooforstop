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
4. material-clean tracked and untracked worktree: registered runtime paths
   (including the owner-lease heartbeat) may be dirty, while source, config,
   command entrypoint, other material, or unknown/unclassifiable dirty paths
   reject reuse. Canonical story metadata is non-material for command-identity
   classification, but the exact managed evidence/terminal/receipt paths must
   be clean before reused-PASS persistence; the verifier never adopts their
   pre-existing bytes. The validate-file
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
and `commandExecutions=0`. It refreshes `test-evidence.json`, appends the exact
`validation_terminal` fact, writes its closeout receipt, and installs those
three files through one isolated immutable metadata transaction. The resulting
metadata-only commit moves HEAD but does not change material or story-files
identity. An execution returns `disposition=executed`, persists the new identity
and command-execution record, appends its terminal fact before the existing
canonical metadata commit, and reports stable refusal reasons when a prior
record was considered.

The lifecycle and CLI writers must leave the next validate invocation a clean
canonical boundary. A REVIEW-to-TEST transition captures a clean baseline for
only `index.json`, `process-events.jsonl`, and `process-metrics.json`, writes its
phase/metrics facts, verifies phase hooks did not alter those bytes, and commits
only the exact changed subset with HEAD CAS and rollback. After all
`postCommand` hooks complete, the Codex CLI appends its own final `codex_cli`
row for a successful TEST transition or validate; that CLI writer separately
captures and closes only `process-events.jsonl`. A hook-created managed delta
therefore makes the final capture fail instead of becoming post-closeout dirt.
Terminal closeout failure propagates to a nonzero CLI outcome and suppresses
the original successful handler result.

Neither writer infers trust from a filename, event `type`, or prose:
pre-existing human/direct dirt, a forged canonical-looking row, hook mutation,
HEAD movement, unreadable output, or an expanded path set fails closed and is
never swept into the commit. Rollback is compare-and-restore: it restores only
worktree bytes still equal to the transaction's verified output, never rewrites
the real index, and preserves concurrent managed-path bytes/index state with a
classified diagnostic.

## Migration and rollback

Migration is lazy. Existing evidence has no complete identity and therefore
runs once; the resulting evidence can support subsequent reuse. No historical
record is upgraded in place.

Rollback is fail-closed: disable or remove the pre-execution reuse call while
leaving the versioned evidence fields readable. Validation then executes as it
did before this decision; no gate needs to reinterpret old PASS data.
