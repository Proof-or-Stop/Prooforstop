# Plan: B-da89 Reconcile dev_start phase-policy drift (widen config to the authoritative 4-phase set)

> **Scope.** `npm run test:process-fact-contract` fails on dev_start INIT + DEV because
> `core/config.ts` DEFAULT_PHASE_TOOLS lists dev_start only under INIT_CHECK + PLAN, while the
> authoritative set is `['INIT','INIT_CHECK','PLAN','DEV']` (asserted by the dev_start handler guard
> at handlers/worktree.ts:823, by command-policy.ts:130, and by the B-804c intent). Decision: **widen
> config** — add the literal `dev_start` to DEFAULT_PHASE_TOOLS' INIT and DEV arrays. No dev_start
> behavior change; no other command touched. English-only.

## CHK-001: Add dev_start to DEFAULT_PHASE_TOOLS INIT + DEV so all sources agree

**Owner**: lattice-implementer  **DependsOn**: none
**Files**:
- Modify `packages/main/src/core/config.ts`: add the EXACT literal `'dev_start'` to the DEFAULT_PHASE_TOOLS arrays for the INIT and DEV phases (mirroring the existing INIT_CHECK/PLAN entries + their B-804c recovery comment). Do NOT use a wildcard. Do NOT change command-policy.ts or the handler (they already have the correct 4-phase set — confirm by reading them).
**Verify**:
- For dev_start, command-policy.allowedPhases (`INIT,INIT_CHECK,PLAN,DEV`) equals the isCommandAllowed-from-config view across all phases; dev_start still NOT allowed in REVIEW/TEST/DONE.
- No other command's phase permissions change (diff is the two dev_start literal additions only).
**DoneWhen**:
- config.ts DEFAULT_PHASE_TOOLS includes dev_start under INIT, INIT_CHECK, PLAN, DEV and nowhere else; command-policy.ts and the handler guard are unchanged.

## CHK-002: Regression guard — process-fact contract passes and a future divergence is caught

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**:
- No new test expected: `scripts/verify-process-fact-contract.mjs assertCommandPolicyPhaseAlignment` already asserts command-policy.allowedPhases === isCommandAllowed for every command x phase (both directions). Confirm it is the guard. Only add a focused assertion if a gap is found (avoid redundancy).
**Verify**:
- `npm run test:process-fact-contract` exits 0 (no dev_start INIT/DEV drift; and no NEW drift surfaced — if another command drifts, call it out as out-of-scope, do not bundle).
- Locally re-introducing the INIT/DEV mismatch makes the contract exit 1 again (divergence mechanically caught).
- `lattice validate` green.
**DoneWhen**:
- The contract exits 0 after the fix, the divergence is provably caught on reintroduction, and validate is green.
