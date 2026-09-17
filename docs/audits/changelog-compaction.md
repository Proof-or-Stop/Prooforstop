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
- The process-fact contract passed before the independent audit repair. Its
  subsequent rerun stopped in the unchanged managed supersession fixture with
  `supersession fixture provider must complete`; replaying that exact child
  command reported `MANAGED_SUPERSESSION_PASS`. This is not a claim that the
  complete contract passed on the final candidate.

The history gate still binds the original frozen blob and the exact compact
baseline. Missing Git content, failed ancestry, modified pointers, arbitrary
truncation and changed historical bindings remain refusals. Ordinary release
prepends remain compatible. This Lab has not been integrated into main.
