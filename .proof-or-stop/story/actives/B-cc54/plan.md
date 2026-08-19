# Plan: B-cc54 Stop the ineffective-remedy loop when a gate blocks with an identical reason repeatedly

The defect is narrow and already located: `gateFailureDigest` in
`packages/main/src/core/convergence-breaker.ts` hashes only the first 200
normalized characters of a gate refusal. For a structured gate failure that
prefix is an invariant banner, so genuinely different blockers collapse onto one
repeat-block key. Fixing one unmet precondition at a time then reads as a stuck
loop and freezes the story — and clearing that freeze needs an interactive human
TTY ack an unattended run can never obtain.

All work lands in one existing module plus its smoke. `core/gate-repeat-block.ts`
was granted by the scope contract but is intentionally NOT created: the spike
found the breaker already exists, so adding a parallel module would duplicate it.

## CHK-001: RED — reproduce an unbounded repeat-block loop against a phase gate

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Test: packages/main/src/tasks/gate-repeat-block-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/gate-repeat-block-smoke.js` exits 1 against the unfixed tree
- The failure is an assertion, not a missing symbol

**DoneWhen**:
- The smoke imports ONLY pre-existing exports, so it compiles against the unfixed tree
- Running it there prints `AssertionError [ERR_ASSERTION]: different unmet preconditions must not share a repeat-block key`
- The fixture reproduces the real precondition of the bug: the first 200 normalized characters of the three reasons are asserted identical

## CHK-002: Record consecutive identical gate blocks per story

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/convergence-breaker.ts

**Verify**:
- `node packages/main/dist/tasks/gate-repeat-block-smoke.js` prints `ok 1 different unmet preconditions get different repeat-block keys`

**DoneWhen**:
- `extractGateBlockSignals` scans the WHOLE normalized reason for bracketed reason codes and diagnostic gap ids
- `gateFailureDigest` keys on prefix + sorted signal set
- Three reasons differing only in their gap set produce three different keys, and `maxGateFailureCount` stays at 1 across them

## CHK-003: Hard-stop after the threshold and name the unmet precondition

**Owner**: main-agent
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/core/convergence-breaker.ts

**Verify**:
- `node packages/main/dist/tasks/gate-repeat-block-smoke.js` prints `ok 2 an identical blocker still accumulates to the trip threshold`

**DoneWhen**:
- A genuinely repeated blocker keeps one stable key and accumulates to `DEFAULT_CONVERGENCE_THRESHOLDS.maxGateRepeat`
- The signal set that distinguishes blockers is carried in the key, so the freeze message identifies which precondition is unmet rather than only that something was blocked

## CHK-004: Keep the breaker fail-closed and non-forging

**Owner**: main-agent
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/core/convergence-breaker.ts

**Verify**:
- `node packages/main/dist/tasks/gate-repeat-block-smoke.js` prints `ok 4 free text does not widen the key (no reset-forever hole)`
- `node packages/main/dist/tasks/convergence-breaker-smoke.js` still exits 0

**DoneWhen**:
- Appending free text to a reason does not change its key
- Only a bounded vocabulary enters the key, so a real livelock cannot reset itself forever
- `packages/main/src/handlers/finding.ts` is untouched (protected), so no finding attribution is rewritten and no gate is auto-satisfied

## CHK-005: Smoke coverage for fire, no-fire and reset

**Owner**: main-agent
**DependsOn**: CHK-002, CHK-003, CHK-004
**Files**:
- Test: packages/main/src/tasks/gate-repeat-block-smoke.ts
- Modify: lattice.config.json

**Verify**:
- `node packages/main/dist/tasks/gate-repeat-block-smoke.js` prints all four ok lines then `gate-repeat-block-smoke: PASS` and exits 0
- `lattice validate` includes the smoke in its command set

**DoneWhen**:
- Fire (identical blocker accumulates), no-fire (changed blocker does not), and back-compat (unstructured reasons keep the historical key) are each covered
- The smoke is registered in `lattice.config.json` `validate.commands`
- The pre-existing `convergence-breaker-smoke` still passes, proving no regression to the load-bearing brake
