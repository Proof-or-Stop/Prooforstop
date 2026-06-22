# Story Files Hash Material Drift

Date: 2026-06-19

## Problem

Lattice records several gate-consumed bindings against the current whole-tree
`materialHash`. That is sound, but too coarse for parallel story work: merging
an unrelated change into `main` can change the whole-tree hash and stale a
review run, verification evidence, or review escalation record even when the
story-owned files that record was actually attesting did not change.

The fix is not to remove `materialHash`. Whole-tree drift can still represent
transitive dependency changes, runtime policy changes, or gate-fact changes that
are outside a story's direct file diff. The fix is to add a second, narrower
binding signal and make the downgrade explicit.

## Decision

Add `storyFilesHash` as an optional secondary freshness signal recorded
alongside, never instead of, the existing whole-tree `materialHash`.

`storyFilesHash` is a deterministic SHA-256 over the story-owned material files:

1. Resolve the story's signed git workspace.
2. Resolve the merge-base between current `HEAD` and `main`.
3. Use the story's changed files between that merge-base and `HEAD`.
4. Exclude story metadata and runtime artifacts with the same material-exclusion
   policy used by `materialHash`.
5. Hash each remaining path with its blob object id at the target ref, sorted by
   path. Deleted story-owned paths are included with a deletion marker so
   removing a story-owned file changes the hash.

The existing whole-tree `materialHash` remains byte-for-byte unchanged and is
still recorded on every adopted binding. Consumers must not infer that a record
is fully fresh merely because `storyFilesHash` matches.

## Adopted Bindings

The secondary signal applies to gate-consumed records whose validity is
currently evaluated through `materialHash` freshness:

- review runs and their workspace binding;
- checklist verification evidence;
- review escalation host verdicts and degraded fallback records.

Legacy records without `storyFilesHash` keep the existing strict
`materialHash` behavior. Missing or uncomputable `storyFilesHash` must never
turn a stale `materialHash` record into a pass.

## Freshness Semantics

When both a record and the current workspace have `storyFilesHash` values:

- matching `materialHash` means the record is fresh with no advisory;
- mismatching `materialHash` plus matching `storyFilesHash` means the record is
  valid for the story-owned file set, but the result must include an explicit
  whole-tree drift warning requiring re-attestation review;
- mismatching `storyFilesHash` means the record is stale and must be rejected;
- missing current `storyFilesHash` falls back to strict `materialHash` behavior.

The warning is mandatory. This is not a silent rebind, not an automatic evidence
refresh, and not permission to rewrite stored hashes. Operators and reviewers
must see that unrelated whole-tree material drift occurred.

## Why Not Story-Diff Only

Story-diff-only freshness is insufficient because Lattice gates also depend on
shared runtime code and process facts. A story can leave its own changed files
untouched while a merge to `main` changes a transitive helper, validation
runner, review policy, or process-fact registry entry. Treating that as fully
fresh would hide a real risk. `storyFilesHash` therefore only downgrades the
failure from "reject as stale" to "valid with re-attestation advisory" when the
story-owned files did not change.

## Rejected Alternatives

- Replace `materialHash` with story-diff-only hashing. Rejected because it hides
  transitive dependency and global gate-fact drift.
- Silently rebind records to the current whole-tree hash when the story file set
  matches. Rejected because it erases audit history and makes stale evidence
  appear freshly attested.
- Treat all whole-tree drift as fatal forever. Rejected because it blocks
  independent story work after unrelated `main` merges.

## Process Fact Contract

`storyFilesHash` freshness is a gate-consumed process fact. The runtime
semantics must be registered in `process-fact-levels.ts`,
`process-fact-registry.ts`, and the process-fact contract verifier. The
registered semantics must state that story-owned file changes still invalidate
the binding, while unrelated whole-tree `materialHash` drift is only accepted
with an explicit re-attestation advisory.
