# B-da89 real-machine transcript vs PLAN-outcome diff

Reconciles the dev_start phase-policy drift by widening config.ts DEFAULT_PHASE_TOOLS to the authoritative
4-phase set. No dev_start behavior change.

## Expected (understanding.outcome)
> The process-fact contract is green (no dev_start INIT/DEV drift) and the documented dev_start recovery is
> runnable in DEV (no longer refused by the phase-tools gate).

## ACTUAL (real machine, in the B-da89 worktree)

Process-fact contract after the fix:
```
$ npm run test:process-fact-contract
...
Process fact contract verified
(exit 0)
```

The change (the only source diff, +2 lines in packages/main/src/core/config.ts):
```
   INIT: [
+    'dev_start', // B-804c CHK-001 / B-da89: INIT is a valid worktree bootstrap entry; reconcile config with command-policy + worktree handler 4-phase set
   ...
   DEV: [
+    'dev_start', // B-804c CHK-002 / B-da89: explicit worktree recovery entry; reconcile config with command-policy + worktree handler 4-phase set (DEV still in the pre-REVIEW bootstrap window)
```

Guard round-trip (implementer-verified): removing a dev_start entry from the DEV array → contract exits 1
(`dev_start DEV policy/default phase drift (policy=true, isCommandAllowed=false)`); restoring it → exit 0.

## Diff notes
- **Match.** Before: `npm run test:process-fact-contract` exited 1 on dev_start INIT + DEV. After: exit 0,
  "Process fact contract verified". The fix is exactly two literal `'dev_start'` additions to the INIT and
  DEV arrays of DEFAULT_PHASE_TOOLS — no behavior change, no wildcard, no other command/phase touched.
- **Authoritative set confirmed by three sources:** the dev_start handler guard (handlers/worktree.ts:823,
  INIT required by the atomic bootstrap), command-policy.ts:130, and the B-804c reason all declare
  ['INIT','INIT_CHECK','PLAN','DEV']. config.ts was the lone outlier; it was widened up to match. The
  behavior reviewer confirmed command-policy is the enforcement CEILING (isCommandAllowed refuses dev_start
  in REVIEW/TEST/DONE before the config gate is consulted), so the config addition cannot over-widen.
- **Regression guard:** the existing assertCommandPolicyPhaseAlignment in verify-process-fact-contract.mjs
  asserts command-policy.allowedPhases === isCommandAllowed for every command x phase (bidirectional), so a
  future dev_start (or any command) phase divergence turns the contract red. No redundant test added.
- Round 1 REVIEW was clean (0 findings); behavior reviewer (force-mounted for the phase-policy change)
  verified no over-widening and that REVIEW/TEST/DONE refusal is preserved.
- This is the backlog item discovered during B-f675 (pre-existing dev_start drift), now closed.
