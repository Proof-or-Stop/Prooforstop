# Changelog compaction: local Lab verification

The user requested removal of older root changelog entries and concise future
updates in Lab mode on 2026-09-18. The baseline is local main
`a8768173bc7488aa8fdc3ef45f1ed295cbd924c8`. No Git history is rewritten.

The root file shrinks from 683,921 to 708 bytes. The three retained bullets describe
the final v0.3.407 behavior. Its Git pointer retrieves the complete prior log with
SHA-256 `252e0187959b1881a4e902a32be4cd05d1355fe851e60db94d922016c87c0e5d`.
Concurrent main releases v0.3.408 and v0.3.409 were subsequently synchronized;
their entries are preserved above the compact baseline, making the file 3,943
bytes. The synchronization baseline is
`0e0ea031485dd0aedce3c484af45d24aacb032eb`.
Future notes use 3-5 final-change bullets; authors read the current entry or relevant
diff and retrieve older Git content only for a historical question. These are
authoring instructions, not a new runtime limit on release-note length.

## Independent audit repair

Audit `98457074-b0af-475c-9f55-a25539778d2f` rejected the first candidate.
The current repair addresses its four findings:

- Retention requires both exact prior bytes and an ancestor of HEAD; a readable
  but unreachable commit cannot authorize compaction.
- The process contract launches the fixed verifier in a child, requires its GREEN
  selector and aggregates failure. `EX-CHANGELOG-COMPACTION-CONTROLS` binds the
  callsite, verifier and existing identity dependency closure.
- Controls exercise incorrect row paths and the real frozen-file gate with invalid
  historical hashes, object IDs and a missing tracked changelog.
- The regression Git reader uses the existing identity verifier's 64 MiB buffer.

Audit `6790fd09-510e-460b-9ad8-0894111adb29` confirmed the compaction gate and
regressions, but its snapshot lacked the subsequently completed process-contract
result. It also identified a misplaced existing registry comment. The comment is
now immediately above its original owner-coverage entry. No registry declaration
changed. The focused verifier additionally executes the actual parent wiring
block and its actual `assert`/`fail` collectors in an isolated VM. A controlled
child boundary verifies the executable, argv and 60-second budget; missing GREEN
output, a thrown child failure and missing registration each collect exactly one
failure, while the success control collects none. This avoids recursive child
launches and preserves the real parent aggregation code rather than duplicating it.

## Developer-run observations

These observations supplement the tool-owned local Lab RED/GREEN records.

- `node scripts/verify-changelog-compaction.mjs` reports
  `CHANGELOG_COMPACTION_GREEN` after the audit repair.
- `node scripts/verify-validation-static-edges.mjs` reports `U18_STATIC_PASS`:
  `needsReview=0`, `nested=0`, `unexpandedCommands=0`. A disposable manifest with
  the new verifier's dependency digest replaced by zeroes exits 1 and reports
  `U18_STATIC_NEEDS_REVIEW`; source files and the real manifest are not mutated.
- `node scripts/verify-proof-or-stop-identity-cutover.mjs --boundary-only` exits 1
  on both the stated main baseline and the repaired Lab. Their diagnostic sets
  contain the same 238 lines, with no added or removed diagnostic. This is a
  pre-existing repository-health failure, not a passing identity-suite claim.
- After an earlier transient managed-supersession failure, the full command
  `node scripts/verify-process-fact-contract.mjs --quiet` completed with exit 0 at
  candidate `f2e0fed7787e005952434fcf3666c5e14b986384`. Its parent wiring is unchanged
  by the second audit repair. The literal final output was:

  ```text
  Process fact contract verified
  execution_assertion_reuse_contract=PASS
  Process-fact contract verification passed
  ```

  The subsequent focused run exercises the added parent negative controls and
  the real child/Git gate in one invocation: observed wall time 1.454 seconds,
  against the parent's 60-second budget. Static-edge validation again reports
  `U18_STATIC_PASS` with zero needs-review, nested or unexpanded commands. The
  dependency binding now also includes the imported failure formatter and its
  build-binding module; the formatter's build preparation function is not invoked.

The history gate still binds the original frozen blob and the exact compact
baseline. Missing Git content, failed ancestry, modified pointers, arbitrary
truncation and changed historical bindings remain refusals. Ordinary release
prepends remain compatible. This Lab has not been integrated into main.
