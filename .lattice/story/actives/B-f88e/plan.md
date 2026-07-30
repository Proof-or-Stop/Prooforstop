# Plan: B-f88e Stop the storyFilesHash downgrade from colliding a superseded quorum into permanent invalidity

Chosen option: **A-skip-colliding-downgrade** — decline the rewrite when it would land an
identity-equal verdict on top of one already native to the current material.

## CHK-001: Land the red reproduction as a registered test that fails on the current defect

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: `packages/main/tests/red/red-f88e-quorum-downgrade-collision.mjs`
- Modify: `lattice.config.json` (append one `validate.commands` entry)

**Source material**: a working reproduction already exists and has been executed; it is at
`/private/tmp/claude-501/-Users-jek-Documents-Work-proofbound--claude-worktrees-frosty-maxwell-0f4a01/16483f3c-7924-45d0-9117-2638cdb38b82/scratchpad/red-quorum-downgrade-collision.mjs`.
Port it as-is apart from making the two imports relative to the repo (it currently uses
absolute paths), matching the `red-b2aa7-*.mjs` convention: shebang, a header comment stating
the defect and the live B-4043 observation, accumulate into a `failures` array, print each
failure and `process.exit(1)` when non-empty, otherwise print an OK line and `process.exit(0)`.

**Verify**:
- `node packages/main/tests/red/red-f88e-quorum-downgrade-collision.mjs` exits **1** before
  CHK-002 with `DOWNGRADE COLLISION: ... counted as 0/3 valid rounds` and six
  `duplicate host/session/key identity` reasons.
- The same command exits **0** after CHK-002.
- `node -e "require('./lattice.config.json')"` parses and the new entry appears exactly once.

**DoneWhen**:
- The test asserts the CORRECT behaviour (3/3 valid rounds, zero manufactured duplicates), so it
  is genuinely red today rather than asserting the bug.
- It keeps the non-vacuity assertion: the current-material submission ALONE must already yield
  3/3, otherwise the fixture proves nothing.
- It keeps the on-disk distinctness assertion, proving the duplicate is manufactured by the
  downgrade rather than planted by the fixture.
- Registered in `lattice.config.json` `validate.commands`.

## CHK-002: Skip the downgrade rewrite when it would collide with a live verdict of the same identity

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: `packages/main/src/core/review-escalation.ts` (`eventsWithStoryFilesHashDowngrade`)

**Change**: before rewriting a verdict's `materialDigest` to the current value, check whether a
verdict with the same `runId` and an overlapping independent host identity already exists
*natively* at the current `materialDigest`. If so, leave the superseded verdict untouched (it is
already superseded; the live one carries the round) and do not push its advisory. Identity
overlap must be compared the same way `groupByIndependentHost`
(`packages/main/src/core/host-independence.ts:69`) does — union on ANY of `hostId` / `sessionId` /
`keyId` — and a short comment at both sites should record that coupling.

**Verify**:
- `npm --prefix packages/main run build` clean.
- `node packages/main/tests/red/red-f88e-quorum-downgrade-collision.mjs` exits 0.
- `node packages/main/dist/tasks/review-assurance-floor-smoke.js` and
  `review-assurance-floor-storyfileshash-smoke.js` still pass (the drift-acceptance behaviour
  they cover must be unchanged).

**DoneWhen**:
- A lone superseded verdict with no live identity-equal counterpart is STILL downgraded and still
  emits its re-attestation advisory (unrelated whole-tree drift behaves exactly as before).
- Two genuine same-identity verdicts recorded natively at the current material STILL invalidate
  the round — the double-vote check is not weakened. The precondition only ever skips verdicts
  whose `materialDigest` differs from the current one, so native duplicates are never exempted.
- No change to `host-independence.ts`, `quorum-submit.ts` or `review-assurance-floor.ts`.
