# Plan: B-ec67 — Tool-executed selector-bearing evidence receipts (Step 2 / M1)

Design (decision.json Option A): pin `verification:{command,selector}` on the intent (added on first evidence write, immutable), and route BOTH `verification_evidence_add` and `verification_evidence_batch_add` through ONE shared enforce-and-stamp helper that executes the pinned command, refuses on mismatch, and stamps a tool-owned receipt. The coverage gate (`buildVerificationCoverage`) demotes `manual|docs` so they never satisfy an executable intent. Legacy prose-only evidence is grandfathered.

Shared primitives to build first (used by several items):
- `types.ts`: `VerificationIntentItem.verification?: { command: string; selector: string }`; `VerificationEvidence.receipt?: { exitCode: number; outputDigest: string; outputTail: string; selectorMatched: boolean; executedAt: string }`; a `mechanical: boolean` (or `attestationOnly`) marker distinguishing executed receipts from attestation.
- `handlers/checklist.ts`: a single `enforceAndStampEvidence(item, intentRef, kind, callerCommand, callerSelector, callerResult)` helper that: resolves the intent (refuse if intentRef doesn't map to an intent on the item); for executable types pins-or-matches (command,selector); runs the command via the executor; refuses on the 4 conditions; returns the evidence with a receipt + result derived from the actual exit. BOTH add and batch_add call it.
- `verification.ts`: coverage treats an executable intent (logic|cli|browser) as covered ONLY by an executed receipt (result from receipt); a manual/docs attestation is non-mechanical and cannot cover an executable intent.
- Executor: reuse `runValidationCommand` (validation-executor.ts) for a single command; parse the pinned command into executable+argv; reuse the lattice-dispatch allowlist; apply the default timeout.

## CHK-001: Add verification:{command,selector} to the intent and pin it immutably on first evidence write
**Owner**: lattice-implementer · **DependsOn**: none
**Files**: Modify packages/main/src/core/types.ts, packages/main/src/handlers/checklist.ts · Test the smoke
**Verify**: first evidence write for an intentRef pins verification onto item.verificationIntent[lane][idx]; a second write changing command/selector is refused; a legacy intent with no pin loads.
**DoneWhen**: verification field exists and round-trips; the ADD-only exception to the intent freeze permits setting when absent but refuses change; second-write-same-command re-executes.

## CHK-002: Execute the pinned command and refuse on mismatch, through ONE shared helper for both add and batch_add
**Owner**: lattice-implementer · **DependsOn**: CHK-001
**Files**: Modify packages/main/src/handlers/checklist.ts (verification_evidence_add:888 + verification_evidence_batch_add:947 both call enforceAndStampEvidence), packages/main/src/core/validation-executor.ts (expose single-command run if needed) · Test the smoke
**Verify**: executable intent runs the pinned command; refuse on (a) exit!=0 but pass claimed, (b) selector absent, (c) intentRef not resolving, (d) pinned command != command to run; the SAME refusals fire through batch_add.
**DoneWhen**: both entry points routed through the shared helper (no independent enforcement); receipt-command-mismatch convention reused; a selector-absent row is refused via BOTH paths (smoke asserts).

## CHK-003: Stamp a tool-owned receipt and derive result from the actual exit
**Owner**: lattice-implementer · **DependsOn**: CHK-002
**Files**: Modify packages/main/src/handlers/checklist.ts, packages/main/src/core/types.ts · Test the smoke
**Verify**: stored evidence has receipt {exitCode, outputDigest=sha256(output), outputTail}; result comes from the receipt not the caller; a caller result:pass contradicting a nonzero exit does not survive.
**DoneWhen**: receipt stored on evidence; reuse sha256+outputTail (done-required-validation.ts:531/894); result is receipt-derived.

## CHK-004: Demote manual|docs so they never satisfy an executable intent's coverage
**Owner**: lattice-implementer · **DependsOn**: CHK-001
**Files**: Modify packages/main/src/core/verification.ts (buildVerificationCoverage), packages/main/src/handlers/checklist.ts · Test the smoke
**Verify**: manual|docs stored as attestation, marked non-mechanical, no execution; coverage does NOT let a manual attestation cover a logic|cli|browser intent; recording an executable intent as type:manual cannot bypass execution at the gate.
**DoneWhen**: the demotion lives in the coverage function (the gate), not only the handler; smoke asserts a manual attestation fails to cover an executable intent.

## CHK-005: Grandfather legacy prose-only evidence + explicit auditable escape; enforce at Zod+handler+gate
**Owner**: lattice-implementer · **DependsOn**: CHK-002
**Files**: Modify packages/main/src/handlers/checklist.ts, packages/main/src/cli/command-catalog.ts · Test the smoke
**Verify**: legacy evidence without a pin remains valid/readable (no hard break); the escape/grandfather path is attributable + gate-visible; the internal fn-call path bypassing Zod is still enforced.
**DoneWhen**: new-write enforcement applies only to executable intents; legacy rows load; per CLAUDE.md handler convention the constraint is re-validated at Zod + handler entry + consuming gate, and the Zod-bypass path is tested.

## CHK-006: RED-first smoke covering both entry points, registered in validate
**Owner**: lattice-implementer · **DependsOn**: CHK-001..CHK-005
**Files**: Create packages/main/src/tasks/tool-executed-evidence-receipt-smoke.ts · Modify lattice.config.json (validate.commands) + package.json (test scripts) · Test itself
**Verify**: RED — selector-absent refused after fix (accepted before); positive — selector present + exit 0 through add AND batch_add writes a receipt; all refusals (exit!=0, selector-absent, intentRef-unresolved, command-mismatch, pin-change) through BOTH entry points; manual attestation does not cover an executable intent; legacy row loads.
**DoneWhen**: `node bin/lattice.js validate` runs the smoke green; registered in lattice.config.json validate.commands + package.json; prints `tool-executed-evidence-receipt-smoke: PASS`.
