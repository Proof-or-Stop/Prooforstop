# B-3434 — plan

## The defect, precisely
`isolatedBlobHash`, `isolatedGit` and `treeBlobHash` in `core/done-prepare-generated-metadata.ts` call
`execFileSync` with no `maxBuffer`, so Node's 1048576-byte default applies. A larger staged blob throws
ENOBUFS; the two hash helpers swallow it with a bare `catch { return null }`; the caller compares that
null against the expected digest and reports **verified metadata changed after manifest verification**.
That message names concurrent modification, so the reader looks for another session, dirty metadata or a
race — and none of those is the cause.

## Where the size comes from
Per-command captured output is ALREADY bounded upstream: `trimOutput` / `MAX_OUTPUT_CHARS = 12000` in
`core/validation-executor.ts`. What is unbounded is the AGGREGATE — `handlers/verifier.ts` serialises
every command result into `test-evidence.json`, so the artifact grows with the NUMBER of configured
commands. Measured 1,369,692 bytes on B-9ff1 after `validate.commands` grew 56 → 100 in one day.
**Raising the ceiling therefore moves the cliff; it does not remove it.**

## Order of work
1. **RED first.** Write the regression before touching the fix: stage a blob above 1048576 bytes, drive
   the commit path, assert success. Confirm it FAILS on today's tree and commit that RED.
2. `maxBuffer` on every blob/tree read in the module — audit, do not patch only the observed one.
3. Replace the swallowing catch so *absent* and *unreadable* stay distinguishable and the underlying
   error is surfaced. Keep fail-closed: an unreadable blob must never be treated as a match.
4. CHK-004: decide the aggregate-growth question and **ship the decision**. Bounding, or a committed
   rationale naming a concrete successor change. A written opinion with no consequence does not close it.
5. CHK-005: advisory when the serialised artifact passes a warning fraction **of the ceiling this story
   sets**, following the `buildLedgerSizing` three-tier shape in `core/proofstory.ts`.

## Anchors
Reference by file + symbol, never line number. Relevant symbols: `isolatedBlobHash`, `isolatedGit`,
`treeBlobHash`, `commitImmutableMetadataTree`, `persistStoryValidationEvidence`, `trimOutput`,
`MAX_OUTPUT_CHARS`, `buildLedgerSizing`.

## Out of scope
The hard-coded fifteen-minute watchdog ceiling `story_advance` inherits from the generic per-command
default (a real, separate asymmetry against `done_prepare`'s config-derived budget); scheduling or
parallelisation of configured commands; which entries `lattice.config.json` declares; upstream
per-command truncation.

## Self-bootstrapping
A worktree runs the `dist` it builds itself, so once this story compiles, its own REVIEW→TEST gate
exercises the repaired code. That is what makes the fix reachable at all.

## CHK-001
Audit every `execFileSync` in `core/done-prepare-generated-metadata.ts` that reads blob or tree content —
`isolatedBlobHash`, `isolatedGit`, `treeBlobHash` at minimum — and give each an explicit generous
`maxBuffer`. Patching only the helper the transcript named leaves the identical latent limit on its
siblings, which is preMortem scenario 1.

## CHK-002
Replace the bare `catch { return null }` in the hash helpers so *blob genuinely absent* and *blob could
not be read* remain distinguishable, and so the surfaced reason names the underlying error. Preserve the
fail-closed posture: an unreadable blob must never compare equal. This is the item that turns the next
occurrence from hours into minutes.

## CHK-003
Commit a regression that stages a blob larger than 1048576 bytes, drives the same commit path, and
asserts success. It MUST be shown to fail on the pre-fix tree — a fixture below the limit passes on the
unfixed tree and proves nothing, which is precisely why this defect survived.

## CHK-004
Reach a BINDING disposition on aggregate artifact growth and ship it. Either bound what
`persistStoryValidationEvidence` serialises into `test-evidence.json`, or commit a rationale that
explains why unbounded growth is acceptable and names a concrete successor change. Closing this with a
written opinion and no shipped consequence recreates the cliff this story exists to end.

## CHK-005
Emit a visible advisory when the serialised artifact passes a warning fraction of the ceiling CHK-001
sets — not of the old 1 MiB default — following the three-tier shape of `buildLedgerSizing` in
`core/proofstory.ts`. The advisory must not change validate's pass or fail verdict.
