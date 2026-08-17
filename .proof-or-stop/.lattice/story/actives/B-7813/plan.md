# Plan: B-7813 Review-budget stall adjudication

Extend the EXISTING advisory stall detector (`core/review-convergence.ts`, consumed advisory-only at `handlers/transition-effects.ts:~284-289`) into a BLOCKING adjudication at the REVIEW round-mint site. Do not build a second detector. Keep the block decision a pure function; I/O in the handler/gate. Coexist independently with the advance-counting `core/convergence-breaker.ts` (no double-count, don't break `story_resume --ack`).

**DEV ordering:** CHK-001 → CHK-002 → CHK-003 are one cohesive subsystem and all touch `review-convergence.ts` or depend on the gate — dispatch them **SERIALLY** (fresh implementer each, but pass the prior commit + current file state; NO parallel — shared files). CHK-004 depends on all three.

**Accuracy note for all workers (INIT-003):** B-bf52 reached phase=DONE with CHK-003 done; only its AB-003 acceptance binding was WITHDRAWN as undeliverable (F-058/F-059) — NOT the whole story undelivered. The "declare unreachable" action (CHK-002) reuses B-1909 withdrawn-disposition semantics.

---

## CHK-001: Harden the stall detector from advisory to a blocking adjudication at the review-round mint site

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/review-convergence.ts (add a PURE `evaluateStallAdjudication(inputs)` returning block/allow from the EXISTING trend signal + whether a current-round resolution exists), packages/main/src/handlers/transition-effects.ts (~284-289: change the advisory append into a BLOCK when the gate says block), packages/main/src/core/machine.ts (wire the block into the REVIEW re-entry transition guard)
- Test: packages/main/src/tasks/review-budget-stall-adjudication-smoke.ts (created in CHK-004)

**Verify**:
- A synthesized stall (≥STALL_MIN_ROUNDS, non-improving trailing window, no resolution) makes the REVIEW re-entry mint REFUSE with a structured prompt.
- A converging trend (trailing-clean or strictly-decreasing) at/beyond STALL_MIN_ROUNDS is NOT blocked.

**DoneWhen**:
- The stall gate BLOCKS minting another ordinary review round when stalled without a current-round resolution, carrying a structured prompt that names the allowed §3 actions.
- Reuses the existing `assessReviewConvergence` trend logic (no raw round ceiling here — the ceiling is CHK-003); a converging story is never falsely blocked.
- The block decision is pure (observable state only); the handler does the I/O and the machine guard consumes it. The advisory-only try/catch no longer silently swallows the signal at the mint site.

---

## CHK-002: Add the structured resolution actions that clear the block (incl. declare-checklist-item-unreachable)

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/core/stall-adjudication.ts (pure: validate + sign the resolution record, bind it to the current stalled round), packages/main/src/handlers/stall-adjudication.ts (I/O: persist stall-adjudication.json under the story dir)
- Modify: packages/main/src/cli/command-catalog.ts (register `stall_resolution_set` with an action enum: authorize_continuation | replan | escalate_root_cause | resolve_findings | declare_unreachable), packages/main/src/handlers/checklist.ts (declare_unreachable marks the item withdrawn via B-1909 withdrawn-disposition)
- Test: the CHK-004 smoke

**Verify**:
- Recording any one action (bound to the current stalled round) clears the block and the next round mints.
- `declare_unreachable` marks the checklist item withdrawn and closes the loop (no new round); an empty/previous-round/unsigned resolution does NOT clear the current block.

**DoneWhen**:
- One CLI command records one of the five actions as a signed, current-round-bound `stall-adjudication.json`; the CHK-001 gate consumes it to allow exactly the next round (or, for declare_unreachable, to close the loop).
- `declare_unreachable` reuses B-1909 withdrawn-disposition semantics (marks the item + binding withdrawn, reconciles plan/claims per F-059).
- Handler + gate both re-validate the resolution (reason min length, current-round binding, signature) — a stale/empty resolution is refused at every consumption point.

---

## CHK-003: Add a hard ceiling / privileged override and prevent double-counting with the convergence-breaker and story_resume --ack

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/review-convergence.ts (add the hard ceiling on total ordinary rounds + a privileged-override path in the pure gate), packages/main/src/core/convergence-breaker.ts (only if needed to assert independence — do NOT change its advance-count semantics or maxAdvance=20)
- Test: the CHK-004 smoke

**Verify**:
- A hard ceiling caps total ordinary rounds even with resolutions recorded, unless a privileged override with its own reason is recorded.
- The stall adjudication (review-round keyed) and the convergence-breaker (advance keyed) each fire only on their own trigger; `story_resume --ack` clears the breaker but NOT the stall block, and a stall resolution does not touch the breaker advance baseline.

**DoneWhen**:
- Beyond the ceiling, ordinary rounds are refused even with resolutions, and only a recorded privileged override (with reason) proceeds — so the adjudication cannot be ignored indefinitely.
- The two brakes are proven independent (separate counters, separate clear paths); no double-count and no regression to `story_resume --ack` recovery.

---

## CHK-004: RED-first smoke reproducing the stall refusal + the F-058 unreachable-item scenario; register in validate

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Create: packages/main/src/tasks/review-budget-stall-adjudication-smoke.ts
- Modify: lattice.config.json (validate.commands), package.json + packages/main/package.json (scripts)
- Test: this IS the test

**Verify**:
- `node packages/main/dist/tasks/review-budget-stall-adjudication-smoke.js` prints `review-budget-stall-adjudication-smoke: PASS`, exit 0.
- `node bin/lattice.js validate --story=B-7813 --json` includes it and is green.

**DoneWhen**:
- RED-first: reverting the block (CHK-001), the resolution-clear (CHK-002), the unreachable-close, or the breaker coexistence (CHK-003) each makes the smoke fail.
- Drives the REAL gate/handler entry points (not reimplemented logic): (1) a ≥threshold non-improving stall is minted before and refused after the fix; (2) the F-058 unreachable-item scenario — declaring it unreachable closes the loop; (3) the convergence-breaker + story_resume --ack still work and are not double-counted.
- Registered in lattice.config.json validate.commands + both package.json.
