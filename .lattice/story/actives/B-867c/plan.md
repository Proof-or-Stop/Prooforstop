# Plan: B-867c Green the RED process-fact-contract (register 7 commands + reconcile DEFAULT_PHASE_TOOLS)

## Root analysis (read before touching code)

`npm run test:process-fact-contract` (root `package.json` -> `scripts/verify-process-fact-contract.mjs`) is RED on main:
- 7 MAIN_TOOLS commands missing from the process-fact registry: `playbook_approve`, `playbook_diff`, `playbook_propose`, `playbook_reject`, `recall`, `signature_registry_list`, `signature_registry_set`.
- DEFAULT_PHASE_TOOLS phase-allowlist drift for patterns `recall`, `signature_registry_*`, `playbook_*` across all 7 phases (21 lines = 7 phases x 3 patterns).

**CRITICAL edit-target fact (INIT-001 advisory):** The checklist context says "PROCESS_FACT_REGISTRY array ~line 871" — that line is only the spread combiner. The registry's COMMAND entries (`COMMAND_PROCESS_FACTS`) are **DERIVED from `PROCESS_FACT_LEVELS`** in `packages/main/src/core/process-fact-levels.ts` (see `process-fact-registry.ts:585` mapping over PROCESS_FACT_LEVELS). **The single edit target for command registration is `process-fact-levels.ts`.** Do NOT add entries to the `PROCESS_FACT_REGISTRY` spread at line 871.

**Why registering alone fixes the drift too:** `COMMAND_PROCESS_FACTS` pulls `allowedPhases` from `COMMAND_POLICIES[name].allowedPhases` (`process-fact-registry.ts:597`). All 7 commands already have `allowedPhases:'all'` in `command-policy.ts` (lines ~205-215). The drift check (`verify-process-fact-contract.mjs:2672-2679`, `patternHasRegistryApprovedCommand`) requires, for each DEFAULT_PHASE_TOOLS pattern x phase, a registry command matching the pattern whose `allowedPhases` includes that phase. Once the 7 are registered (with `allowedPhases='all'` from policy), every phase is covered and the 21 drift lines clear. DEFAULT_PHASE_TOOLS already lists the 3 patterns in the global `'*'` array (`config.ts:189-191`), which is the correct, safe placement.

**Classification (READ from handlers; do not guess):**
| command | handler | read-only/mutating | gate-consumed? | level | category |
|---|---|---|---|---|---|
| `signature_registry_list` | handlers/signature-registry | read-only (lists tags) | no | L0 | `experience-layer-read` |
| `signature_registry_set` | handlers/signature-registry | mutating (`.lattice/learning/signature-registry.json`) | no gate reads it | L2 | `experience-layer` |
| `playbook_propose` | handlers/playbook | mutating (writes proposal) | no | L2 | `experience-layer` |
| `playbook_diff` | handlers/playbook | read-only (renders candidate) | no | L0 | `experience-layer-read` |
| `playbook_approve` | handlers/playbook | mutating (appends playbooks.json) | no | L2 | `experience-layer` |
| `playbook_reject` | handlers/playbook | mutating (deletes proposal) | no | L2 | `experience-layer` |
| `recall` | handlers/recall | read-only (similarity over story scan) | no | L0 | `story-read` (or `experience-layer-read`) |

None are gate-consumed, so **none get a `gateConsumer` field**. Category strings are non-gating prose; pick a consistent existing-style value (the contract only validates name/level/owner/rationale presence + that level/allowedPhases line up — see notes below). Confirm whether the contract has any category enum; if it does, mirror a sibling.

---

## CHK-001: Register the 7 missing Experience-Layer/recall commands in the process-fact registry

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: `packages/main/src/core/process-fact-levels.ts` (add 7 entries to the `PROCESS_FACT_LEVELS` array, ~after line 90, mirroring the exact `{ name, level, category, owner, rationale }` shape; NO `gateConsumer` for any of the 7)
- Do NOT modify: `packages/main/src/core/process-fact-registry.ts` line 871 (spread combiner). Only touch process-fact-registry.ts if a derivation helper (`commandFactKind`/`commandFactSemantics`) genuinely needs the new names — it should NOT (they fall through to kind=`command`, semantics=`['command']` for non-L4). Confirm by reading lines 550-564.
- Read-only (classify): `packages/main/src/handlers/signature-registry.ts`, `packages/main/src/handlers/playbook.ts`, `packages/main/src/handlers/recall.ts`; cross-check `packages/main/src/core/command-policy.ts` (owner/allowedPhases) and `packages/main/src/core/config.ts` (DEFAULT_PHASE_TOOLS '*').

**Verify**:
- `npm --prefix packages/main run build` exits 0 (tsc passes — entries match `ProcessFactLevelEntry`).
- `node scripts/verify-process-fact-contract.mjs` (i.e. `npm run test:process-fact-contract`) no longer prints `MAIN_TOOLS command(s) missing from registry: ...` nor `MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=<any of the 7>`.
- Registry dump (top of the contract output) lists all 7 with correct level: 3 at L0, 4 at L2.

**DoneWhen**:
- All 7 commands present in PROCESS_FACT_LEVELS with handler-accurate level/category/owner/rationale.
- The 3 read-only commands are L0; the 4 mutating commands are L2; none has a `gateConsumer`.
- `git diff` for this item touches ONLY process-fact-levels.ts (no handler, no cli-engine.ts).

---

## CHK-002: Reconcile DEFAULT_PHASE_TOOLS so the drift clears, and confirm the whole contract is GREEN

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify (ONLY IF NEEDED): `packages/main/src/core/config.ts` (DEFAULT_PHASE_TOOLS). Expectation: NO edit needed — the 3 patterns are already in the global `'*'` array and the subset invariant already holds; the drift was caused entirely by the missing registry entries (fixed in CHK-001). The implementer MUST first build + run the contract after CHK-001; only edit config.ts if drift lines persist, and only in the safe subset direction (DEFAULT_PHASE_TOOLS subset of command-policy allowedPhases — never widen a phase beyond policy).

**Verify**:
- `node scripts/verify-process-fact-contract.mjs` EXITS 0 end-to-end: no `Process fact contract failed:` block, no `DEFAULT_PHASE_TOOLS phase allowlist drift` lines (all 21 gone), no missing-command lines.
- `npx tsc -p packages/main` (or `npm --prefix packages/main run build`) exits 0.
- Capture the green contract output verbatim (this is the verification of record — `lattice validate` does NOT run this guard).

**DoneWhen**:
- `npm run test:process-fact-contract` exits 0 with zero failure lines.
- DEFAULT_PHASE_TOOLS still a subset of command-policy allowedPhases (safe direction preserved).
- The fix is honest (entries registered), not a contract relaxation.

---

## Out of scope (hard fences)
- Do NOT wire the contract guard into the `lattice validate` battery (B-99b6 owns that).
- Do NOT touch any gitRoot code (B-6666 owns that).
- Do NOT change any of the 7 commands' behavior / handlers / cli-engine.ts wiring.
