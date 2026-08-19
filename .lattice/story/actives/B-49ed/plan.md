# Plan: B-49ed Require a host-adapter session to sign a topology-critic receipt

Decision (decision_set option A): accept `host-adapter` and `generated-token`; refuse
`explicit-env` and `derived-ppid`. Both accepted sources pass the same provider + task +
agent gate in `owner-session-adapters.ts:160-173` and are hash-derived, so an implementer
cannot choose them.

Ordering note: CHK-001 lands the guard, which immediately breaks the test suite until
CHK-002 migrates it. They must be done together, in one worker, or `main` is briefly red.

## CHK-001: Require sessionSource host-adapter in deriveRoleProvenance

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/topology-critic-receipt.ts
- Modify: packages/main/src/handlers/proofstory.ts

**What**: add a `sessionSource: SessionSource` parameter to `deriveRoleProvenance` and refuse
any value outside the accepted set. Import the type from `../core/owner-session.js`. Both
production call sites (`proofstory.ts:550` exclusion approver, `:565` critic) pass
`getSessionIdentity().sessionSource`; import `getSessionIdentity` alongside the existing
`getSessionId`.

Bind BOTH roles, not just the critic: the same forgery argument applies to a scope-plan
exclusion approval, and there are exactly two non-test callers, both in that file.

The error message must name the received source and say what to do, e.g.
`must sign from a host-adapter session, received "explicit-env"`.

**Verify**:
- `npm --prefix packages/main run build` exits 0
- `grep -n "sessionSource" packages/main/src/handlers/proofstory.ts` shows both call sites

**DoneWhen**:
- `explicit-env` and `derived-ppid` are refused before any verdict branch is reached
- the `9f9f53a514` pass/request_changes asymmetry is untouched
- no production caller outside these two sites needs a change

## CHK-002: Migrate test session setup from LATTICE_SESSION_ID to adapter env

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/tasks/ (167 lines / 170 occurrences across 29 files)

**What**: replace direct `LATTICE_SESSION_ID` assignment with a real adapter env —
`LATTICE_OWNER_SESSION_ADAPTER_PROVIDER` + `_TASK` + `_AGENT` — so the adapter derives the
session the way a host does. Usage is uniform (67 direct assignments plus save/restore
pairs), so introduce ONE shared helper and route every file through it.

Trap: the derived id depends on `projectRoot`, so fixtures comparing hardcoded literals such
as `sess-critic` must resolve them via `deriveAdapterOwnerSessionId(realpathSync(root), ...)`
rather than matching the string. `LATTICE_SESSION_ID` must be absent, not merely overridden —
it short-circuits adapter resolution to `explicit-env`.

**Verify**:
- `npm run test:legacy` pass count equals the pre-change count
- `grep -rn "LATTICE_SESSION_ID" packages/main/src/tasks/` returns only deliberate
  negative-path tests

**DoneWhen**:
- no test establishes a signing identity via `LATTICE_SESSION_ID`
- a dropped pass count is treated as a defect, never as a passing migration

## CHK-003: Prove the guard bites under mutation

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/tasks/proofstory-topology-critic-smoke.ts

**What**: assert each refused source (`explicit-env`, `derived-ppid`) throws, and that an
accepted source still signs. See CHK-005: the frozen context of this item also lists
`generated-token` as refused, which PLAN investigation superseded.

**Verify**:
- `node packages/main/dist/tasks/proofstory-topology-critic-smoke.js` exits 0
- reverting the CHK-001 guard makes it fail, naming the forgeable source

**DoneWhen**:
- the assertion demonstrably fails without the guard (mutation-proven, per F-115)

## CHK-004: Prove a genuine dispatched critic can complete receipt signing end to end

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Test: live dispatch, no file change expected

**What**: the item that guards against the top preMortem — a guard that blocks everyone.
Dispatch a real critic through the host, then `review_run_start`, then
`topology_critic_receipt_set` for both verdicts.

main-agent owns this because it requires dispatching a subagent, which an implementer cannot
do for itself.

**Verify**:
- `request_changes` succeeds on a stale basis
- `pass` is still refused while the basis is stale
- `topology_critic_receipt_check` reports the recorded verdict rather than
  `no current registered dispatch provenance`

**DoneWhen**:
- a critic that did NOT receive its session id from the implementer signs successfully
- if the real host does not supply provider + task + agent, that BLOCKS the story rather than
  being worked around

## CHK-005: Accept generated-token alongside host-adapter as a host-derived signing source

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/topology-critic-receipt.ts
- Modify: packages/main/src/tasks/proofstory-topology-critic-smoke.ts

**What**: accept `generated-token` in the same guard. It passes the same provider + task +
agent gate and additionally requires a boundary token, so it is equally unmintable. The
B-3f3d prototype refused it; that was over-strict and buys no security while breaking hosts
that legitimately use it.

This item exists because CHK-003's context froze at INIT_CHECK with the older, stricter
wording. It is recorded openly rather than by editing a frozen requirement.

**Verify**:
- a `generated-token` session signs successfully
- `explicit-env` from the same test still fails

**DoneWhen**:
- accepted set is `host-adapter` + `generated-token`; refused set is `explicit-env` +
  `derived-ppid`
- REVIEW rules on whether this supersedes CHK-003's frozen context or needs an INIT reopen
