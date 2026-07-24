# Plan: B-1909 Record undeliverable checklist items and acceptance bindings as withdrawn

Design (from decision.json, Option B): the **scope-shrinkage decision writer is the SOLE authorized applier** of both withdrawal dispositions. It (1) records the decision with `decisionId` + `withdrawnChecklistItemRefs` + `withdrawnAcceptanceBindingRefs` + `evidenceRefs`, (2) flips the named checklist items to a stored `withdrawn` status carrying `decisionRef`, and (3) appends an append-only binding-disposition record beside the frozen `acceptanceBindings`. `checklist_update` and `proofstory_contract_set` both **refuse** withdrawn/disposition writes and redirect here. All writes happen under one lock after validating every ref.

Shared primitives introduced (used by several items — build first):
- `ChecklistStatus` gains `'withdrawn'`; `ChecklistItem.decisionRef?: string` (core/types.ts).
- `ScopeShrinkageDecisionData` gains optional `decisionId`, `withdrawnChecklistItemRefs`, `withdrawnAcceptanceBindingRefs`, `evidenceRefs` (core/types.ts).
- `ProofStoryBindingDisposition` `{ bindingId, disposition:'withdrawn', decisionRef, withdrawnAt }` and `ProofStoryContractData.bindingDispositions?: ProofStoryBindingDisposition[]` (core/types.ts).
- `core/proofstory.ts` helpers: `withdrawnChecklistItemIdsFrom(decision)`, `withdrawnBindingIdsFrom(decision)`, `effectiveAcceptanceBindings(contract, decision)`, and disposition predicates `isDeliveredStatus(status)` / `isTerminalStatus(status)`.

## CHK-001: Add withdrawn as a terminal checklist disposition through schema, CLI validation and persistence

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/types.ts (ChecklistStatus union + ChecklistItem.decisionRef)
- Modify: packages/main/src/cli/command-catalog.ts (status z.enum add 'withdrawn'; document that direct withdrawn is refused)
- Modify: packages/main/src/handlers/checklist.ts (checklist_update status union type; REFUSE direct status=withdrawn with an error pointing to scope_shrinkage_decision_set; decide the dead --success flag — remove from the documented item contract or persist it; keep the process-event behavior intact)
- Test: covered by CHK-007 smoke + any inline logic test the implementer adds

**Verify**:
- `node bin/lattice.js checklist_update '{"storyId":<tmp>,"itemId":"CHK-001","status":"withdrawn"}'` errors with a message naming scope_shrinkage_decision_set
- tsc clean (withdrawn is a valid ChecklistStatus everywhere)

**DoneWhen**:
- `ChecklistStatus` includes `'withdrawn'`; `ChecklistItem.decisionRef` exists and round-trips through read/write
- Direct `checklist_update --status=withdrawn` is refused with a redirect message
- The `--success` flag is no longer documented as a persisting field unless it is actually persisted onto the item; whichever is chosen is stated in the commit message
- A legacy item without withdrawn/decisionRef loads unchanged

## CHK-002: Make every done consumer treat withdrawn as terminal but not delivered

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/machine.ts (checklistAllDoneGuard:355 — advance when every item is done OR withdrawn; verification-evidence check must not require a withdrawn item's intents)
- Modify: packages/main/src/core/artifact-contract.ts (:133 every-item-done → done-or-withdrawn as terminal)
- Modify: packages/main/src/handlers/checklist.ts (:82 counts — add a withdrawn count; delivered/done count excludes withdrawn)
- Modify: packages/main/src/handlers/story-query.ts (:568), handlers/hints.ts (:70), handlers/session.ts (:435), core/milestone-status.ts (:456,:560)
- Modify: rendering so a withdrawn item prints `WITHDRAWN` (never `DONE`) in checklist_get / story_get / session_brief
- Test: CHK-007 smoke asserts gate advance + count exclusion + WITHDRAWN rendering

**Verify**:
- A story whose only non-done item is withdrawn passes `checklistAllDoneGuard`
- `checklist_get` shows the withdrawn item labeled WITHDRAWN and NOT in the done/delivered tally
- `rg -n "status === 'done'" packages/main/src/core packages/main/src/handlers` — every hit reviewed; terminal-vs-delivered classified

**DoneWhen**:
- Introduce and use shared `isTerminalStatus` (done|withdrawn) and `isDeliveredStatus` (done only) helpers rather than ad hoc comparisons where a site's meaning is ambiguous
- Withdrawn never increments any delivered/completed/success tally
- Every one of the enumerated sites is handled; none renders withdrawn as done

## CHK-003: Extend the scope-shrinkage decision into the single authorizing record both layers cite

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/types.ts (ScopeShrinkageDecisionData new optional fields)
- Modify: packages/main/src/core/proofstory.ts (BuildScopeShrinkageDecisionArgs + buildScopeShrinkageDecision:1285-1310 — accept and persist decisionId/withdrawnChecklistItemRefs/withdrawnAcceptanceBindingRefs/evidenceRefs; generate a stable decisionId when absent; when decision=confirmed require at least one of the three removal sets non-empty)
- Modify: packages/main/src/handlers/proofstory.ts (scope_shrinkage_decision_set:917 arg passthrough) + cli/command-catalog.ts (schema for new args)
- Test: legacy-decision compatibility logic test + CHK-007

**Verify**:
- `scope_shrinkage_decision_set` with the new refs persists them; `scope_shrinkage_decision_get --json` echoes them
- Loading B-bf52's legacy decision.json (no new fields) does not throw

**DoneWhen**:
- New fields optional with safe empty defaults; `createdAt` preserved on update
- Confirmed decision with all three removal sets empty is rejected
- Stable `decisionId` present on write (generated if caller omitted)

## CHK-004: Add an append-only acceptance-binding withdrawal readable from DEV and REVIEW without returning to PLAN

**Owner**: lattice-implementer
**DependsOn**: CHK-003
**Files**:
- Modify: packages/main/src/core/types.ts (ProofStoryBindingDisposition + ProofStoryContractData.bindingDispositions)
- Modify: packages/main/src/core/proofstory.ts (effectiveAcceptanceBindings helper; append-only apply that preserves the original binding object)
- Modify: packages/main/src/handlers/proofstory.ts (the scope_shrinkage_decision_set handler applies the binding disposition into proofstory.json under the same write path; proofstory_contract_get renders original + disposition; confirm proofstory_contract_set stays PLAN-frozen and refuses disposition writes)
- Test: DEV+REVIEW invocation smoke in CHK-007

**Verify**:
- After the decision writer runs in DEV (and in REVIEW), `proofstory_contract_get` shows the binding with disposition withdrawn while the original binding object is unchanged
- `proofstory_contract_set` run outside PLAN still refused

**DoneWhen**:
- bindingDispositions is append-only; original `acceptanceBindings[]` never mutated or deleted
- effectiveAcceptanceBindings excludes withdrawn bindings
- Works from DEV and REVIEW (no PLAN return)

## CHK-005: Validate withdrawal authority and cross-layer consistency in both directions

**Owner**: lattice-implementer
**DependsOn**: CHK-003, CHK-004
**Files**:
- Modify: packages/main/src/core/proofstory.ts + handlers/proofstory.ts (the applier validates: every withdrawnChecklistItemRef names a real checklist item; every withdrawnAcceptanceBindingRef names a real binding; decision is confirmed + userConfirmed; the checklist item's stored decisionRef and the binding disposition's decisionRef both equal this decision's decisionId)
- Modify: handlers/checklist.ts (refuse status=withdrawn without a decisionRef pointing at a confirmed decision that cites the item — belt-and-suspenders even though the sole path is the decision writer)
- Enforce at Zod + handler entry + consuming gate per CLAUDE.md handler convention; test the internal-call path that bypasses Zod
- Test: negative-path logic tests + CHK-007

**Verify**:
- Decision not citing the item/binding → refused
- Two different decision ids across the two layers for one shrinkage → refused
- Internal fn call with a hand-built decision lacking userConfirmed → refused at handler and gate
**DoneWhen**:
- All refusals hold on the Zod path AND the internal-call path
- A DEV agent cannot produce a withdrawal without the operator's confirmed decision

## CHK-006: Guard against empty-scope success when core bindings are withdrawn

**Owner**: lattice-implementer
**DependsOn**: CHK-004
**Files**:
- Modify: packages/main/src/core/proofstory.ts (DONE intent-equivalence ~1514 and review-completeness ~1858 both drive their required set from effectiveAcceptanceBindings; add a blocking `empty_scope_after_withdrawal` gap when the original contract had bindings but the effective set is empty, requiring explicit re-approval)
- Test: subset-withdraw proceeds; full-withdraw blocks — logic tests + CHK-007

**Verify**:
- Withdraw a proper subset → DONE path proceeds
- Withdraw every binding → blocking gap `empty_scope_after_withdrawal` requiring explicit re-approval

**DoneWhen**:
- The floor reads the effective (non-withdrawn) set, not original bindings
- Both DONE consumers honor the floor identically

## CHK-007: Add a smoke covering both directions of the recorded acceptance

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-005, CHK-006
**Files**:
- Create: packages/main/src/tasks/withdrawn-disposition-smoke.ts
- Modify: packages/main/src/validate.ts (or the validate.commands registry the other proofstory smokes use) to register it
- Modify: package.json test script only if the sibling smokes require an entry (scope-acknowledge if so)

**Verify**:
- `node bin/lattice.js validate` runs the new smoke green
- Positive + both negative directions asserted (see verificationIntent CHK-007)

**DoneWhen**:
- Positive: after scope_shrinkage_decision_set removing CHK-nnn, checklist_get and proofstory_contract_get both report withdrawn, from DEV and REVIEW, no PLAN return
- Negative: done still delivered; withdrawn excluded from counts; withdrawn without valid decisionRef refused; decision not citing item refused; mismatched ids refused; original binding survives; all-bindings-withdrawn does not pass
- Registered so `lattice validate` executes it
