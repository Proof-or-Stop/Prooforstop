# B-867c real-machine transcript: `npm run test:process-fact-contract` RED-before → GREEN-after

**Verification of record.** `lattice validate` does NOT run this guard (decoupled from the battery; B-99b6 owns wiring it in). So the explicit `npm run test:process-fact-contract` run below is the authoritative proof.

Command (root): `node scripts/verify-process-fact-contract.mjs` (== `npm run test:process-fact-contract`).

---

## EXPECTED (PLAN outcome)
Operator runs `npm run test:process-fact-contract` and sees it exit 0 — final line `Process fact contract verified`, NO `Process fact contract failed:` block, NO `MAIN_TOOLS command ... missing` lines, NO `DEFAULT_PHASE_TOOLS phase allowlist drift` lines. The 7 commands appear in the registry dump.

---

## ACTUAL — RED before (main @ INIT, captured in worktree before the fix)

`EXIT=1`. Failure block (28 lines = 1 levels-missing line + 21 drift lines [7 phases × 3 patterns] + 7 registry-missing lines):

```
Process fact contract failed:
- packages/main/src/core/process-fact-levels.ts: MAIN_TOOLS command(s) missing from registry: playbook_approve, playbook_diff, playbook_propose, playbook_reject, recall, signature_registry_list, signature_registry_set
- packages/main/src/core/process-fact-registry.ts: DEFAULT_PHASE_TOOLS phase allowlist drift phase=DEV pattern=playbook_*
- packages/main/src/core/process-fact-registry.ts: DEFAULT_PHASE_TOOLS phase allowlist drift phase=DEV pattern=recall
- packages/main/src/core/process-fact-registry.ts: DEFAULT_PHASE_TOOLS phase allowlist drift phase=DEV pattern=signature_registry_*
  [... drift repeated for phases DONE, INIT, INIT_CHECK, PLAN, REVIEW, TEST — 21 lines total ...]
- packages/main/src/core/process-fact-registry.ts: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=playbook_approve
- packages/main/src/core/process-fact-registry.ts: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=playbook_diff
- packages/main/src/core/process-fact-registry.ts: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=playbook_propose
- packages/main/src/core/process-fact-registry.ts: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=playbook_reject
- packages/main/src/core/process-fact-registry.ts: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=recall
- packages/main/src/core/process-fact-registry.ts: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=signature_registry_list
- packages/main/src/core/process-fact-registry.ts: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=signature_registry_set
```

---

## ACTUAL — GREEN after (story/B-867c HEAD, fix applied)

`EXIT=0`. Final lines:

```
Process fact contract verified
```

No `Process fact contract failed:` block. Failure/drift grep count = 0.

The 7 commands now appear in the registry dump with handler-accurate levels:

```
- playbook_approve [L2/command] producer=handlers/playbook
- playbook_diff [L0/command] producer=handlers/playbook
- playbook_propose [L2/command] producer=handlers/playbook
- playbook_reject [L2/command] producer=handlers/playbook
- recall [L0/command] producer=handlers/recall
- signature_registry_list [L0/command] producer=handlers/signature-registry
- signature_registry_set [L2/command] producer=handlers/signature-registry
```

---

## DIFF NOTES (expected vs actual)
- Expected EXIT 0 → Actual EXIT 0. MATCH.
- Expected no missing-command lines → Actual: all 7 `MAIN_TOOLS command missing` lines (registry + levels) gone. MATCH.
- Expected no drift lines → Actual: all 21 `DEFAULT_PHASE_TOOLS phase allowlist drift` lines gone. MATCH.
- The drift cleared with NO `config.ts` edit: the 7 patterns were already in `DEFAULT_PHASE_TOOLS['*']` (config.ts:189-191) with `allowedPhases:'all'` in command-policy; registering the 7 in `PROCESS_FACT_LEVELS` (the source the registry derives from) made `patternHasRegistryApprovedCommand` find a match per phase, clearing every drift line. Root cause was purely the missing registry registration.

## Supporting evidence
- `npm --prefix packages/main run build` → exit 0 (tsc passes; entries match `ProcessFactLevelEntry`).
- `npx tsc -p packages/main --noEmit` → exit 0 (no type regression).
- `lattice validate --story=B-867c` → ALL PASS, verification intent coverage 6/6 (0 required missing).
- Source change: commit `3ded509e9` — `packages/main/src/core/process-fact-levels.ts` +7 lines only (no handler / cli-engine.ts / config.ts change). Author: lattice-implementer.
- No gitRoot code touched (B-6666 scope); no validate-battery wiring touched (B-99b6 scope).
