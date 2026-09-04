# Merged-state collision: B-5a15 execution-key dedup vs B-1482 narrowing fixture

Status: open design question. Do NOT settle it inside a merge.

## Symptom

`npm run test:narrowing-repin` fails 5 cases on merged main, the first being:

```
[FAIL] CHK-002/B1 B-a745 shape end to end ... -- the recorded render genuinely FAILED
```

## Established by controlled experiment, not inference

| Tree | narrowing-repin failures |
|---|---|
| clean `origin/main` (separate worktree, own deps, own build) | **0 (exit=0)** |
| merged main, before fixture repairs | 11 |
| merged main, after fixture repairs | **5** |

`origin/main` carries no `packages/main/src/core/causal-evidence.ts` at all - that file is
B-5a15's. So the collision is created by the merge, not by either parent being wrong.

## Mechanism

B-1482's fixture needs ONE pinned command to yield BOTH a passing and a failing receipt,
achieved by rewriting an untracked `render-mode.txt` between two `verification_evidence_add`
calls. `createCausalExecutionKey` covers `cwd`, `command`, `inputs`, `effectiveEnvironment`.
The only difference between the two runs is working-tree file CONTENT, which enters none of
them, so both collapse to one execution key and the second call reuses the first PASSING
receipt.

Confirmed separately that differing `inputs` DO yield differing keys, so the mechanism is
sound; the gap is specifically that read-file content is not a declared input.

## Three workarounds tried and rejected on evidence

1. `HandlerContext.causalPreflightFacts` test seam - clears the preflight, but the commit
   path calls `revalidateCached()`, which re-derives the real snapshot and refuses
   fabricated hashes with `causal_commit_snapshot_invalid`. The guard working as designed.
2. Track the mode file so it counts as material - measured `currentMaterialHash` before and
   after rewriting it, both untracked AND tracked-and-committed: IDENTICAL both ways,
   because it hashes committed tree state, not working-tree content.
3. Give each run its own mode file so the commands differ - destroys the test's premise,
   which is that both receipts share ONE pinned command
   (`recordedSelector(failing.receipt) === OLD_SELECTOR`).

## The open question

Should the causal execution key incorporate the content of files the pinned command reads?

- Including it weakens the exact-key deduplication that is B-5a15's headline deliverable.
- Excluding it leaves B-1482-style fixtures unable to express "same command, different
  outcome" at all.

Both stories are correct in isolation. Per CLAUDE.md's merged-state combination review this
belongs in a dedicated story that decides the key's contract and deliberately adjusts the
losing side, with rationale recorded - NOT by weakening the execution key, relaxing
B-1482's assertions, or fabricating a failing receipt. All three were available here and
were declined.

## Fixture gaps that WERE fixed in the merge (11 -> 5 failures)

- `writerLease:writer_unavailable` - the fixture drives checklist handlers directly and so
  never passes the CLI ownership gate. Fixed by seeding the same lease a real story-scoped
  command acquires (`acquireOwnerLease`), matching the precedent in
  `closeout-trust-smoke.ts:575`.
- `gitMaterial:git_material_or_story_files_hash_unavailable` - `currentStoryFilesHash`
  short-circuits to `undefined` unless `resolveStoryMergeBase`
  (`core/story-aware-validation.ts:153`) can merge-base HEAD against `main` or
  `origin/main`; the fixture initialises on `work` alone. Fixed with `git branch main`.
