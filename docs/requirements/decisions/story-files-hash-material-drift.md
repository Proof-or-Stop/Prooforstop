# Story Files Hash Material Drift

Date: 2026-06-19

## Problem

Proof-or-Stop records several gate-consumed bindings against the current whole-tree
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
4. Exclude story metadata, runtime artifacts and the defined evidence-store output
   locations with the same material-exclusion policy used by `materialHash`.
5. Hash each remaining path with its blob object id at the target ref, sorted by
   path. Deleted story-owned paths are included with a deletion marker so
   removing a story-owned file changes the hash.

The original introduction of this secondary hash kept `materialHash` unchanged.
The September 2026 accuracy correction below adjusts output classification;
`materialHash` is still recorded on every adopted binding. Consumers must not infer that a record
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

Story-diff-only freshness is insufficient because Proof-or-Stop gates also depend on
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

## DONE Sub-Gate Bindings (Amendment 2026-06-24)

The DONE gate has three freshness sub-gates. After review they are bound as follows.

Adopted with extra guard (signed): delivery-check (core/delivery-check-hash.ts), the proof-or-stop-review-delivery reviewer's signed attestation of the story's git diff vs main, doc-promises, and real-machine tests. storyFilesHash is folded INTO the signed payload (signDeliveryCheck / recomputeDeliveryCheckHash) and persisted on the record; keying a relaxation on an unsigned field of a signed record is forbidden because it is forgeable. With storyFilesHash signed, materialHash mismatch + matching signed storyFilesHash downgrades to a mandatory re-attestation advisory (code delivery_check_drift_advisory), never to "fresh"; storyFilesHash mismatch hard-rejects; missing storyFilesHash falls back to strict; the stored hash is never rebound. Because delivery-check attests whole-tree behavioral claims (real-machine tests) and is the last gate before merge, the advisory must be operator-visible and direct re-attestation if the integrated runtime context changed.

Kept strict (re-runs): the done-required build+full-test-suite evidence (core/done-required-validation.ts evaluateDoneRequiredEvidence). On whole-tree materialHash drift it re-runs the suite on the merged tree rather than downgrading, so behavioral breakage from an unrelated merge is caught directly; this cheap genuine re-verification is preferred over an advisory for the suite.

Excluded (kept strict): the completed-DONE-projection evidence snapshot check (core/done-oracle.ts checkCompletedEvidenceSnapshotFreshness). It recomputes materialHash AT the recorded evidence.headHash (a frozen past ref) to verify the recorded (headHash, materialHash) pair is self-consistent — an evidence-integrity / tamper check, not a HEAD-drift freshness check. storyFilesHash computed at the same frozen ref yields no independent signal and an unrelated main merge does not change the tree at the recorded head, so this gate cannot exhibit the whole-tree-drift symptom; storyFilesHash MUST NOT be wired into it.

## September 2026 accuracy correction

Both hashes now exclude only the evidence store's defined `objects/sha256/`,
`refs/by-id/` and `ledger/observed.jsonl` outputs below accepted state-directory
spellings. These remain process artifacts, not disposable runtime state. Unknown
paths and policy files within `evidence/` remain material. The shared
`material-path-policy` owns this boundary; no blanket evidence-directory ignore
or new runtime cleanup permission is introduced.

Consumers must still independently verify output digests, subject binding,
signatures and acceptance requirements. A stable material hash does not verify an
artifact. Never rewrite existing evidence or silently re-attest old hashes after
upgrading; use the applicable consumer's normal freshness/re-attestation path.
Use the implementation belonging to the current checkout consistently when
producing and consuming evidence; a matching version string alone cannot prove
identical implementation bytes.

The shared changed-file resolver uses NUL-framed Git output and literal tree
paths, preserving Unicode, tabs, newlines and backslashes during blob lookup.
Renames retain the old deletion marker and target blob. Missing target objects
fail closed instead of being represented as deletions. This corrects the hash
inputs; it does not change review or certification authorization.

`node scripts/verify-hash-accuracy.mjs` runs the 27 independent exact-digest
oracles plus special-path, publication, corruption and material-drift controls.
The existing story-files-hash-batch validation entry invokes this regression.
The historical 33.7% speed claim is withdrawn: this is an accuracy correction,
and no whole-Story speedup or faster single hash computation has been measured.
